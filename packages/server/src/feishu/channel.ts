import { WSClient, EventDispatcher, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { FeishuInboxJob } from "@lot-agent/core";
import type { AgentService } from "../services/agent-service.js";
import { FeishuService, hash } from "./service.js";
import { FeishuError } from "./client.js";
import { isMediaGeneration, MEDIA_UNAVAILABLE, parseSendCommand } from "./policy.js";

export const FEISHU_HELP = "发送：/send 联系人别名或ou_用户ID 消息原文\n回复：/reply om_消息ID 回复原文\n取消：/cancel\n联系人可在 Lot Agent → 账号 → 飞书接入 中保存。\n也可直接发送文字任务。图片、视频生成：后续支持，持续开发中...";

class TextRunError extends Error {
  constructor(readonly partial: string) { super("Feishu text run failed"); }
}
export class FeishuChannel {
  private sockets = new Map<string, { client: WSClient; fingerprint: string }>();
  private timer?: ReturnType<typeof setInterval>;
  private syncTimer?: ReturnType<typeof setInterval>;
  private syncing: Promise<void> | null = null;
  private pumping: Promise<void> | null = null;
  private running = new Set<Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private stopping = false;
  private longConnectionEnabled = false;
  constructor(private readonly feishu: FeishuService, private readonly agent: AgentService, private readonly concurrency = 8) {}

  async receive(data: any, appId = this.feishu.client.config.appId) {
    const m = data?.message, sender = data?.sender;
    if (m?.chat_type !== "p2p" || sender?.sender_type !== "user" || m?.message_type !== "text"
      || typeof m.message_id !== "string" || typeof m.chat_id !== "string"
      || typeof sender.tenant_key !== "string" || typeof sender.sender_id?.open_id !== "string") return;
    const connection = await this.feishu.repository.findSender(appId,sender.tenant_key,sender.sender_id.open_id);
    if (!connection) return;
    let text: string;
    try { text = JSON.parse(m.content).text; } catch { return; }
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 12_000) return;
    const accepted = await this.feishu.repository.enqueue({ message_id:m.message_id,chat_id:m.chat_id,
      user_id:connection.user_id,revision:connection.revision,text });
    if (accepted && ["/cancel","取消任务"].includes(text.trim())) this.abortUser(connection.user_id);
  }

  start(longConnection = true) {
    this.longConnectionEnabled = longConnection;
    const tick = () => {
      if (this.pumping || this.stopping) return;
      this.pumping = this.pump().catch(() => console.warn("[feishu] Task processing unavailable"))
        .finally(() => { this.pumping = null; });
    };
    this.timer = setInterval(tick,1000); this.timer.unref();
    tick();
    if (longConnection) {
      const sync = () => {
        if (this.syncing || this.stopping) return;
        this.syncing = this.syncConnections().catch(() => console.warn("[feishu] Message connection sync unavailable"))
          .finally(() => { this.syncing = null; });
      };
      this.syncTimer = setInterval(sync,5000); this.syncTimer.unref(); sync();
    }
  }
  private async syncConnections() {
    const connections = await this.feishu.repository.connections();
    if (this.stopping) return;
    const apps = new Map<string, { appId:string; appSecret:string }>();
    for (const c of connections) {
      try { apps.set(c.app_id,this.feishu.connectionClient(c).config); }
      catch { console.warn("[feishu] A binding needs reauthorization"); }
    }
    for (const [appId,socket] of this.sockets) {
      const app = apps.get(appId);
      if (!app || hash(app.appSecret) !== socket.fingerprint) { socket.client.close({ force:true }); this.sockets.delete(appId); }
    }
    for (const [appId,app] of apps) {
      if (this.sockets.has(appId)) continue;
      const noop = () => {};
      const logger = { trace:noop,debug:noop,info:noop,warn:noop,error:noop };
      const client = new WSClient({ appId,appSecret:app.appSecret,logger,loggerLevel:LoggerLevel.error,
        onReady:() => console.info("[feishu] Message connection ready"),
        onError:() => console.warn("[feishu] Message connection unavailable") });
      this.sockets.set(appId,{ client,fingerprint:hash(app.appSecret) });
      void client.start({ eventDispatcher:new EventDispatcher({ logger }).register({
        "im.message.receive_v1":data => this.receive(data,appId),
      }) }).catch(() => {
        client.close({ force:true });
        if (this.sockets.get(appId)?.client === client) this.sockets.delete(appId);
        console.warn("[feishu] Message connection failed");
      });
    }
  }
  private async pump() {
    while (!this.stopping && this.running.size < this.concurrency) {
      const job = await this.feishu.repository.claim();
      if (!job) break;
      const task = this.consume(job).catch(() => console.warn("[feishu] Task processing unavailable"))
        .finally(() => this.running.delete(task));
      this.running.add(task);
    }
  }
  abortUser(userId: string) { this.controllers.get(userId)?.abort(); }
  connectionStatus(appId?: string) {
    if (!this.longConnectionEnabled || this.stopping) return "disabled";
    if (!appId) return "idle";
    return this.sockets.get(appId)?.client.getConnectionStatus().state ?? "connecting";
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    for (const socket of this.sockets.values()) socket.client.close({ force:true });
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([this.pumping,this.syncing]);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.running]);
  }
  private async consume(job: FeishuInboxJob) {
    const controller = new AbortController();
    this.controllers.set(job.user_id,controller);
    if (this.stopping) controller.abort();
    const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(180_000)]);
    let checking = false;
    const monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.feishu.repository.active(job).then(active => { if (!active) controller.abort(); })
        .catch(() => controller.abort()).finally(() => { checking = false; });
    },2000);
    monitor.unref();
    try {
      let result = "任务已取消。", outcome = "cancelled";
      const active = await this.feishu.repository.active(job);
      if (active && !signal.aborted) {
        try { result = await this.execute(job,signal); outcome = "completed"; }
        catch (error) {
          outcome = signal.aborted ? "cancelled" : "failed";
          // An aborted HTTP write may still have reached Feishu. Preserve its uncertainty.
          result = error instanceof FeishuError ? error.message : signal.aborted ? "任务已停止。" : "任务未完成，请在 Lot Agent 中查看执行记录。";
          if (error instanceof TextRunError && error.partial) result = `${error.partial}\n\n${result}`;
        }
      }
      const stillActive = await this.feishu.repository.active(job);
      if (!stillActive) {
        outcome = "cancelled";
        result = result === "任务已取消。" ? result : `${result}\n\n任务已取消；已发出的消息无法撤回。`;
      }
      await this.feishu.repository.recordResult(job,result,outcome);
      if (stillActive && !this.stopping) {
        try { await this.feishu.botReply(job,result.slice(0,3000),controller.signal); }
        catch { outcome = "reply_unknown"; }
      }
      await this.feishu.repository.finish(job.message_id,outcome);
    } finally {
      clearInterval(monitor); this.controllers.delete(job.user_id);
    }
  }

  async execute(job: FeishuInboxJob, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const command = parseSendCommand(job.text);
    if (command) {
      const sent = await this.feishu.send(job.user_id,{ ...command,requestId:hash(`inbound:${job.message_id}`) },job.revision,signal);
      return `已以你本人身份${command.reply ? "回复" : "发送"}。消息 ID：${sent.messageId}`;
    }
    if (isMediaGeneration(job.text)) return MEDIA_UNAVAILABLE;
    if (["/help","帮助"].includes(job.text.trim())) return FEISHU_HELP;
    if (["/cancel","取消任务"].includes(job.text.trim())) return "已取消当前待处理和运行中的飞书任务。";
    if (/^\/(send|reply|发给|回复)\b/u.test(job.text)) return FEISHU_HELP;
    if (!job.conversation_id || !job.user_message_id || !job.result_message_id || !job.run_id) throw new Error("Feishu task has no transcript");
    let output = "";
    try {
      for await (const event of this.agent.streamAgentResponse(job.conversation_id,job.text,"general",job.user_id,[],signal,{
        channel:"feishu",runId:job.run_id,feishuTurn:{ userMessageId:job.user_message_id,resultMessageId:job.result_message_id },
      })) {
        if (event.type === "text") output += event.content;
        if (event.type === "error") throw new TextRunError(output);
        if (event.type === "done" && event.status && event.status !== "completed") throw new TextRunError(output);
      }
    } catch { throw new TextRunError(output); }
    return output.trim() || "任务结束，未产生文字结果。";
  }
}
