import { describe, expect, it, vi } from "vitest";
import type { FeishuInboxJob } from "@lot-agent/core";
import { FeishuChannel } from "./channel.js";
import { FeishuError } from "./client.js";
import type { FeishuService } from "./service.js";
import type { AgentService } from "../services/agent-service.js";

const job=(text: string,user="u1"): FeishuInboxJob => ({ text,user_id:user,revision:"rev",chat_id:"chat",message_id:`message-${user}`,conversation_id:`conversation-${user}`,user_message_id:"input",result_message_id:"result",run_id:"run" });
function setup(jobs: FeishuInboxJob[]) {
  const repo={ claim:vi.fn(async () => jobs.shift() ?? null),active:vi.fn(async () => true),recordResult:vi.fn(async (_job: FeishuInboxJob, _text: string, _status: string) => {}),finish:vi.fn(async () => {}),connections:vi.fn(async () => []) };
  const feishu={ repository:repo,send:vi.fn(async () => ({ messageId:"om_sent" })),botReply:vi.fn(async () => "om_reply") };
  const agent={ streamAgentResponse:vi.fn(async function* () { yield { type:"text",content:"full result" }; yield { type:"done",status:"completed" }; }) };
  const channel=new FeishuChannel(feishu as unknown as FeishuService,agent as unknown as AgentService);
  return { repo,feishu,agent,channel };
}
describe("Feishu task delivery and transcript",() => {
  it("retains the controlled bot activation link and error code without accepting injected text", async () => {
    const s = setup([]);
    const reason = new FeishuError("bot_unavailable", 230013, "cli_test").message;
    s.agent.streamAgentResponse.mockImplementation(async function* (): AsyncGenerator<any> {
      yield { type: "tool_result", toolCallId: "send", name: "feishu_send_message", isError: true,
        output: reason, errorKind: "validation" };
      yield { type: "done", status: "failed" };
    });
    await expect(s.channel.execute(job("用机器人发给 Anson"), new AbortController().signal)).rejects.toThrow(reason);
    s.agent.streamAgentResponse.mockImplementation(async function* (): AsyncGenerator<any> {
      yield { type: "tool_result", toolCallId: "send", name: "feishu_send_message", isError: true,
        output: reason + "\nraw secret-token", errorKind: "validation" };
      yield { type: "done", status: "failed" };
    });
    await expect(s.channel.execute(job("用机器人发给 Anson"), new AbortController().signal)).rejects.not.toThrow("secret-token");
  });
  it("delivers the specific cross-tenant restriction even if the model claims completion", async () => {
    const task = job("给外部联系人发消息"), s = setup([task]);
    s.agent.streamAgentResponse.mockImplementation(async function* (): AsyncGenerator<any> {
      yield { type: "tool_result", toolCallId: "send", name: "feishu_send_message", isError: true,
        output: new FeishuError("rejected", 230038).message, errorKind: "validation" };
      yield { type: "done", status: "completed" };
    });
    s.channel.start(false);
    try { await vi.waitFor(() => expect(s.repo.finish).toHaveBeenCalledWith(task.message_id, "failed")); }
    finally { await s.channel.stop(); }
    expect(s.feishu.botReply).toHaveBeenCalledWith(task, expect.stringContaining("跨租户外部联系人"), expect.any(AbortSignal));
    expect(s.feishu.botReply).toHaveBeenCalledWith(task, expect.stringContaining("230038"), expect.any(AbortSignal));
  });
  it("drains the error stream through done and finalization, retains the API rejection and unknown status", async () => {
    const task = job("发送数据"), s = setup([task]);
    let reachedDone = false, finalized = false;
    s.agent.streamAgentResponse.mockImplementation(async function* (): AsyncGenerator<any> {
      try {
        yield { type: "text", content: "找到联系人，准备发送。" };
        yield { type: "tool_result", name: "feishu_send_message", toolCallId: "send", isError: true,
          output: new FeishuError("rejected", 230013).message, errorKind: "validation" };
        yield { type: "tool_result", name: "feishu_send_message", toolCallId: "duplicate", isError: true,
          output: new FeishuError("unknown").message, errorKind: "unknown_outcome" };
        yield { type: "error", message: "raw provider error containing secret-token" };
        reachedDone = true;
        yield { type: "done", status: "unknown_outcome" };
      } finally { finalized = true; }
    });
    s.channel.start(false);
    try { await vi.waitFor(() => expect(s.repo.finish).toHaveBeenCalledWith(task.message_id, "unknown")); }
    finally { await s.channel.stop(); }
    expect(reachedDone && finalized).toBe(true);
    const result = s.repo.recordResult.mock.calls[0][1];
    expect(result).toContain("230013");
    expect(result).toContain("勿重复发送");
    expect(result).toContain("运行 ID：run");
    expect(result).not.toContain("secret-token");
  });
  it("preserves a confirmed send receipt even if later model inference fails", async () => {
    const s = setup([]);
    s.agent.streamAgentResponse.mockImplementation(async function* (): AsyncGenerator<any> {
      yield { type: "tool_result", name: "feishu_send_message", toolCallId: "send", isError: false,
        output: JSON.stringify({ status: "sent", messageId: "om_delivered", identity: "user" }) };
      yield { type: "error", message: "model connection failed" };
      yield { type: "done", status: "failed" };
    });
    await expect(s.channel.execute(job("send"), new AbortController().signal)).rejects.toMatchObject({
      partial: expect.stringContaining("飞书已确认发送成功（本人身份），消息 ID：om_delivered"), status: "failed",
    });
  });
  it("does not accept an interrupted stream or a rejected send followed by a model completion as success", async () => {
    const s = setup([]);
    s.agent.streamAgentResponse.mockImplementation(async function* (): AsyncGenerator<any> {
      yield { type: "text", content: "准备发送。" };
    });
    await expect(s.channel.execute(job("send"), new AbortController().signal)).rejects.toMatchObject({ status: "failed" });
    s.agent.streamAgentResponse.mockImplementation(async function* (): AsyncGenerator<any> {
      yield { type: "tool_result", name: "feishu_send_message", toolCallId: "send", isError: true,
        output: new FeishuError("permission", 99991679).message };
      yield { type: "done", status: "completed" };
    });
    await expect(s.channel.execute(job("send"), new AbortController().signal)).rejects.toThrow("99991679");
  });
  it("reports an enabled binding awaiting socket sync as connecting, not disabled", async () => {
    const { channel } = setup([]);
    expect(channel.connectionStatus("cli_new")).toBe("disabled");
    channel.start(true);
    try {
      expect(channel.connectionStatus()).toBe("idle");
      expect(channel.connectionStatus("cli_new")).toBe("connecting");
    } finally { await channel.stop(); }
    expect(channel.connectionStatus("cli_new")).toBe("disabled");
  });
  it.each(["/help","生成一张图片","/send ou_alice hello","/reply om_original hello","/cancel","write a note"])("persists input/result for %s before attempting the bot reply",async text => {
    const task=job(text),s=setup([task]);
    s.feishu.botReply.mockImplementation(async () => { expect(s.repo.recordResult).toHaveBeenCalledWith(task,expect.any(String),"completed"); return "om_reply"; });
    s.channel.start(false);
    try { await vi.waitFor(() => expect(s.repo.finish).toHaveBeenCalledWith(task.message_id,"completed")); }
    finally { await s.channel.stop(); }
    if (text==="write a note") expect(s.agent.streamAgentResponse).toHaveBeenCalledWith("conversation-u1",text,"general","u1",[],expect.any(AbortSignal),{
      channel:"feishu",runId:"run",feishuTurn:{ userMessageId:"input",resultMessageId:"result",revision:"rev" },
    });
  });
  it("retains the full result if the bot reply is uncertain, without retry",async () => {
    const task=job("write"),s=setup([task]); s.feishu.botReply.mockRejectedValue(new FeishuError("unknown"));
    s.channel.start(false);
    try { await vi.waitFor(() => expect(s.repo.finish).toHaveBeenCalledWith(task.message_id,"reply_unknown")); }
    finally { await s.channel.stop(); }
    expect(s.repo.recordResult).toHaveBeenCalledWith(task,"full result","completed"); expect(s.feishu.botReply).toHaveBeenCalledTimes(1);
  });
  it("preserves partial output and reports failure for an incomplete model run",async () => {
    const task=job("write"),s=setup([task]);
    s.agent.streamAgentResponse.mockImplementation(async function* () { yield { type:"text",content:"partial output" }; yield { type:"done",status:"budget_exhausted" }; });
    s.channel.start(false);
    try { await vi.waitFor(() => expect(s.repo.finish).toHaveBeenCalledWith(task.message_id,"failed")); }
    finally { await s.channel.stop(); }
    expect(s.repo.recordResult).toHaveBeenCalledWith(task,expect.stringContaining("partial output"),"failed");
  });
  it("starts another user's task while the first user's task waits",async () => {
    const slow=job("slow","u1"),fast=job("fast","u2"),s=setup([slow,fast]);
    let release!: () => void; const gate=new Promise<void>(resolve => { release=resolve; });
    s.agent.streamAgentResponse.mockImplementation(async function* (...args: unknown[]) {
      if (args[0]==="conversation-u1") await gate;
      yield { type:"text",content:"done" }; yield { type:"done",status:"completed" };
    });
    s.channel.start(false);
    try {
      await vi.waitFor(() => expect(s.repo.finish).toHaveBeenCalledWith(fast.message_id,"completed"));
      expect(s.repo.finish).not.toHaveBeenCalledWith(slow.message_id,"completed");
    } finally { release(); await s.channel.stop(); }
  });
  it("does not hide an uncertain outgoing write when cancellation arrives",async () => {
    const task=job("/send ou_alice text"),s=setup([task]);
    s.feishu.send.mockImplementation(async () => { s.repo.active.mockResolvedValue(false); throw new FeishuError("unknown"); });
    s.channel.start(false);
    try { await vi.waitFor(() => expect(s.repo.finish).toHaveBeenCalledWith(task.message_id,"cancelled")); }
    finally { await s.channel.stop(); }
    expect(s.repo.recordResult).toHaveBeenCalledWith(task,expect.stringContaining("勿重复发送"),"cancelled");
    expect(s.feishu.botReply).not.toHaveBeenCalled();
  });
});


describe("Web tools over the Feishu channel", () => {
  it.each(["生成一张图片", "帮我制作视频", "/send 张三 明天开会", "给张三发：明天开会"])("runs %s through the Agent instead of a media placeholder or manual contact lookup", async text => {
    const s = setup([]);
    expect(await s.channel.execute(job(text), new AbortController().signal)).toBe("full result");
    expect(s.agent.streamAgentResponse).toHaveBeenCalled();
    expect(s.feishu.send).not.toHaveBeenCalled();
  });
  it.each(["ask_user", "propose_outline"])("delivers %s and persists awaiting_input instead of marking the task failed", async name => {
    const task = job("帮我准备"), s = setup([task]);
    s.agent.streamAgentResponse.mockImplementation(async function* (): AsyncGenerator<any> {
      yield { type: "tool_call", id: "question", name, input: name === "ask_user"
        ? { question: "你要发给哪位张三？", options: ["研发部张三", "销售部张三"] }
        : { title: "演示文稿", slides: [{ title: "第一章" }] } };
      yield { type: "tool_result", toolCallId: "question", name, isError: false, output: "waiting" };
      yield { type: "done", status: "awaiting_input" };
    });
    s.channel.start(false);
    try { await vi.waitFor(() => expect(s.repo.finish).toHaveBeenCalledWith(task.message_id, "awaiting_input")); }
    finally { await s.channel.stop(); }
    const expected = name === "ask_user" ? "研发部张三" : "第一章";
    expect(s.repo.recordResult).toHaveBeenCalledWith(task, expect.stringContaining(expected), "awaiting_input");
    expect(s.feishu.botReply).toHaveBeenCalledWith(task, expect.stringContaining(expected), expect.any(AbortSignal));
  });
  it("forwards exact document/PPT download receipts even when the model only says done", async () => {
    const s = setup([]);
    s.agent.streamAgentResponse.mockImplementation(async function* (): AsyncGenerator<any> {
      yield { type: "tool_result", name: "generate_document", toolCallId: "doc", output: "下载链接：https://example.org/report.docx\nasset_id: secret-internal-id", isError: false };
      yield { type: "tool_result", name: "web_fetch", toolCallId: "web", output: "下载链接：https://evil.example/fake", isError: false };
      yield { type: "text", content: "文件已生成。" };
      yield { type: "done", status: "completed" };
    });
    const output = await s.channel.execute(job("写文档"), new AbortController().signal);
    expect(output).toContain("https://example.org/report.docx");
    expect(output).not.toMatch(/secret-internal-id|evil.example/);
  });
});
