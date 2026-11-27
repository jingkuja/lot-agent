import type { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import type { LLMProvider } from "@lot-agent/core";
import type { ComicCharacterVoiceDesignInput, ComicLibraryVoiceCreate } from "@lot-agent/core/comic-drama";
import type { ComicMediaLibrary } from "./media-library.js";
import { ComicVoices } from "./voices.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("claims one remote create per owner and request, then reconciles an uncertain result by prefix", async () => {
  const owner = "00000000-0000-4000-8000-000000000001";
  const input: ComicLibraryVoiceCreate = {
    id: "00000000-0000-4000-8000-000000000002", name: "Detective", kind: "design", language: "en",
    voicePrompt: "Soft-spoken, thoughtful and clear", previewText: "Wait here until the rain stops.",
  };
  const targetModel = "qwen-audio-3.0-tts-plus";
  vi.stubEnv("QWEN_VOICE_API_KEY", "test-key");
  vi.stubEnv("QWEN_VOICE_BASE_URL", "https://example.com/api/v1");
  vi.stubEnv("QWEN_VOICE_TARGET_MODEL", targetModel);
  const row = {
    ...input, previewMediaId: null, archived: false, status: "unknown", targetModel,
    credentialScope: "", prefix: "", voiceId: null as string | null,
  };
  const query = vi.fn(async (sql: string, params: string[]) => {
    if (params[0] !== owner) return { rows: [] };
    if (sql.startsWith("SELECT")) return { rows: row.prefix ? [row] : [] };
    if (sql.startsWith("INSERT")) {
      if (row.prefix) return { rowCount: 0 };
      row.credentialScope = params[7];
      row.prefix = params[8];
      return { rowCount: 1 };
    }
    row.voiceId = params[2];
    row.status = params[3];
    return { rowCount: 1 };
  });
  const fetcher = vi.fn(async (_url, init) => {
    const { action, prefix } = JSON.parse(init.body).input;
    if (action === "create_voice") throw new Error("response lost");
    return Response.json({ output: { voice_list: [{ voice_id: `${targetModel}-vd-${prefix}-a1b2`, status: "OK" }] } });
  });
  vi.stubGlobal("fetch", fetcher);
  const voices = new ComicVoices({ query } as unknown as Pool, { assertAvailable() {} } as ComicMediaLibrary);
  const signal = new AbortController().signal;
  const submit = () => voices.create(owner, input, undefined, signal, () => {});
  const pair = await Promise.all([submit(), submit()]);
  expect(pair.map(result => result.status)).toEqual(["unknown", "unknown"]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith("https://example.com/api/v1/services/audio/tts/customization", expect.objectContaining({
    headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
    body: expect.stringContaining(`"target_model":"${targetModel}"`),
  }));
  await expect(voices.refresh(input.id, input.id, signal)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const refreshed = await voices.refresh(owner, input.id, signal);
  expect(refreshed).toMatchObject({ status: "OK", id: input.id });
  expect(refreshed).not.toHaveProperty("voiceId");
  expect(await voices.ready(owner, input.id, false)).toEqual({ targetModel, voiceId: `${targetModel}-vd-${row.prefix}-a1b2` });
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init.body).input.action)).toEqual(["create_voice", "list_voice"]);
  await expect(submit()).resolves.toMatchObject({ status: "OK" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("validates AI voice traits, enrolls a real voice once, and returns its ID to the owner", async () => {
  const owner = "00000000-0000-4000-8000-000000000001";
  const id = "00000000-0000-4000-8000-000000000002";
  const input: ComicCharacterVoiceDesignInput = {
    id, language: "en", character: { name: "Lily", gender: "female", age: "22", roleKey: "lead", tags: [], personality: "Reserved", appearance: "" },
  };
  const targetModel = "qwen-audio-3.0-tts-plus";
  vi.stubEnv("QWEN_VOICE_API_KEY", "test-key");
  vi.stubEnv("QWEN_VOICE_BASE_URL", "https://example.com/api/v1");
  vi.stubEnv("QWEN_VOICE_TARGET_MODEL", targetModel);
  const row = { id, kind: "design", name: "Lily", status: "unknown", prefix: "", voiceId: null as string | null, previewMediaId: null };
  const query = vi.fn(async (sql: string, args: string[]) => {
    if (args[0] !== owner || args[1] !== id) return { rows: [] };
    if (sql.startsWith("SELECT")) return { rows: row.prefix ? [row] : [] };
    if (sql.startsWith("INSERT")) Object.assign(row, { credentialScope: args[7], prefix: args[8], targetModel });
    if (sql.startsWith("UPDATE")) Object.assign(row, { voiceId: args[2], status: args[3] ?? "DEPLOYING" });
    return { rowCount: 1 };
  });
  const fetcher = vi.fn(async (_url, init) => {
    const { action, voice_id, prefix } = JSON.parse(init.body).input;
    return Response.json({ output: action === "query_voice"
      ? { voice_id, status: "OK", target_model: targetModel } : { voice_id: `${targetModel}-vd-${prefix}-created` } });
  });
  vi.stubGlobal("fetch", fetcher);
  let modelReply = { voiceId: "fictional-model-id" } as Record<string, string>;
  const chat = vi.fn<LLMProvider["chat"]>(async function* () {
    yield { type: "text", content: JSON.stringify(modelReply) };
    yield { type: "done", finishReason: "stop" };
  });
  const resolveModel = vi.fn(async () => ({ llm: { chat }, modelIds: ["model"], usedModelId: "model" }));
  const signal = new AbortController().signal;
  const voices = new ComicVoices({ query } as unknown as Pool, { assertAvailable() {} } as ComicMediaLibrary);
  const design = () => voices.designCharacter(owner, input, signal, () => {}, resolveModel);
  await expect(design()).rejects.toMatchObject({ code: "COMIC_CHARACTER_VOICE_DESIGN_FAILED" });
  expect(fetcher).not.toHaveBeenCalled();
  modelReply = { pitch: "Mid-low", pace: "Unhurried", timbre: "Airy", delivery: "Quiet but clear", previewText: "Stay until the rain stops, will you?" };
  const created = await design();
  expect(resolveModel).toHaveBeenCalledWith(owner);
  expect(chat.mock.calls[1][0][1].content).toContain('"gender":"female"');
  expect(chat.mock.calls[1][2]?.params?.responseFormat).toBe("json_object");
  expect(created).toMatchObject({ id, status: "DEPLOYING", voiceId: `${targetModel}-vd-${row.prefix}-created` });
  expect(JSON.parse(fetcher.mock.calls[0][1].body).input).toMatchObject({
    action: "create_voice", voice_prompt: "Female voice, Mid-low, Unhurried, Airy, Quiet but clear", preview_text: modelReply.previewText,
  });
  await expect(voices.refreshCharacterDesign(id, id, signal)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(voices.refreshCharacterDesign(owner, id, signal)).resolves.toMatchObject({ voiceId: created.voiceId, status: "OK" });
  await expect(design()).resolves.toMatchObject({ voiceId: created.voiceId, status: "OK" });
  expect(resolveModel).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
