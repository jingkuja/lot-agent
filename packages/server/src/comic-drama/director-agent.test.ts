import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Pool, PoolClient } from "pg";
import {
  LLMIncompleteError, mapAnthropicStream, mapOpenAIStream, mapResponsesStream, type LLMProvider,
} from "@lot-agent/core";
import type { ComicDirectorProposal, ComicDramaDetail } from "@lot-agent/core/comic-drama";
import { ComicDirector, collectProposal, createComicDirectorTools, enhanceProposalTool, proposalTool } from "./director-agent.js";
import { createComicDirectorLlmResolver } from "./director-model.js";
import { PgComicDirector } from "./director-repository.js";
import { createComicDirectorRoutes } from "./director-routes.js";
import { ComicDramaError, PgComicDramaRepository } from "./repository.js";

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

describe("comic director §8.5 tools and default text model resolver", () => {
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const seriesId = "22222222-2222-4222-8222-222222222222";
  const clipA = "33333333-3333-4333-8333-333333333333";
  const clipB = "44444444-4444-4444-8444-444444444444";
  const shotA = "55555555-5555-4555-8555-555555555555";
  const charA = "66666666-6666-4666-8666-666666666666";
  const outfitA = "77777777-7777-4777-8777-777777777777";
  const mediaA = "88888888-8888-4888-8888-888888888888";

  const detail: ComicDramaDetail = {
    series: {
      id: seriesId, parentId: null, title: "雨夜便利店", logline: "雨夜重逢", seriesGroup: "雨夜", episodeNo: 1,
      styleKey: "thick_painting", aspectRatio: "9:16", videoModel: "doubao-seedance-2-5", revision: 3, archivedAt: null,
    },
    script: { version: 1, content: "林夏走进雨夜便利店。" },
    cast: [{
      archived: false, hasUpdates: false,
      snapshot: {
        schemaVersion: 1, characterId: charA, name: "林夏", aliases: ["小夏"], age: "22", personality: "冷静",
        appearance: "短发雨衣", roleKey: "lead", outfitId: outfitA, outfitName: "雨衣",
        assets: [{
          kind: "slot", key: "front", version: 1,
          media: { id: mediaA, mime: "image/png", sizeBytes: 1024, width: 720, height: 1280, durationMs: null, hasThumbnail: true },
        }],
      },
    }],
    clips: [
      {
        id: clipA, revision: 2, selectionRevision: 1, ordinal: 1,
        draft: {
          schemaVersion: 1, durationMs: 4000, scene: "便利店门外",
          shots: [{ id: shotA, framingKey: "wide", movementKey: "fixed", description: "林夏推门", durationShare: 100 }],
          lines: [{ id: mediaA, speaker: "老板", text: "欢迎光临", emotionKey: null, speed: 1 }],
        },
      },
      {
        id: clipB, revision: 1, selectionRevision: 1, ordinal: 2,
        draft: { schemaVersion: 1, durationMs: 5000, scene: "收银台", shots: [], lines: [] },
      },
    ],
  };

  it("executes all 6 §8.5 tools with owner scoping and revision checks", async () => {
    const saveClip = vi.fn(async (_o, _s, cid, input) => ({
      clip: { id: cid, ordinal: 1, revision: input.expectedRevision + 1, selectionRevision: 1, draft: input.draft },
      seriesRevision: 4,
    }));
    const reorder = vi.fn(async (_o, _s, input) => ({
      seriesRevision: input.expectedRevision + 1, script: detail.script, cast: detail.cast,
      clips: [detail.clips[1], detail.clips[0]].map((c, idx) => ({ ...c, ordinal: idx + 1 })),
    }));
    const tools = createComicDirectorTools(ownerId, seriesId, {
      episodes: { get: vi.fn(async () => detail), saveClip, reorder },
      library: {
        listCharacters: vi.fn(async () => ({
          entries: [{
            id: charA, name: "林夏", aliases: ["小夏"], tags: [], roleKey: "lead",
            age: "22", personality: "冷静", appearance: "短发", archived: false, cover: null,
          }],
          more: false,
        })),
        listMaterials: vi.fn(async () => ({
          entries: [{
            id: mediaA, kind: "scene" as const, name: "雨夜街头", categoryKey: "street", tags: ["雨"], archived: false, version: 1,
            media: { id: mediaA, mime: "image/png", sizeBytes: 1000, width: 720, height: 1280, durationMs: null, hasThumbnail: true },
          }],
          more: false,
        })),
      },
      settings: { getStylePreset: vi.fn(async () => null) },
    });

    expect(tools.definitions.map(def => def.name)).toEqual([
      "read_series", "update_clip", "reorder_clips", "search_characters", "search_materials", "check_series",
    ]);

    const readRes = await tools.execute("read_series", {});
    expect(readRes.ok).toBe(true);
    expect(readRes.summary).toContain("雨夜便利店");

    const checkRes = await tools.execute("check_series", {});
    expect(checkRes.ok).toBe(true);
    expect((checkRes.data as { issueCount: number }).issueCount).toBe(1);

    const charRes = await tools.execute("search_characters", { query: "林夏" });
    expect(charRes.ok).toBe(true);
    expect((charRes.data as Array<{ id: string }>)[0]?.id).toBe(charA);

    const matRes = await tools.execute("search_materials", { query: "雨", kind: "scene" });
    expect(matRes.ok).toBe(true);
    expect((matRes.data as Array<{ id: string }>)[0]?.id).toBe(mediaA);

    const updateRes = await tools.execute("update_clip", {
      ordinal: 1, scene: "雨夜门廊", durationMs: 6000, castCharacterIds: [charA],
    });
    expect(updateRes.ok).toBe(true);
    expect(updateRes.mutated).toBe(true);
    expect(saveClip).toHaveBeenCalledTimes(1);

    const reorderRes = await tools.execute("reorder_clips", { clipIds: [clipB, clipA] });
    expect(reorderRes.ok).toBe(true);
    expect(reorderRes.mutated).toBe(true);
    expect(reorder).toHaveBeenCalledWith(ownerId, seriesId, { expectedRevision: 3, clipIds: [clipB, clipA] });
  });

  it("selects authorized copy models in order and changes only the account whose model failed", async () => {
    const chosen: string[] = [];
    const resolver = createComicDirectorLlmResolver({
      getUserApiKey: async () => "user-key",
      managedKeysEnabled: true,
      listLlmModels: async () => ["deepseek-v4.1-flash", "claude-sonnet-5-5", "kimi-k3", "kimi-k3.1-pro"],
      llm: (modelId) => { chosen.push(modelId); return { chat: async function* () {} }; },
    });
    const first = await resolver(ownerId);
    expect(first.usedModelId).toBe("kimi-k3.1-pro");
    first.failed?.();
    const fallback = await resolver(ownerId);
    expect(fallback.usedModelId).toBe("kimi-k3");
    fallback.failed?.();
    expect((await resolver(ownerId)).usedModelId).toBe("deepseek-v4.1-flash");
    expect((await resolver("other")).usedModelId).toBe("kimi-k3.1-pro");
    expect(chosen).toEqual(["kimi-k3.1-pro", "kimi-k3", "deepseek-v4.1-flash", "kimi-k3.1-pro"]);

    const limited = createComicDirectorLlmResolver({
      getUserApiKey: async () => "user-key",
      managedKeysEnabled: true,
      listLlmModels: async owner => owner === ownerId ? ["deepseek-v4.1-flash"] : ["claude-sonnet-5-5"],
      llm: () => ({ chat: async function* () {} }),
    });
    expect((await limited(ownerId)).usedModelId).toBe("deepseek-v4.1-flash");
    await expect(limited("other")).rejects.toThrow("COMIC_DIRECTOR_LLM_UNAVAILABLE");
  });

  it("P1 #2: rejects stale concurrent director writes with REVISION_CONFLICT while allowing consecutive same-turn writes", async () => {
    let seriesRev = 3;
    let clips = detail.clips.map(clip => ({
      ...clip,
      draft: {
        ...clip.draft,
        shots: clip.draft.shots.map(s => ({
          ...s,
          sfxRefs: [{ materialId: mediaA, mediaId: mediaA, name: "推门声", position: "start" as const }],
        })),
      },
    }));
    const currentDetail = (): ComicDramaDetail => ({
      ...detail,
      series: { ...detail.series, revision: seriesRev },
      clips,
    });
    const saveClip = vi.fn(async (_o, _s, cid, input) => {
      if (input.expectedSeriesRevision !== undefined && input.expectedSeriesRevision !== seriesRev) {
        throw new ComicDramaError("REVISION_CONFLICT", seriesRev);
      }
      const target = clips.find(c => c.id === cid)!;
      if (target.revision !== input.expectedRevision) throw new ComicDramaError("REVISION_CONFLICT", target.revision);
      seriesRev += 1;
      const updated = { ...target, revision: target.revision + 1, draft: input.draft };
      clips = clips.map(c => c.id === cid ? updated : c);
      return { clip: updated, seriesRevision: seriesRev };
    });
    const reorder = vi.fn(async (_o, _s, input) => {
      if (input.expectedRevision !== seriesRev) throw new ComicDramaError("REVISION_CONFLICT", seriesRev);
      seriesRev += 1;
      const byId = new Map(clips.map(c => [c.id, c]));
      clips = input.clipIds.map((id: string, idx: number) => ({ ...byId.get(id)!, ordinal: idx + 1 }));
      return { seriesRevision: seriesRev, script: detail.script, cast: detail.cast, clips };
    });

    const repo = {
      ensureChatSession: vi.fn(async () => ({ conversationId: "conv-1", revision: seriesRev, title: detail.series.title })),
      chatMessages: vi.fn(async () => []),
      recordChatTurn: vi.fn(async (_conv, _u, assistantText, toolCalls) => ({
        id: "msg-1", role: "assistant" as const, content: assistantText, createdAt: new Date().toISOString(), toolCalls,
      })),
      episode: vi.fn(async () => ({ title: detail.series.title, logline: "", revision: seriesRev, archived: false })),
    } as unknown as PgComicDirector;

    // Case 1: Another tab mutates series & reorders while LLM is thinking -> write must fail with REVISION_CONFLICT
    let concurrentMutated = false;
    const concurrentLlm: LLMProvider = {
      async *chat() {
        if (!concurrentMutated) {
          concurrentMutated = true;
          seriesRev = 4;
          clips = [clips[1], clips[0]].map((c, idx) => ({ ...c, ordinal: idx + 1 }));
        }
        yield {
          type: "tool_call",
          toolCall: { id: "c1", name: "update_clip", arguments: { ordinal: 1, scene: "旧轮次覆盖" } },
        };
        yield { type: "done", finishReason: "tool_calls" };
      },
    };
    const makeDirector = (llm: LLMProvider) => new ComicDirector(
      repo,
      {
        agentId: "comic-director", ownerKeyOnly: true, disableUserMemory: true,
        conversationMetadata: () => ({}), assertConversation: () => {}, validateChatMedia: async () => null,
        beginTurn: async () => ({ allowedToolNames: [], blockedToolNames: [], dynamicParts: [] }),
        resolveModel: async () => ({ llm, usedModelId: "test-llm", modelIds: ["test-llm"] }),
      },
      undefined,
      {
        episodes: { get: vi.fn(async () => currentDetail()), saveClip, reorder },
        library: { listCharacters: vi.fn(), listMaterials: vi.fn() },
      },
    );

    await expect(makeDirector(concurrentLlm).chat(ownerId, seriesId, {
      message: "把第一段场景改一下", expectedRevision: 3, language: "zh",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "REVISION_CONFLICT", currentRevision: 4 });
    expect(saveClip).not.toHaveBeenCalled();
    expect(clips[0].id).toBe(clipB); // Order from other tab preserved!

    // Case 2: Same-turn consecutive update_clip -> reorder_clips succeeds and preserves shot sfxRefs!
    let step = 0;
    const sequentialLlm: LLMProvider = {
      async *chat() {
        step += 1;
        if (step === 1) {
          yield {
            type: "tool_call",
            toolCall: {
              id: "s1", name: "update_clip",
              arguments: {
                clipId: clipA, scene: "新门廊",
                shots: [{ description: "林夏推门并四处张望", framingKey: "wide", movementKey: "push", durationShare: 100 }],
              },
            },
          };
          yield {
            type: "tool_call",
            toolCall: { id: "s2", name: "reorder_clips", arguments: { clipIds: [clipA, clipB] } },
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text", content: "已按要求修改并重排。" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const res = await makeDirector(sequentialLlm).chat(ownerId, seriesId, {
      message: "更新分镜并重排", expectedRevision: 4, language: "zh",
    }, new AbortController().signal);
    expect(res.seriesUpdated).toBe(true);
    expect(res.latestRevision).toBe(6);
    expect(saveClip).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(clips[0].id).toBe(clipA);
    expect(clips[0].draft.shots[0].sfxRefs).toHaveLength(1); // P2 #8 preserved shot sfxRefs!
  });

  it("P2 #9: halts on breakdown_script before request_generation, then previews quote after apply with zero paid submissions", async () => {
    let episodeClips: ComicDramaDetail["clips"] = [];
    let seriesRev = 1;
    const previewGeneration = vi.fn(async () => ({
      confirmationId: "11111111-1111-4111-8111-111111111111",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      items: [{ clipId: clipA, modelId: "gpt-image-2", unit: "image" as const, quantity: 1, amountMicros: 50_000 }],
      skipped: [],
      totalMicros: 50_000,
      currency: "CNY" as const,
    }));
    const recordedCards: Array<{ proposalId?: string; confirmationId?: string } | undefined> = [];
    const createdProposal = {
      id: "22222222-2222-4222-8222-222222222222",
      conversationId: "conv-2",
      baseRevision: 1,
      createdAt: new Date().toISOString(),
      input: { requestId: clipA, expectedRevision: 1, mode: "paste" as const, language: "zh" as const, text: "原稿", action: "breakdown" as const },
      original: "原稿",
      status: "ready" as const,
      appliedRevision: null,
      proposal: { script: "", roles: [], clips: [detail.clips[0].draft], previousScenes: [] },
    };
    const repo = {
      ensureChatSession: vi.fn(async () => ({ conversationId: "conv-2", revision: seriesRev, title: detail.series.title })),
      chatMessages: vi.fn(async () => []),
      recordChatTurn: vi.fn(async (_conv, _u, assistantText, toolCalls, _model, cards) => {
        recordedCards.push(cards);
        return {
          id: "msg-" + recordedCards.length, role: "assistant" as const, content: assistantText,
          createdAt: new Date().toISOString(), toolCalls, ...cards,
        };
      }),
      episode: vi.fn(async () => ({ title: detail.series.title, logline: "", revision: seriesRev, archived: false })),
      claim: vi.fn(async () => ({
        episode: { title: detail.series.title, logline: "", revision: seriesRev },
        proposal: createdProposal,
        created: false,
        previousScenes: [],
      })),
    } as unknown as PgComicDirector;

    // Turn 1: user asks "把原稿拆成分镜，再生成首帧"; even if LLM emits BOTH tool calls, breakdown_script endsTurn immediately!
    const turn1Llm: LLMProvider = {
      async *chat() {
        yield { type: "tool_call", toolCall: { id: "t1", name: "breakdown_script", arguments: { sourceText: "林夏走进雨夜便利店" } } };
        yield { type: "tool_call", toolCall: { id: "t2", name: "request_generation", arguments: { mode: "keyframe" } } };
        yield { type: "done", finishReason: "tool_calls" };
      },
    };
    const makeDirector = (llm: LLMProvider) => new ComicDirector(
      repo,
      {
        agentId: "comic-director", ownerKeyOnly: true, disableUserMemory: true,
        conversationMetadata: () => ({}), assertConversation: () => {}, validateChatMedia: async () => null,
        beginTurn: async () => ({ allowedToolNames: [], blockedToolNames: [], dynamicParts: [] }),
        resolveModel: async () => ({ llm, usedModelId: "test-llm", modelIds: ["test-llm"] }),
      },
      undefined,
      {
        episodes: {
          get: vi.fn(async () => ({ ...detail, series: { ...detail.series, revision: seriesRev }, clips: episodeClips })),
          saveClip: vi.fn(),
          reorder: vi.fn(),
        },
        library: { listCharacters: vi.fn(), listMaterials: vi.fn() },
        previewGeneration,
      },
    );

    const r1 = await makeDirector(turn1Llm).chat(ownerId, seriesId, {
      message: "把原稿拆成分镜，再生成首帧", expectedRevision: 1, language: "zh",
    }, new AbortController().signal);
    expect(r1.proposal?.id).toBe(createdProposal.id);
    expect(r1.quote).toBeUndefined();
    expect(previewGeneration).not.toHaveBeenCalled();
    expect(recordedCards[0]).toEqual({ proposalId: createdProposal.id, confirmationId: undefined });

    // Simulate user applying the breakdown proposal (clips now exist, seriesRev=2)
    episodeClips = [detail.clips[0]];
    seriesRev = 2;

    // Turn 2: now user asks to preview keyframe generation -> quote preview card created, 0 paid submissions
    const turn2Llm: LLMProvider = {
      async *chat() {
        yield { type: "tool_call", toolCall: { id: "t3", name: "request_generation", arguments: { mode: "keyframe" } } };
        yield { type: "done", finishReason: "tool_calls" };
      },
    };
    const r2 = await makeDirector(turn2Llm).chat(ownerId, seriesId, {
      message: "帮我预览首帧生成费用", expectedRevision: 2, language: "zh",
    }, new AbortController().signal);
    expect(previewGeneration).toHaveBeenCalledTimes(1);
    expect(r2.quote?.confirmationId).toBe("11111111-1111-4111-8111-111111111111");
    expect(recordedCards[1]).toEqual({ proposalId: undefined, confirmationId: "11111111-1111-4111-8111-111111111111" });
  });
});

describe("comic director AI enhancement (script & storyboard clips)", () => {
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const seriesId = "22222222-2222-4222-8222-222222222222";
  const clipA = "33333333-3333-4333-8333-333333333333";
  const clipB = "44444444-4444-4444-8444-444444444444";
  const shot1 = "55555555-5555-4555-8555-555555555551";
  const shot2 = "55555555-5555-4555-8555-555555555552";
  const charA = "66666666-6666-4666-8666-666666666666";
  const outfitA = "77777777-7777-4777-8777-777777777777";
  const mediaA = "88888888-8888-4888-8888-888888888888";
  const convId = "99999999-9999-4999-8999-999999999999";

  it("collects enhance_script and enhance_clips proposals via tool calls", async () => {
    const scriptTool = enhanceProposalTool("script");
    const scriptPayload = { segments: [{ index: 0, suggested: "第一段增强版", notes: "强化动作" }] };
    const scriptLlm = providerFrom(() => mapOpenAIStream(streamOf([
      {
        choices: [{
          delta: { tool_calls: [{ index: 0, id: "es_1", function: { name: scriptTool.name, arguments: JSON.stringify(scriptPayload) } }] },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ] as never[])));
    expect(JSON.parse(await collectProposal(scriptLlm, [{ role: "user", content: "go" }], {}, scriptTool))).toEqual(scriptPayload);

    const clipTool = enhanceProposalTool("clips");
    const clipPayload = {
      clips: [{
        index: 0,
        clipId: clipA,
        scene: "雨夜便利店门口",
        durationMs: 6000,
        shots: [
          { framingKey: "wide", movementKey: "push", description: "远景推进，霓虹映在雨衣上", durationShare: 45 },
          { framingKey: "close_up", movementKey: "fixed", description: "门铃特写晃动", durationShare: 55 },
        ],
        lines: [{ speaker: "林夏", text: "还开着吗？", emotionKey: "calm", speed: 1 }],
      }],
    };
    const clipLlm = providerFrom(() => mapOpenAIStream(streamOf([
      {
        choices: [{
          delta: { tool_calls: [{ index: 0, id: "ec_1", function: { name: clipTool.name, arguments: JSON.stringify(clipPayload) } }] },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ] as never[])));
    expect(JSON.parse(await collectProposal(clipLlm, [{ role: "user", content: "go" }], {}, clipTool))).toEqual(clipPayload);
  });

  function makeEnhanceHarness() {
    const state = {
      series: {
        id: seriesId, ownerId, parentId: null as string | null, title: "雨夜便利店", logline: "雨夜重逢",
        seriesGroup: null as string | null, episodeNo: 1, styleKey: "thick_painting", aspectRatio: "9:16",
        videoModel: "doubao-seedance-2-5", revision: 1, archived: false,
      },
      scriptVersion: 1,
      script: "第一段：林夏独自站在雨夜街头。\n\n第二段：推门进入便利店，老板抬头看她。",
      clips: [
        {
          id: clipA, revision: 1, selectionRevision: 1, ordinal: 1,
          draft: {
            schemaVersion: 1 as const, durationMs: 4000, scene: "原场景一：雨夜街头",
            shots: [{ id: shot1, framingKey: "wide", movementKey: "fixed", description: "原镜头一", durationShare: 100 }],
            lines: [{ id: "10000000-0000-4000-8000-000000000001", speaker: null, text: "原旁白一", emotionKey: null, speed: 1 }],
          },
        },
        {
          id: clipB, revision: 1, selectionRevision: 1, ordinal: 2,
          draft: {
            schemaVersion: 1 as const, durationMs: 6000, scene: "原场景二：便利店柜台",
            shots: [{ id: shot2, framingKey: "medium", movementKey: "fixed", description: "原镜头二", durationShare: 100 }],
            lines: [{ id: "10000000-0000-4000-8000-000000000002", speaker: "林夏", text: "原台词二", emotionKey: null, speed: 1 }],
            cast: [{ characterId: charA, slotKey: "front", expressionKey: null }],
          },
        },
      ],
      proposals: new Map<string, ComicDirectorProposal>(),
      sessionCreated: false,
      seq: 0,
    };

    const client: PoolClient = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (sql.includes("FROM lot_comic_drama.cd_series WHERE owner_id=$1 AND id=$2")) {
          if (sql.includes("archived_at IS NOT NULL AS archived")) {
            return {
              rows: [{
                title: state.series.title, logline: state.series.logline, styleKey: state.series.styleKey,
                aspectRatio: state.series.aspectRatio, videoModel: state.series.videoModel, revision: state.series.revision,
                archived: state.series.archived,
              }],
              rowCount: 1,
            };
          }
          return {
            rows: [{
              id: state.series.id, parentId: state.series.parentId, title: state.series.title, logline: state.series.logline,
              seriesGroup: state.series.seriesGroup, episodeNo: state.series.episodeNo, styleKey: state.series.styleKey,
              aspectRatio: state.series.aspectRatio, videoModel: state.series.videoModel, revision: state.series.revision,
              archivedAt: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM lot_comic_drama.cd_director_proposals") && sql.includes("request_id=$3")) {
          const hit = [...state.proposals.values()].find(p => p.input.requestId === params[2]);
          return { rows: hit ? [{ ...hit, createdAt: new Date(hit.createdAt) }] : [], rowCount: hit ? 1 : 0 };
        }
        if (sql.includes("FROM lot_comic_drama.cd_director_proposals") && sql.includes("WHERE owner_id=$1 AND series_id=$2 AND id=$3")) {
          const hit = state.proposals.get(String(params[2]));
          return { rows: hit ? [{ ...hit, createdAt: new Date(hit.createdAt) }] : [], rowCount: hit ? 1 : 0 };
        }
        if (sql.includes("FROM lot_comic_drama.cd_director_proposals") && sql.includes("status='writing'")) {
          if (sql.startsWith("UPDATE")) return { rows: [], rowCount: 0 };
          const active = [...state.proposals.values()].some(p => p.status === "writing");
          return { rows: active ? [{ 1: 1 }] : [], rowCount: active ? 1 : 0 };
        }
        if (sql.includes("FROM lot_comic_drama.cd_director_sessions")) {
          return { rows: state.sessionCreated ? [{ conversation_id: convId }] : [], rowCount: state.sessionCreated ? 1 : 0 };
        }
        if (sql.startsWith("INSERT INTO lot_comic_drama.cd_director_sessions")) {
          state.sessionCreated = true;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SELECT content FROM lot_comic_drama.cd_scripts")) {
          return { rows: [{ content: state.script }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO lot_comic_drama.cd_scripts")) {
          state.scriptVersion += 1;
          state.script = String(params[1]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM lot_comic_drama.cd_series_cast")) {
          if (sql.includes("character_id = ANY")) return { rows: [{ character_id: charA }], rowCount: 1 };
          return {
            rows: [{
              archived: false, hasUpdates: false,
              snapshot: {
                schemaVersion: 1, characterId: charA, name: "林夏", aliases: ["小夏"], age: "22", personality: "冷静",
                appearance: "短发雨衣", roleKey: "lead", outfitId: outfitA, outfitName: "雨衣",
                assets: [{
                  kind: "slot", key: "front", version: 1,
                  media: { id: mediaA, mime: "image/png", sizeBytes: 1024, width: 720, height: 1280, durationMs: null, hasThumbnail: true },
                }],
              },
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM lot_comic_drama.cd_dictionary")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM lot_comic_drama.cd_clips WHERE series_id=$1 ORDER BY ordinal")) {
          return { rows: state.clips.map(c => ({ ...c })), rowCount: state.clips.length };
        }
        if (sql.includes("FROM lot_comic_drama.cd_clips WHERE series_id=$1 AND id=$2")) {
          const hit = state.clips.find(c => c.id === params[1]);
          return { rows: hit ? [{ ...hit }] : [], rowCount: hit ? 1 : 0 };
        }
        if (sql.startsWith("UPDATE lot_comic_drama.cd_clips SET draft=$2")) {
          const hit = state.clips.find(c => c.id === params[0]);
          if (hit) {
            hit.draft = params[1] as typeof hit.draft;
            hit.revision += 1;
            return { rows: [{ ...hit }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("UPDATE lot_comic_drama.cd_series SET revision=revision+1")) {
          state.series.revision += 1;
          return { rows: [{ revision: state.series.revision }], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO lot_comic_drama.cd_director_proposals")) {
          const id = `aaaaaaaa-0000-4000-8000-${String(++state.seq).padStart(12, "0")}`;
          const row: ComicDirectorProposal = {
            id,
            conversationId: String(params[2]),
            baseRevision: Number(params[4]),
            createdAt: new Date().toISOString(),
            input: params[5] as ComicDirectorProposal["input"],
            original: String(params[6]),
            status: "writing",
            appliedRevision: null,
            proposal: null,
            decision: null,
            sequelId: null,
            roleDecisions: {},
          };
          state.proposals.set(id, row);
          return { rows: [{ ...row, createdAt: new Date(row.createdAt) }], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE lot_comic_drama.cd_director_proposals SET status=$4,proposal=$5,model=$6")) {
          const row = state.proposals.get(String(params[2]))!;
          row.status = params[3] as ComicDirectorProposal["status"];
          row.proposal = params[4] as ComicDirectorProposal["proposal"];
          return { rows: [{ ...row, createdAt: new Date(row.createdAt) }], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE lot_comic_drama.cd_director_proposals SET status=$4,applied_revision=$5")) {
          const row = state.proposals.get(String(params[2]))!;
          row.status = params[3] as ComicDirectorProposal["status"];
          row.appliedRevision = Number(params[4]);
          row.decision = "enhance";
          row.proposal = params[5] as ComicDirectorProposal["proposal"];
          return { rows: [{ ...row, createdAt: new Date(row.createdAt) }], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE lot_comic_drama.cd_director_proposals SET status=$4,proposal=$5")) {
          const row = state.proposals.get(String(params[2]))!;
          row.status = params[3] as ComicDirectorProposal["status"];
          row.proposal = params[4] as ComicDirectorProposal["proposal"];
          return { rows: [{ ...row, createdAt: new Date(row.createdAt) }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;

    const pool = { connect: vi.fn(async () => client), query: client.query } as unknown as Pool;
    const episodes = new PgComicDramaRepository(pool);
    const repo = new PgComicDirector(pool, episodes);
    return { state, episodes, repo };
  }

  it("enhances two adjacent storyboard clips, adopts only the second with 100% shares, and leaves the first untouched with zero media jobs", async () => {
    const { state, episodes, repo } = makeEnhanceHarness();
    const previewGeneration = vi.fn();
    let capturedPayload: unknown = null;
    const llm: LLMProvider = {
      async *chat(messages) {
        capturedPayload = JSON.parse(String(messages.at(-1)!.content));
        yield {
          type: "tool_call",
          toolCall: {
            id: "call_clips",
            name: "enhance_clips",
            arguments: {
              clips: [
                {
                  index: 0, clipId: clipA, scene: "建议场景一：暴雨街头", durationMs: 5000, notes: "增加切镜",
                  shots: [
                    { framingKey: "extreme_wide", movementKey: "pull", description: "远景拉远展现雨夜霓虹", durationShare: 50 },
                    { framingKey: "near", movementKey: "follow", description: "林夏压低帽檐走近门口", durationShare: 50 },
                  ],
                  lines: [{ speaker: null, text: "夜深了，雨越下越大。", emotionKey: "calm", speed: 1 }],
                },
                {
                  index: 1, clipId: clipB, scene: "建议场景二：暖灯柜台", durationMs: 8000, notes: "突出重逢瞬间",
                  shots: [
                    { framingKey: "wide", movementKey: "push", description: "推进到门铃晃动", durationShare: 30 },
                    { framingKey: "close_up", movementKey: "fixed", description: "特写林夏摘下兜帽", durationShare: 70 },
                  ],
                  lines: [{ speaker: "小夏", text: "这把伞，我还给你。", emotionKey: "gentle", speed: 1 }],
                },
              ],
            },
          },
        };
        yield { type: "done", finishReason: "tool_calls" };
      },
    };
    const director = new ComicDirector(repo, {
      agentId: "comic_drama", ownerKeyOnly: true, disableUserMemory: true,
      conversationMetadata: () => ({}), assertConversation: () => {}, validateChatMedia: async () => null,
      beginTurn: async () => ({ allowedToolNames: [], blockedToolNames: [], dynamicParts: [] }),
      resolveModel: async () => ({ llm, usedModelId: "kimi-k3.1-pro", modelIds: ["kimi-k3.1-pro"] }),
    }, undefined, {
      episodes,
      library: { listCharacters: vi.fn(), listMaterials: vi.fn() },
      previewGeneration,
    });
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", ownerId); await next(); });
    app.route("/", createComicDirectorRoutes(repo, director, "unused"));

    const proposeRes = await app.request(`/series/${seriesId}/director/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "aaaaaaaa-1111-4111-8111-111111111111",
        expectedRevision: 1,
        language: "zh",
        action: "enhance",
        enhance: { scope: "clips", clipIds: [clipA, clipB] },
      }),
    });
    expect(proposeRes.status).toBe(200);
    const created = await proposeRes.json() as ComicDirectorProposal;
    expect(created.status).toBe("ready");
    expect(created.proposal?.clipEnhancements).toHaveLength(2);
    // Verify context passed to LLM includes cast, style, target duration, and adjacent clips
    expect((capturedPayload as { series: { style: string } }).series.style).toBe("国漫厚涂");
    expect((capturedPayload as { targets: Array<{ nextClip: unknown; previousClip: unknown }> }).targets[0]?.nextClip).toBeTruthy();
    expect((capturedPayload as { targets: Array<{ nextClip: unknown; previousClip: unknown }> }).targets[1]?.previousClip).toBeTruthy();
    // Alias "小夏" normalized to cast member "林夏"
    expect(created.proposal?.clipEnhancements?.[1]?.suggested.lines[0]?.speaker).toBe("林夏");

    // Creator edits segment 2 and adopts ONLY segment 2 (index 1)
    const editedSecond = {
      ...created.proposal!.clipEnhancements![1]!.suggested,
      shots: [
        { ...created.proposal!.clipEnhancements![1]!.suggested.shots[0]!, durationShare: 40 },
        { ...created.proposal!.clipEnhancements![1]!.suggested.shots[1]!, durationShare: 60 },
      ],
    };
    const applyRes = await app.request(`/series/${seriesId}/director/proposals/${created.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        decision: "enhance",
        clipItems: [{ index: 1, draft: editedSecond }],
      }),
    });
    expect(applyRes.status).toBe(200);
    const afterApply = await applyRes.json() as ComicDirectorProposal;
    expect(afterApply.status).toBe("ready"); // segment 0 still pending
    expect(afterApply.appliedRevision).toBe(2);
    expect(state.clips[0]!.draft.scene).toBe("原场景一：雨夜街头");
    expect(state.clips[0]!.draft.shots[0]!.description).toBe("原镜头一");
    expect(state.clips[1]!.draft.scene).toBe("建议场景二：暖灯柜台");
    expect(state.clips[1]!.draft.shots.reduce((sum, s) => sum + s.durationShare, 0)).toBe(100);
    expect(previewGeneration).not.toHaveBeenCalled();

    // Dismiss remaining segment 0 transitions proposal to applied
    const dismissRes = await app.request(`/series/${seriesId}/director/proposals/${created.id}/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemIndex: 0 }),
    });
    expect(dismissRes.status).toBe(200);
    expect((await dismissRes.json() as ComicDirectorProposal).status).toBe("applied");
    expect(state.clips[0]!.draft.scene).toBe("原场景一：雨夜街头");
  });

  it("enhances adjacent script paragraphs partially and rejects stale adoption after concurrent edits", async () => {
    const { state, episodes, repo } = makeEnhanceHarness();
    let mutateDuringRun = false;
    const llm: LLMProvider = {
      async *chat() {
        if (mutateDuringRun) {
          state.series.revision += 1;
          state.script = "并发修改后的剧本第一段。\n\n并发修改后的第二段。";
        }
        yield {
          type: "tool_call",
          toolCall: {
            id: "call_script",
            name: "enhance_script",
            arguments: {
              segments: [
                { index: 0, suggested: "第一段增强：暴雨倾盆，林夏攥紧伞柄。" },
                { index: 1, suggested: "第二段增强：铜铃轻响，柜台后的老板微微抬眼。" },
              ],
            },
          },
        };
        yield { type: "done", finishReason: "tool_calls" };
      },
    };
    const director = new ComicDirector(repo, {
      agentId: "comic_drama", ownerKeyOnly: true, disableUserMemory: true,
      conversationMetadata: () => ({}), assertConversation: () => {}, validateChatMedia: async () => null,
      beginTurn: async () => ({ allowedToolNames: [], blockedToolNames: [], dynamicParts: [] }),
      resolveModel: async () => ({ llm, usedModelId: "kimi-k3.1-pro", modelIds: ["kimi-k3.1-pro"] }),
    }, undefined, {
      episodes,
      library: { listCharacters: vi.fn(), listMaterials: vi.fn() },
    });
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => { c.set("userId", ownerId); await next(); });
    app.route("/", createComicDirectorRoutes(repo, director, "unused"));

    // 1. Two-paragraph enhancement -> adopt ONLY second paragraph
    const res1 = await app.request(`/series/${seriesId}/director/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "bbbbbbbb-1111-4111-8111-111111111111",
        expectedRevision: 1,
        language: "zh",
        action: "enhance",
        enhance: { scope: "script_full" },
      }),
    });
    const prop1 = await res1.json() as ComicDirectorProposal;
    expect(prop1.status).toBe("ready");
    expect(prop1.proposal?.scriptEnhancements).toHaveLength(2);

    const applyP2 = await app.request(`/series/${seriesId}/director/proposals/${prop1.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, decision: "enhance", scriptItems: [{ index: 1 }] }),
    });
    expect(applyP2.status).toBe(200);
    expect(state.script).toBe("第一段：林夏独自站在雨夜街头。\n\n第二段增强：铜铃轻响，柜台后的老板微微抬眼。");

    // 2. Concurrent edit while suggestions are generating -> apply must reject with 409 DIRECTOR_PROPOSAL_STALE
    mutateDuringRun = true;
    const currentRev = state.series.revision;
    const res2 = await app.request(`/series/${seriesId}/director/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "cccccccc-1111-4111-8111-111111111111",
        expectedRevision: currentRev,
        language: "zh",
        action: "enhance",
        enhance: { scope: "script_full" },
      }),
    });
    const prop2 = await res2.json() as ComicDirectorProposal;
    const staleApply = await app.request(`/series/${seriesId}/director/proposals/${prop2.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: currentRev, decision: "enhance", scriptItems: [{ index: 0 }] }),
    });
    expect(staleApply.status).toBe(409);
    expect(await staleApply.json()).toEqual({ code: "DIRECTOR_PROPOSAL_STALE" });
    expect(state.script).toBe("并发修改后的剧本第一段。\n\n并发修改后的第二段。");
  });

  it("propose_enhancement chat tool endsTurn before any generation submission", async () => {
    const previewGeneration = vi.fn();
    const createdProposal: ComicDirectorProposal = {
      id: "dddddddd-1111-4111-8111-111111111111",
      conversationId: convId,
      baseRevision: 1,
      createdAt: new Date().toISOString(),
      input: {
        requestId: "eeeeeeee-1111-4111-8111-111111111111",
        expectedRevision: 1,
        mode: "paste",
        language: "zh",
        text: "增强第 1 镜运镜",
        action: "enhance",
        enhance: { scope: "clips", clipIds: [clipA] },
      },
      original: "",
      status: "ready",
      appliedRevision: null,
      proposal: { script: "", roles: [] },
    };
    const tools = createComicDirectorTools(ownerId, seriesId, {
      episodes: {
        get: vi.fn(async () => ({
          series: {
            id: seriesId, parentId: null, title: "T", logline: "", seriesGroup: null, episodeNo: 1,
            styleKey: "thick_painting", aspectRatio: "9:16" as const, videoModel: "doubao-seedance-2-5", revision: 1, archivedAt: null,
          },
          script: { version: 1, content: "第一段" },
          cast: [],
          clips: [{
            id: clipA, revision: 1, selectionRevision: 1, ordinal: 1,
            draft: {
              schemaVersion: 1 as const, durationMs: 4000, scene: "街头",
              shots: [{ id: shot1, framingKey: "wide", movementKey: "fixed", description: "原描述", durationShare: 100 }],
              lines: [],
            },
          }],
        })),
        saveClip: vi.fn(),
        reorder: vi.fn(),
      },
      library: { listCharacters: vi.fn(), listMaterials: vi.fn() },
      previewGeneration,
    }, {
      expectedRevision: 1,
      createProposal: vi.fn(async () => createdProposal),
    });

    const outcome = await tools.execute("propose_enhancement", { scope: "clips", clipOrdinals: [1], instruction: "增强运镜" });
    expect(outcome.ok).toBe(true);
    expect(outcome.endsTurn).toBe(true);
    expect(outcome.proposal?.id).toBe(createdProposal.id);
    expect(previewGeneration).not.toHaveBeenCalled();
  });
});
