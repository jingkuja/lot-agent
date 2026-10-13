import { describe, expect, it, vi } from "vitest";
import type { FeishuInboxJob } from "@lot-agent/core";
import { FeishuChannel } from "./channel.js";
import { FeishuError } from "./client.js";
import type { FeishuService } from "./service.js";
import type { AgentService } from "../services/agent-service.js";

const job=(text: string,user="u1"): FeishuInboxJob => ({ text,user_id:user,revision:"rev",chat_id:"chat",message_id:`message-${user}`,conversation_id:`conversation-${user}`,user_message_id:"input",result_message_id:"result",run_id:"run" });
function setup(jobs: FeishuInboxJob[]) {
  const repo={ claim:vi.fn(async () => jobs.shift() ?? null),active:vi.fn(async () => true),recordResult:vi.fn(async () => {}),finish:vi.fn(async () => {}),connections:vi.fn(async () => []) };
  const feishu={ repository:repo,send:vi.fn(async () => ({ messageId:"om_sent" })),botReply:vi.fn(async () => "om_reply") };
  const agent={ streamAgentResponse:vi.fn(async function* () { yield { type:"text",content:"full result" }; yield { type:"done",status:"completed" }; }) };
  const channel=new FeishuChannel(feishu as unknown as FeishuService,agent as unknown as AgentService);
  return { repo,feishu,agent,channel };
}
describe("Feishu task delivery and transcript",() => {
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
      channel:"feishu",runId:"run",feishuTurn:{ userMessageId:"input",resultMessageId:"result" },
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
