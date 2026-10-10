import { describe, expect, it, vi } from "vitest";
import type { KlingVoiceCheckpoint, KlingVoiceProvider, KlingVoiceScope, KlingVoiceStore } from "@lot-agent/core";
import { KlingVoicePreparation } from "./kling-voices.js";

function setup() {
  const rows = new Map<string, KlingVoiceCheckpoint & { fingerprint: string }>();
  const key = (scope: KlingVoiceScope) => `${scope.userId}/${scope.taskId}/${scope.slot}`;
  const store: KlingVoiceStore = {
    claim: vi.fn(async (scope, externalTaskId) => {
      const existing = rows.get(key(scope));
      if (existing && existing.fingerprint !== scope.fingerprint) throw new Error("scope changed");
      const row = existing ?? { externalTaskId, fingerprint: scope.fingerprint };
      rows.set(key(scope), row);
      return { created: !existing, checkpoint: { ...row } };
    }),
    save: vi.fn(async (scope, result) => {
      Object.assign(rows.get(key(scope))!, result);
    }),
  };
  const provider: KlingVoiceProvider = {
    create: vi.fn<KlingVoiceProvider["create"]>(async () => ({ taskId: "voice-task-1", status: "submitted" })),
    poll: vi.fn<KlingVoiceProvider["poll"]>(async () => ({ taskId: "voice-task-1", status: "succeed", voiceId: "917124264959582304" })),
  };
  const deps = { provider, store, credentialScope: "user-key-scope", validateUrl: vi.fn(async () => {}), sleep: vi.fn(async () => {}) };
  const input = { userId: "u1", taskId: "video-task-1", referenceAudio: "https://media.example/a.wav", assertNotCancelled: vi.fn(async () => {}) };
  return { deps, input, service: new KlingVoicePreparation(deps) };
}

describe("Kling voice preparation", () => {
  it("persists before writing, polls every 2.5s and reuses the completed checkpoint", async () => {
    const { deps, input, service } = setup();
    const result = await service.prepare(input);
    expect(result).toBe("917124264959582304");
    expect(deps.store.claim).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", taskId: input.taskId, slot: 0 }), expect.any(String));
    expect(vi.mocked(deps.store.claim).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.provider.create).mock.invocationCallOrder[0]);
    expect(deps.sleep).toHaveBeenCalledWith(2500);
    expect(await service.prepare(input)).toBe(result);
    expect(deps.provider.create).toHaveBeenCalledOnce();
    expect(deps.provider.poll).toHaveBeenCalledOnce();
  });

  it("keeps generated names under 20 characters even for UUID task IDs", async () => {
    const { deps, input, service } = setup();
    await service.prepare({ ...input, taskId: "5aa59d26-4722-4169-90a7-15a32060922a" });
    const name = vi.mocked(deps.provider.create).mock.calls[0][0].voiceName;
    expect(name.length).toBeLessThanOrEqual(20);
    expect(name).toMatch(/^voice_[a-f0-9]+$/);
  });

  it("keeps a concrete upstream failure reason on the job error", async () => {
    const { deps, input, service } = setup();
    vi.mocked(deps.provider.poll).mockResolvedValueOnce({ taskId: "voice-task-1", status: "failed", error: "audio contains no clear speech" });
    await expect(service.prepare(input)).rejects.toThrow("audio contains no clear speech");
  });

  it("recovers an unknown POST outcome using external_task_id, without another write", async () => {
    const { deps, input, service } = setup();
    vi.mocked(deps.provider.create).mockRejectedValueOnce(new Error("network lost"));
    await expect(service.prepare(input)).rejects.toThrow("network lost");
    const externalId = vi.mocked(deps.provider.create).mock.calls[0][0].externalTaskId;
    expect(await service.prepare(input)).toBe("917124264959582304");
    expect(deps.provider.poll).toHaveBeenCalledWith(externalId, undefined);
    expect(deps.provider.create).toHaveBeenCalledOnce();
  });

  it("resumes a known task ID after a polling failure", async () => {
    const { deps, input, service } = setup();
    vi.mocked(deps.provider.poll).mockRejectedValueOnce(new Error("read failed"));
    await expect(service.prepare(input)).rejects.toThrow("read failed");
    await service.prepare(input);
    expect(deps.provider.poll).toHaveBeenLastCalledWith("voice-task-1", undefined);
    expect(deps.provider.create).toHaveBeenCalledOnce();
  });

  it("preserves audio ordering and the single-element array shape", async () => {
    const { deps, input, service } = setup();
    vi.mocked(deps.provider.create)
      .mockResolvedValueOnce({ taskId: "t1", status: "succeed", voiceId: "v1" })
      .mockResolvedValueOnce({ taskId: "t2", status: "succeed", voiceId: "v2" });
    expect(await service.prepare({ ...input, referenceAudio: [input.referenceAudio, "https://media.example/b.wav"] })).toEqual(["v1", "v2"]);
    expect(await service.prepare({ ...input, referenceAudio: [input.referenceAudio] })).toEqual(["v1"]);
  });

  it("does not share IDs between users or across credential changes", async () => {
    const { deps, input, service } = setup();
    await service.prepare(input);
    await service.prepare({ ...input, userId: "u2" });
    expect(deps.provider.create).toHaveBeenCalledTimes(2);
    await expect(new KlingVoicePreparation({ ...deps, credentialScope: "different-key" }).prepare(input)).rejects.toThrow("scope changed");
    expect(deps.provider.create).toHaveBeenCalledTimes(2);
  });

  it("validates the full batch before any paid write", async () => {
    const { deps, input, service } = setup();
    vi.mocked(deps.validateUrl).mockResolvedValueOnce().mockRejectedValueOnce(new Error("private address"));
    await expect(service.prepare({ ...input, referenceAudio: [input.referenceAudio, "http://127.0.0.1/a.wav"] })).rejects.toThrow("private address");
    expect(deps.provider.create).not.toHaveBeenCalled();
    expect(deps.store.claim).not.toHaveBeenCalled();
  });

  it.each([[], ["a", "b", "c"], ["/static/audio.wav"], ["https://user:pass@media.example/a.wav"]].map((urls) => ({ urls })))("rejects invalid audio input $urls", async ({ urls }) => {
    const { deps, input, service } = setup();
    await expect(service.prepare({ ...input, referenceAudio: urls })).rejects.toThrow();
    expect(deps.provider.create).not.toHaveBeenCalled();
  });

  it("uses the shared SSRF guard for private and non-HTTP audio URLs", async () => {
    const { deps, input } = setup();
    const service = new KlingVoicePreparation({ ...deps, validateUrl: undefined });
    for (const referenceAudio of ["http://127.0.0.1/a.wav", "http://[::1]/a.wav", "file:///tmp/a.wav"]) {
      await expect(service.prepare({ ...input, referenceAudio })).rejects.toThrow();
    }
    expect(deps.store.claim).not.toHaveBeenCalled();
    expect(deps.provider.create).not.toHaveBeenCalled();
  });

  it("stops polling and skips the next voice on cancellation", async () => {
    const { deps, input, service } = setup();
    deps.sleep.mockImplementation(async () => { input.assertNotCancelled.mockRejectedValue(new Error("cancelled")); });
    await expect(service.prepare({ ...input, referenceAudio: [input.referenceAudio, "https://media.example/b.wav"] })).rejects.toThrow("cancelled");
    expect(deps.provider.create).toHaveBeenCalledOnce();
    expect(deps.provider.poll).not.toHaveBeenCalled();
  });

  it("propagates failed voice tasks and bounds polling time", async () => {
    const { deps, input, service } = setup();
    vi.mocked(deps.provider.poll).mockResolvedValueOnce({ taskId: "voice-task-1", status: "failed" });
    await expect(service.prepare(input)).rejects.toThrow("音色创建失败");
    vi.mocked(deps.provider.poll).mockResolvedValue({ taskId: "voice-task-1", status: "processing" });
    await expect(new KlingVoicePreparation({ ...deps, maxWaitMs: 0 }).prepare(input)).rejects.toThrow("超时");
    expect(deps.provider.create).toHaveBeenCalledOnce();
  });
});
