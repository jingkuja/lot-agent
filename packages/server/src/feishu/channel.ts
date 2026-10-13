import { WSClient, EventDispatcher, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { FeishuInboxJob, RunStatus } from "@lot-agent/core";
import type { PptDeck } from "@lot-agent/core/presentation";
import type { AgentService } from "../services/agent-service.js";
import { FeishuService, hash } from "./service.js";
import { FeishuError } from "./client.js";
import { parseSendCommand } from "./policy.js";

export const FEISHU_HELP = "发送：/send 联系人姓名或ou_用户ID 消息原文\n回复：/reply om_消息ID 回复原文\n取消：/cancel\n可以直接说：查好后发给我自己，或发消息给联系人。按姓名自动查询飞书官方通讯录，同名时会请你选择。\n支持与 Web 通用助手相同的工具，包括文档、PPT、联网查询等。";

class TextRunError extends Error {
  constructor(readonly partial: string, readonly status: RunStatus, reason: string) { super(reason); }
}

function runFailureReason(status: RunStatus): string {
  return ({ unknown_outcome: "操作结果尚未确认，请先核实，勿重复发送。", timed_out: "任务执行超时。",
    cancelled: "任务已停止。", budget_exhausted: "任务达到执行预算上限，尚未完成。",
    stalled: "任务因连续重复调用没有进展而停止。", empty_response: "模型未返回有效结果，任务尚未完成。",
  } as Partial<Record<RunStatus, string>>)[status] ?? "任务执行失败。";
}

// Only forward controlled integration errors, never arbitrary upstream bodies or credentials.
function feishuFailure(output: string): string | undefined {
  const codeMatch = output.split("\n", 1)[0].match(/（错误码：(-?\d+)）$/);
  const code = codeMatch ? Number(codeMatch[1]) : undefined;
  const botAppId = output.match(/\n收件人首次开启机器人单聊的入口：https:\/\/applink\.feishu\.cn\/client\/bot\/open\?appId=(cli_[a-zA-Z0-9_-]+)\n/)?.[1];
  for (const kind of ["auth", "permission", "rejected", "unknown", "contact_permission", "search_failed", "bot_unavailable", "bot_auth"] as const) {
    const message = new FeishuError(kind, code, botAppId).message;
    if (output === message) return message;
  }
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

  async receive(data: any, appId: string) {
    if (!appId) return;
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
    const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(1_800_000)]);
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
        try {
          let awaitingInput = false;
          result = await this.execute(job,signal,() => { awaitingInput = true; });
          outcome = awaitingInput ? "awaiting_input" : "completed";
        }
        catch (error) {
          outcome = error instanceof TextRunError && error.status === "unknown_outcome" ? "unknown" : signal.aborted ? "cancelled" : "failed";
          // An aborted HTTP write may still have reached Feishu. Preserve its uncertainty.
          result = error instanceof FeishuError ? error.message : error instanceof TextRunError ? error.message : signal.aborted ? "任务已停止。" : "任务执行失败。";
          if (error instanceof TextRunError && error.partial) result += `\n\n${error.partial}`;
          if (job.run_id) result += `\n\n运行 ID：${job.run_id}；详细记录可在 Lot Agent 飞书会话中查看。`;
        }
      }
      const stillActive = await this.feishu.repository.active(job);
      if (!stillActive) {
        outcome = "cancelled";
        result = result === "任务已取消。" ? result : `${result}\n\n任务已取消；已发出的消息无法撤回。`;
      }
      await this.feishu.repository.recordResult(job,result,outcome);
      if (stillActive && !this.stopping) {
        try { await this.feishu.botReply(job,result.length > 3000 ? `${result.slice(0,2900)}\n\n内容较长，完整结果请在 Lot Agent 飞书会话中查看。` : result,controller.signal); }
        catch { outcome = "reply_unknown"; }
      }
      await this.feishu.repository.finish(job.message_id,outcome);
    } finally {
      clearInterval(monitor); this.controllers.delete(job.user_id);
    }
  }

  async execute(job: FeishuInboxJob, signal: AbortSignal, onAwaitingInput?: () => void): Promise<string> {
    signal.throwIfAborted();
    const command = parseSendCommand(job.text);
    if (command && (command.reply || /^ou_[\w-]+$/.test(command.recipient) || ["self", "me", "myself", "我", "自己", "我自己", "本人"].includes(command.recipient.toLowerCase()))) {
      const sent = await this.feishu.send(job.user_id,{ ...command,requestId:hash(`inbound:${job.message_id}`) },job.revision,signal);
      return `已${sent.identity === "bot" ? "通过机器人向你" : "以你本人身份"}${command.reply ? "回复" : "发送"}。消息 ID：${sent.messageId}`;
    }
    if (["/help","帮助"].includes(job.text.trim())) return FEISHU_HELP;
    if (["/cancel","取消任务"].includes(job.text.trim())) return "已取消当前待处理和运行中的飞书任务。";
    if (!command && /^\/(send|reply|发给|回复)\b/u.test(job.text)) return FEISHU_HELP;
    if (!job.conversation_id || !job.user_message_id || !job.result_message_id || !job.run_id) throw new Error("Feishu task has no transcript");
    let output = "";
    const calls = new Map<string, { name: string; input: unknown }>();
    const artifacts = new Set<string>();
    let interaction = "";
    let status: RunStatus | undefined;
    let sawError = false;
    const messagingFailures = new Map<string, string>();
    const sendReceipts = new Set<string>();
    const partial = () => [...sendReceipts, ...artifacts, interaction, output.trim()].filter(Boolean).join("\n\n");
    try {
      for await (const event of this.agent.streamAgentResponse(job.conversation_id,job.text,"general",job.user_id,[],signal,{
        channel:"feishu",runId:job.run_id,feishuTurn:{ userMessageId:job.user_message_id,resultMessageId:job.result_message_id,revision:job.revision },
      })) {
        if (event.type === "text") output += event.content;
        if (event.type === "tool_call") calls.set(event.id, { name: event.name, input: event.input });
        if (event.type === "tool_result" && ["feishu_send_message", "feishu_contacts"].includes(event.name)) {
          if (event.isError) {
            // Keep the first concrete rejection, including its API code, across duplicate calls.
            const reason = feishuFailure(event.output);
            if (reason && !messagingFailures.has(event.name)) messagingFailures.set(event.name, reason);
            if (event.errorKind === "unknown_outcome") status = "unknown_outcome";
          } else if (event.name === "feishu_contacts") {
            messagingFailures.delete(event.name);
          } else if (event.name === "feishu_send_message") {
            try {
              const receipt = JSON.parse(event.output);
              if (receipt.status === "sent" && /^om_[\w-]+$/.test(receipt.messageId)) {
                sendReceipts.add(`飞书已确认发送成功${receipt.identity === "bot" ? "（机器人身份）" : receipt.identity === "user" ? "（本人身份）" : ""}，消息 ID：${receipt.messageId}。`);
                messagingFailures.delete(event.name);
              }
            } catch { /* No delivery claim without a structured tool receipt. */ }
          }
        }
        if (event.type === "tool_result" && !event.isError) {
          const call = calls.get(event.toolCallId);
          if (call?.name === "ask_user") {
            const input = call.input as { question: string; options?: string[] };
            interaction = [input.question, ...(input.options ?? []).map((option, i) => `${i + 1}. ${option}`), "请直接回复你的选择或补充说明。"].join("\n");
          } else if (call?.name === "propose_outline") {
            const deck = call.input as PptDeck;
            interaction = ["请确认以下 PPT 大纲，或直接回复修改意见：", deck.title,
              ...deck.slides.map((slide, i) => [
                `${i + 1}. ${slide.title}`, slide.subtitle,
                ...(slide.bullets ?? []), ...(slide.items ?? []).map(item => [item.label, item.value, item.desc].filter(Boolean).join(" · ")),
                ...[slide.left, slide.right].flatMap(column => column ? [column.title, ...column.bullets] : []),
                slide.quote ? [slide.quote.text, slide.quote.author].filter(Boolean).join(" — ") : "",
                slide.source,
              ].filter(Boolean).join("\n")),
              "完整内容与版式可在 Lot Agent 飞书会话中查看。",
            ].join("\n\n");
          }
          if (["generate_document", "generate_ppt"].includes(event.name)) {
            const link = event.output.match(/下载链接：\s*(\S+)/)?.[1];
            if (link) {
              try {
                const url = new URL(link, process.env.PUBLIC_BASE_URL || undefined);
                if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) artifacts.add(`下载文件：${url.href}`);
              } catch { artifacts.add("文件已保存，请在 Lot Agent 的飞书会话中下载。"); }
            }
          }
        }
        // Drain through done and service finalizers so the persisted run retains its real status.
        if (event.type === "error") sawError = true;
        if (event.type === "done" && event.status === "awaiting_input" && status !== "unknown_outcome") {
          status = event.status;
          onAwaitingInput?.();
          if (!interaction) interaction = "请在 Lot Agent 飞书会话中查看待确认内容，并在这里回复。";
        } else if (event.type === "done" && status !== "unknown_outcome") status = event.status ?? "completed";
      }
    } catch { sawError = true; }
    if (sawError || !status || !["completed", "awaiting_input"].includes(status) || messagingFailures.size) {
      const failedStatus = status && !["completed", "awaiting_input"].includes(status) ? status : "failed";
      throw new TextRunError(partial(), failedStatus, [...messagingFailures.values(), runFailureReason(failedStatus)].join("\n"));
    }
    return partial() || "任务结束，未产生文字结果。";
  }
}
