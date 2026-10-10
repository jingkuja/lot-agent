import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgKlingVoiceStore } from "./kling-voice-store.js";

const scope = { taskId: "task-1", userId: "owner-1", slot: 0, fingerprint: "credential-and-url-hash" };
describe("PgKlingVoiceStore", () => {
  it("claims only an owned task and scopes lookups to owner, slot and fingerprint", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ external_task_id: "external-1" }] })
      .mockResolvedValueOnce({ rows: [{ external_task_id: "external-1", vendor_task_id: null, voice_id: null }] });
    const store = new PgKlingVoiceStore({ query } as unknown as Pool);
    expect(await store.claim(scope, "external-1")).toEqual({ created: true, checkpoint: { externalTaskId: "external-1" } });
    expect(query.mock.calls[0][0]).toContain("FROM tasks WHERE id=$1 AND user_id=$2");
    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (task_id, slot) DO NOTHING");
    expect(query.mock.calls[0][1]).toEqual([scope.taskId, scope.userId, 0, scope.fingerprint, "external-1"]);
    expect(query.mock.calls[1][0]).toContain("task_id=$1 AND user_id=$2 AND slot=$3 AND fingerprint=$4");
  });

  it("preserves existing IDs on a repeated claim instead of overwriting them", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ external_task_id: "original", vendor_task_id: "vendor-task", voice_id: "voice" }] });
    const store = new PgKlingVoiceStore({ query } as unknown as Pool);
    expect(await store.claim(scope, "new-external")).toEqual({ created: false, checkpoint: { externalTaskId: "original", vendorTaskId: "vendor-task", voiceId: "voice" } });
  });

  it("rejects nonexistent, foreign or changed-credential claims", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(new PgKlingVoiceStore({ query } as unknown as Pool).claim(scope, "external-1")).rejects.toThrow("归属或凭证");
  });

  it("guards writes by scope and refuses to replace a different vendor task", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(new PgKlingVoiceStore({ query } as unknown as Pool).save(scope, { vendorTaskId: "vendor-task", voiceId: "voice" })).rejects.toThrow("无法保存");
    expect(query.mock.calls[0][0]).toContain("task_id=$1 AND user_id=$2 AND slot=$3 AND fingerprint=$4");
    expect(query.mock.calls[0][0]).toContain("vendor_task_id IS NULL OR vendor_task_id=$5");
  });
});
