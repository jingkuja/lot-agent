import { describe, expect, it } from "vitest";
import {
  LLMIncompleteError, mapAnthropicStream, mapOpenAIStream, mapResponsesStream, type LLMProvider,
} from "@lot-agent/core";
import { collectProposal, proposalTool } from "./director-agent.js";

async function* streamOf<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

const breakdownPayload = {
  clips: [{ scene: "雨夜便利店", durationMs: 4000, shots: ["林夏推门走进便利店。"], lines: [{ speaker: "老板", text: "今天营业到凌晨。" }] }],
  characters: [{ name: "林夏", description: "短发少女" }],
};

const sequelPayload = {
  script: "第二集\n\n雨停后，便利店门口留下了一封信。",
  characters: [{ name: "林夏", description: "短发少女" }],
};

function providerFrom(stream: () => ReturnType<LLMProvider["chat"]>): LLMProvider {
  return { chat: () => stream() };
}

describe("collectProposal with real LLM stream adapters", () => {
  it("accepts OpenAI native tool_calls for breakdown_script and continue_series", async () => {
    for (const [breakdown, payload] of [[true, breakdownPayload], [false, sequelPayload]] as const) {
      const tool = proposalTool(breakdown);
      const llm = providerFrom(() => mapOpenAIStream(streamOf([
        {
          choices: [{
            delta: { tool_calls: [{ index: 0, id: "tc_1", function: { name: tool.name, arguments: JSON.stringify(payload) } }] },
            finish_reason: null,
          }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ] as never[])));
      const content = await collectProposal(llm, [{ role: "user", content: "go" }], {}, tool);
      expect(JSON.parse(content)).toEqual(payload);
    }
  });

  it("accepts Anthropic native tool_use (mapped to tool_calls) and end_turn JSON text", async () => {
    const breakdownTool = proposalTool(true);
    const anthropicNative = providerFrom(() => mapAnthropicStream(streamOf([
      { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: breakdownTool.name, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(breakdownPayload) } },
      { type: "message_delta", usage: { output_tokens: 15 }, delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ] as never[])));
    expect(JSON.parse(await collectProposal(anthropicNative, [{ role: "user", content: "go" }], {}, breakdownTool))).toEqual(breakdownPayload);

    const sequelTool = proposalTool(false);
    const anthropicText = providerFrom(() => mapAnthropicStream(streamOf([
      { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify(sequelPayload) } },
      { type: "message_delta", usage: { output_tokens: 15 }, delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ] as never[])));
    expect(JSON.parse(await collectProposal(anthropicText, [{ role: "user", content: "go" }], {}, sequelTool))).toEqual(sequelPayload);
  });

  it("accepts Responses native function_call (finishReason tool_calls) and completed JSON text", async () => {
    for (const [breakdown, payload] of [[true, breakdownPayload], [false, sequelPayload]] as const) {
      const tool = proposalTool(breakdown);
      const native = providerFrom(() => mapResponsesStream(streamOf([{
        type: "response.completed",
        response: {
          id: "resp_1", status: "completed",
          output: [{ type: "function_call", call_id: "fc_1", name: tool.name, arguments: JSON.stringify(payload), status: "completed" }],
          usage: { input_tokens: 10, output_tokens: 12 },
        },
      }] as never[]), "gpt-5.4"));
      expect(JSON.parse(await collectProposal(native, [{ role: "user", content: "go" }], {}, tool))).toEqual(payload);

      const jsonText = providerFrom(() => mapResponsesStream(streamOf([{
        type: "response.completed",
        response: {
          id: "resp_2", status: "completed",
          output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
          usage: { input_tokens: 10, output_tokens: 12 },
        },
      }] as never[]), "gpt-5.4"));
      expect(JSON.parse(await collectProposal(jsonText, [{ role: "user", content: "go" }], {}, tool))).toEqual(payload);
    }
  });

  it("rejects truncation (length/content_filter), wrong tool name, and invalid proposal arguments", async () => {
    const tool = proposalTool(true);
    const truncated = providerFrom(() => mapOpenAIStream(streamOf([
      { choices: [{ delta: { content: JSON.stringify(breakdownPayload) }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ] as never[])));
    await expect(collectProposal(truncated, [{ role: "user", content: "go" }], {}, tool)).rejects.toBeInstanceOf(LLMIncompleteError);

    const filtered = providerFrom(() => mapResponsesStream(streamOf([{
      type: "response.incomplete",
      response: { id: "resp_3", status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [], usage: { input_tokens: 5, output_tokens: 0 } },
    }] as never[]), "gpt-5.4"));
    await expect(collectProposal(filtered, [{ role: "user", content: "go" }], {}, tool)).rejects.toBeInstanceOf(LLMIncompleteError);

    const wrongTool = providerFrom(() => mapOpenAIStream(streamOf([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "tc_bad", function: { name: "request_generation", arguments: "{}" } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ] as never[])));
    await expect(collectProposal(wrongTool, [{ role: "user", content: "go" }], {}, tool)).rejects.toBeInstanceOf(LLMIncompleteError);

    const badArgs = providerFrom(() => mapOpenAIStream(streamOf([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0, id: "tc_empty",
              function: { name: tool.name, arguments: JSON.stringify({ clips: [], characters: [] }) },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ] as never[])));
    await expect(collectProposal(badArgs, [{ role: "user", content: "go" }], {}, tool)).rejects.toBeInstanceOf(LLMIncompleteError);
  });
});
