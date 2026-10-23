import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HttpQwenVoiceProvider, ProviderError, QwenVoiceError, type QwenVoiceProvider, type SpeechProvider, type TwinVoiceRecord, type TwinVoiceScope, type TwinVoiceStore } from "@lot-agent/core";
import { KnowledgeError } from "../knowledge/errors.js";
import { createKnowledgeManageRoutes } from "../knowledge/routes.js";
import type { KnowledgeRepository } from "../knowledge/repository.js";
import type { PrivateKnowledgeStorage } from "@lot-agent/core";
import { TwinVoices, UNCONFIRMED_CREATE_RELEASE_MS, loadTwinVoiceConfig } from "./voices.js";

const id = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture() {
  const rows = new Map<string, TwinVoiceRecord>();
  const claimedAt = new Map<string, number>();
  const key = (s: TwinVoiceScope) => JSON.stringify(s);
  const store: TwinVoiceStore = {
    get: vi.fn(async s => rows.get(key(s)) ?? null),
    claim: vi.fn(async (s, record) => {
      const old = rows.get(key(s));
      if (old) return { created: false, record: old };
      rows.set(key(s), { ...record }); claimedAt.set(key(s), Date.now()); return { created: true, record: { ...record } };
    }),
    save: vi.fn(async (s, record) => { rows.set(key(s), { ...record }); }),
    release: vi.fn(async (s, record, options) => {
      const old = rows.get(key(s));
      if (!old || old.prefix !== record.prefix || old.voiceId || old.status !== "unknown") return false;
      if (options?.olderThanMs !== undefined && Date.now() - claimedAt.get(key(s))! < options.olderThanMs) return false;
      return rows.delete(key(s));
    }),
  };
  const repository = {
    getItem: vi.fn(async (owner: string) => {
      if (owner !== "owner") throw new KnowledgeError("NOT_FOUND", 404, "不存在");
      return { id, revisionId, sourceType: "audio", tags: ["digital-twin:voice"] };
    }),
    getFile: vi.fn(async () => ({ key: "private/key", mime: "audio/wav", size: 100 })),
    createPreviewTicket: vi.fn(async () => ({ token: "temporary-ticket" })),
  };
  const provider: QwenVoiceProvider = {
    create: vi.fn(async () => "qwen-voice-1"),
    query: vi.fn(async voiceId => ({ voiceId, status: "OK" as const })),
    find: vi.fn(async () => null),
  };
  const config = { baseUrl: "https://qwen.example/api/v1", apiKey: "secret", targetModel: "qwen-audio-3.0-tts-plus" };
  const speechProvider: SpeechProvider = { synthesize: vi.fn(async () => ({ audio: new Uint8Array([9, 8]), mime: "audio/mpeg" })) };
  const speech = {
    apiKey: vi.fn(async (owner: string) => owner === "owner" ? "user-key" : null),
    baseUrl: () => "https://gateway.example/v1",
    provider: vi.fn(() => speechProvider),
  };
  const deps = {
    repository: repository as unknown as KnowledgeRepository,
    storage: { localPath: vi.fn(() => "/private/sample.wav") }, store, config: () => config, provider: () => provider,
    publicBaseUrl: () => "https://public.example", validateUrl: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ audio: true, duration: 10 })) as never, speech,
  };
  const service = new TwinVoices(deps);
  const enroll = () => service.enroll("owner", id, "session-token");
  return { rows, repository, provider, config, deps, store, service, enroll, speech, speechProvider };
}

describe("digital twin enrollment lifecycle", () => {
  it("claims before create, saves model/voice, then queries readiness without another creation", async () => {
    const f = fixture();
    expect(await f.enroll()).toEqual({ targetModel: f.config.targetModel, voiceId: "qwen-voice-1", status: "DEPLOYING" });
    expect(vi.mocked(f.store.claim).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.provider.create).mock.invocationCallOrder[0]);
    expect(f.provider.create).toHaveBeenCalledWith({ url: "https://public.example/api/rag/preview/temporary-ticket", prefix: expect.stringMatching(/^[a-f0-9]{10}$/) }, undefined);
    expect(f.repository.createPreviewTicket).toHaveBeenCalledWith("owner", "session-token", id, revisionId);
    expect(await f.enroll()).toMatchObject({ status: "OK" });
    await f.enroll();
    expect(f.provider.create).toHaveBeenCalledOnce(); expect(f.provider.query).toHaveBeenCalledOnce();
    expect(await f.service.get("owner", id)).not.toHaveProperty("credentialScope");
  });
  it("recovers an uncertain write only by its original prefix, including across service instances", async () => {
    const f = fixture(); vi.mocked(f.provider.create).mockRejectedValueOnce(new Error("lost response"));
    await expect(f.enroll()).rejects.toThrow("lost response");
    expect(await f.service.get("owner", id)).toMatchObject({ status: "unknown", voiceId: null });
    await new TwinVoices(f.deps).enroll("owner", id, "session-token");
    expect(f.provider.create).toHaveBeenCalledOnce();
    expect(f.provider.find).toHaveBeenCalledWith([...f.rows.values()][0].prefix, undefined);
    vi.mocked(f.provider.find).mockResolvedValueOnce({ voiceId: "recovered", status: "OK" });
    expect(await f.enroll()).toMatchObject({ voiceId: "recovered", status: "OK" });
    expect(f.provider.create).toHaveBeenCalledOnce();
  });
  it("releases the claim after an explicit refusal so enrollment can start over", async () => {
    const f = fixture();
    vi.mocked(f.provider.create).mockRejectedValueOnce(new ProviderError("qwen-voice", "create", "HTTP_ERROR", { httpStatus: 400 }));
    await expect(f.enroll()).rejects.toMatchObject({ httpStatus: 400 });
    expect(await f.service.get("owner", id)).toBeNull();
    expect(await f.enroll()).toMatchObject({ voiceId: "qwen-voice-1", status: "DEPLOYING" });
    expect(f.provider.create).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(f.provider.create).mock.calls.map(([input]) => input.prefix);
    expect(first).not.toBe(second);
  });
  it.each([
    new ProviderError("qwen-voice", "create", "HTTP_ERROR", { httpStatus: 502 }),
    new ProviderError("qwen-voice", "create", "TRANSPORT_ERROR"),
    new ProviderError("qwen-voice", "create", "INVALID_RESPONSE", { httpStatus: 200 }),
  ])("keeps uncertain create outcomes for read-only recovery (%#)", async (error) => {
    const f = fixture(); vi.mocked(f.provider.create).mockRejectedValueOnce(error);
    await expect(f.enroll()).rejects.toBe(error);
    expect(await f.service.get("owner", id)).toMatchObject({ status: "unknown", voiceId: null });
    expect(f.store.release).not.toHaveBeenCalled();
  });
  it("frees an unconfirmed create only after the vendor still lists nothing past the release age", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    vi.mocked(f.provider.create).mockRejectedValueOnce(new QwenVoiceError("create", "HTTP_ERROR", { httpStatus: 500, vendorCode: "InternalError" }));
    await expect(f.enroll()).rejects.toMatchObject({ httpStatus: 500 });
    expect(await f.enroll()).toMatchObject({ status: "unknown", voiceId: null });
    vi.setSystemTime(Date.now() + UNCONFIRMED_CREATE_RELEASE_MS);
    await expect(f.enroll()).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(await f.service.get("owner", id)).toBeNull();
    expect(f.provider.create).toHaveBeenCalledOnce();
    expect(await f.enroll()).toMatchObject({ voiceId: "qwen-voice-1", status: "DEPLOYING" });
    expect(f.provider.create).toHaveBeenCalledTimes(2);
  });
  it("adopts a late-listed voice instead of releasing its claim", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture(); vi.mocked(f.provider.create).mockRejectedValueOnce(new Error("lost response"));
    await expect(f.enroll()).rejects.toThrow("lost response");
    vi.setSystemTime(Date.now() + UNCONFIRMED_CREATE_RELEASE_MS);
    vi.mocked(f.provider.find).mockResolvedValueOnce({ voiceId: "late", status: "DEPLOYING" });
    expect(await f.enroll()).toMatchObject({ voiceId: "late", status: "DEPLOYING" });
    expect(f.store.release).not.toHaveBeenCalled();
  });
  it("keeps the received ID when a subsequent query fails", async () => {
    const f = fixture(); await f.enroll(); vi.mocked(f.provider.query).mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.enroll()).rejects.toThrow("unavailable");
    expect(await f.service.get("owner", id)).toMatchObject({ voiceId: "qwen-voice-1", status: "DEPLOYING" });
    expect(f.provider.create).toHaveBeenCalledOnce();
  });
  it("concurrent requests issue one remote create", async () => {
    const f = fixture(); await Promise.all([f.enroll(), f.enroll()]); expect(f.provider.create).toHaveBeenCalledOnce();
  });
  it("rejects changed credentials or target models before adopting a checkpoint", async () => {
    const f = fixture(); await f.enroll();
    for (const config of [{ ...f.config, apiKey: "different" }, { ...f.config, targetModel: "other-model" }]) {
      await expect(new TwinVoices({ ...f.deps, config: () => config }).enroll("owner", id, "token")).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(f.provider.query).not.toHaveBeenCalled(); expect(f.provider.find).not.toHaveBeenCalled();
  });
  it("denies foreign owners and non-voice items before any vendor call", async () => {
    const f = fixture();
    await expect(f.service.enroll("other", id, "token")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.service.get("other", id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    f.repository.getItem.mockResolvedValueOnce({ id, revisionId, sourceType: "audio", tags: [] });
    await expect(f.enroll()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.store.claim).not.toHaveBeenCalled(); expect(f.provider.create).not.toHaveBeenCalled();
  });
  it("fails local media, public URL and session preflight before persisting write intent", async () => {
    const f = fixture();
    vi.mocked(f.deps.inspect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ audio: true, duration: 16 });
    await expect(f.enroll()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    f.deps.validateUrl.mockRejectedValueOnce(new Error("SSRF blocked"));
    await expect(f.enroll()).rejects.toThrow("SSRF blocked");
    f.repository.createPreviewTicket.mockRejectedValueOnce(new KnowledgeError("UNAUTHORIZED", 401, "session expired"));
    await expect(f.enroll()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(f.store.claim).not.toHaveBeenCalled(); expect(f.provider.create).not.toHaveBeenCalled();
  });
  it("retains rejected enrollment state and never resubmits it", async () => {
    const f = fixture(); await f.enroll(); vi.mocked(f.provider.query).mockResolvedValueOnce({ voiceId: "qwen-voice-1", status: "UNDEPLOYED" });
    expect(await f.enroll()).toMatchObject({ status: "UNDEPLOYED" }); await f.enroll();
    expect(f.provider.create).toHaveBeenCalledOnce(); expect(f.provider.query).toHaveBeenCalledOnce();
  });
  it("does not use a missing dedicated key or cancelled request", async () => {
    const f = fixture(); f.config.apiKey = "";
    await expect(f.enroll()).rejects.toThrow("声音复刻服务尚未配置");
    f.config.apiKey = "secret"; const abort = new AbortController(); abort.abort();
    await expect(f.service.enroll("owner", id, "token", abort.signal)).rejects.toThrow();
    expect(f.store.claim).not.toHaveBeenCalled(); expect(f.provider.create).not.toHaveBeenCalled();
  });
});

describe("digital twin speech", () => {
  it("synthesizes with the stored model and voice using the owner's gateway key", async () => {
    const f = fixture(); await f.enroll(); await f.enroll();
    expect(await f.service.speak("owner", id, { text: "欢迎", speed: 1.1 })).toEqual({ audio: new Uint8Array([9, 8]), mime: "audio/mpeg" });
    expect(f.speech.apiKey).toHaveBeenCalledWith("owner");
    expect(f.speech.provider).toHaveBeenCalledWith({ baseUrl: "https://gateway.example/v1", apiKey: "user-key" });
    expect(f.speechProvider.synthesize).toHaveBeenCalledWith({ model: f.config.targetModel, text: "欢迎", voice: "qwen-voice-1", format: "mp3", speed: 1.1, instructions: undefined }, undefined);
  });
  it("refuses voices that are not ready, foreign owners and missing user keys before any billed call", async () => {
    const f = fixture();
    await expect(f.service.speak("owner", id, { text: "x" })).rejects.toMatchObject({ code: "CONFLICT" });
    await f.enroll();
    await expect(f.service.speak("owner", id, { text: "x" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.service.speak("other", id, { text: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.enroll(); f.speech.apiKey.mockResolvedValueOnce(null);
    await expect(f.service.speak("owner", id, { text: "x" })).rejects.toMatchObject({ code: "KNOWLEDGE_UNAVAILABLE" });
    expect(f.speechProvider.synthesize).not.toHaveBeenCalled();
  });
});

describe("authenticated enrollment routes", () => {
  function app(owner?: string) {
    const f = fixture(); const root = new Hono<{ Variables: { userId: string } }>();
    if (owner) root.use("*", async (c, next) => { c.set("userId", owner); await next(); });
    root.route("/", createKnowledgeManageRoutes(f.repository as unknown as KnowledgeRepository, {} as PrivateKnowledgeStorage, undefined, undefined, f.service));
    return { ...f, app: root };
  }
  it("requires authentication, ownership and valid item IDs", async () => {
    expect((await app().app.request(`/items/${id}/voice`, { method: "POST" })).status).toBe(401);
    expect((await app("other").app.request(`/items/${id}/voice`, { method: "POST" })).status).toBe(404);
    expect((await app("owner").app.request("/items/invalid/voice", { method: "POST" })).status).toBe(400);
  });
  it("logs a refused enrollment with a correlation ID without blaming the sample", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = app("owner");
    vi.mocked(f.provider.create).mockRejectedValueOnce(new ProviderError("qwen-voice", "create", "TASK_FAILED", { httpStatus: 200 }));
    const refused = await f.app.request(`/items/${id}/voice`, { method: "POST" });
    const body: any = await refused.json();
    expect(refused.status).toBe(503); expect(body).toMatchObject({ error: { message: "千问未接受本次声音复刻，请联系管理员查看错误原因" } });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({ itemId: id, requestId: body.request_id, outcome: "rejected", httpStatus: 200 });
    expect(await (await f.app.request(`/items/${id}/voice`)).json()).toEqual({ voice: null });
  });
  it.each([
    [401, undefined, "鉴权或权限不足"],
    [403, undefined, "鉴权或权限不足"],
    [200, "InvalidApiKey", "鉴权或权限不足"],
    [400, "Arrearage", "账号额度不足"],
    [403, "Arrearage", "账号额度不足"],
    [429, undefined, "请求受限"],
    [200, "Throttling", "请求受限"],
    [400, "BadRequest.InputDownloadFailed", "无法下载声音样例"],
    [400, "Audio.PreprocessError", "未能处理声音样例"],
    [400, "Audio.AudioRateError", "未能处理声音样例"],
    [400, "InvalidParameter", "查看错误原因"],
    [502, "Audio.PreprocessError", "刷新音色状态核实"],
    [408, undefined, "刷新音色状态核实"],
  ])("classifies HTTP %s / %s and preserves recovery semantics", async (httpStatus, vendorCode, message) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = app("owner");
    vi.mocked(f.provider.create).mockRejectedValueOnce(new QwenVoiceError("create", httpStatus === 200 ? "TASK_FAILED" : "HTTP_ERROR", { httpStatus, vendorCode }));
    const result = await f.app.request(`/items/${id}/voice`, { method: "POST" });
    expect(result.status).toBe(503);
    expect((await result.json() as any).error.message).toContain(message);
    expect(f.provider.create).toHaveBeenCalledOnce();
    if (httpStatus === 502 || httpStatus === 408) {
      expect(f.store.release).not.toHaveBeenCalled();
      expect(await f.service.get("owner", id)).toMatchObject({ status: "unknown" });
    } else expect(await f.service.get("owner", id)).toBeNull();
  });
  it("logs real provider failures safely, including read-only recovery failures", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = app("owner");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({
      code: "BadRequest.InputDownloadFailed", request_id: "req-abcdef123456",
      message: "secret session-token temporary-ticket https://private.example/audio.wav",
    }, { status: 400 })).mockRejectedValueOnce(new Error("secret session-token"));
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(f.provider.create).mockImplementationOnce((input, signal) => new HttpQwenVoiceProvider(f.config).create(input, signal));
    const result = await f.app.request(`/items/${id}/voice`, { method: "POST", headers: { Authorization: "Bearer session-token" } });
    const body: any = await result.json();
    expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({
      requestId: body.request_id, upstreamRequestId: "req-abcdef123456",
      vendorCode: "BadRequest.InputDownloadFailed", phase: "create", httpStatus: 400,
    });
    await f.enroll();
    vi.mocked(f.provider.query).mockImplementationOnce((voiceId, signal) => new HttpQwenVoiceProvider(f.config).query(voiceId, signal));
    const poll = await f.app.request(`/items/${id}/voice`, { method: "POST" });
    expect((await poll.json() as any).error.message).toContain("刷新音色状态核实");
    expect(JSON.parse(log.mock.calls[1][1])).toMatchObject({ phase: "poll", code: "TRANSPORT_ERROR", outcome: "unconfirmed" });
    expect(JSON.stringify(log.mock.calls) + JSON.stringify(body)).not.toMatch(/secret|session-token|temporary-ticket|private.example/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("reads persisted state without vendor I/O and ignores caller-supplied model/url/owner", async () => {
    const f = app("owner");
    const read = await f.app.request(`/items/${id}/voice`); expect(await read.json() as any).toEqual({ voice: null }); expect(f.provider.create).not.toHaveBeenCalled();
    const result = await f.app.request(`/items/${id}/voice`, { method: "POST", headers: { Authorization: "Bearer session-token" }, body: JSON.stringify({ ownerId: "other", target_model: "wrong", url: "http://localhost/private" }) });
    expect(result.status).toBe(200); expect(await result.json() as any).toMatchObject({ voice: { targetModel: f.config.targetModel, status: "DEPLOYING" } });
    expect(await (await f.app.request(`/items/${id}/voice`)).json()).toMatchObject({ voice: { voiceId: "qwen-voice-1" } });
  });
  it("returns synthesized audio and ignores caller-supplied model or voice", async () => {
    const f = app("owner"); await f.enroll(); await f.enroll();
    const speak = (body: unknown) => f.app.request(`/items/${id}/voice/speech`, { method: "POST", body: JSON.stringify(body) });
    expect((await speak({ text: "你好", voice: "other", model: "x" })).status).toBe(400);
    expect((await speak({ text: "" })).status).toBe(400);
    expect((await speak({ text: "a".repeat(501) })).status).toBe(400);
    const ok = await speak({ text: " 你好 ", instructions: "温柔" });
    expect(ok.status).toBe(200); expect(ok.headers.get("content-type")).toBe("audio/mpeg"); expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([9, 8]));
    expect(f.speechProvider.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: "你好", voice: "qwen-voice-1", model: "qwen-audio-3.0-tts-plus", instructions: "温柔" }), expect.anything());
    vi.mocked(f.speechProvider.synthesize).mockRejectedValueOnce(new ProviderError("speech", "create", "HTTP_ERROR", { httpStatus: 403 }));
    const denied = await speak({ text: "你好" });
    expect(denied.status).toBe(402); expect(JSON.stringify(await denied.json())).not.toContain("HTTP 403");
    expect((await app("other").app.request(`/items/${id}/voice/speech`, { method: "POST", body: JSON.stringify({ text: "x" }) })).status).toBe(404);
  });
});

it("defaults to independent Qwen settings", () => {
  vi.stubEnv("QWEN_VOICE_BASE_URL", ""); vi.stubEnv("QWEN_VOICE_API_KEY", ""); vi.stubEnv("QWEN_VOICE_TARGET_MODEL", "");
  vi.stubEnv("KLING_VOICE_API_KEY", "tencent-key"); vi.stubEnv("OPENAI_API_KEY", "llm-key");
  try { expect(loadTwinVoiceConfig()).toEqual({ baseUrl: "https://maas.qianwenaiapi.com/api/v1", apiKey: "", targetModel: "qwen-audio-3.0-tts-plus" }); }
  finally { vi.unstubAllEnvs(); }
});
