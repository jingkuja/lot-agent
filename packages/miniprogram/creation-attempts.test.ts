import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginAttempt, listAttempts, updateAttempt, removeAttempt, queueRetry, takeRetry } from "./miniprogram/services/creation-attempts";
let owner = "u1";
let storage: Record<string, any>;
beforeEach(() => {
  owner = "u1"; storage = {};
  vi.stubGlobal("getApp", () => ({ globalData: { user: { id: owner } } }));
  vi.stubGlobal("wx", { getStorageSync: (key: string) => storage[key], setStorageSync: (key: string, value: unknown) => { storage[key] = structuredClone(value); } });
});
afterEach(() => vi.unstubAllGlobals());
it("retains separate failed drafts and isolates late updates by account", () => {
  const first = beginAttempt("image", { prompt: "第一张", size: "1024x1024", quality: "auto", refs: ["ref"] });
  const second = beginAttempt("image", { prompt: "第二张", size: "1024x1536", quality: "high", refs: [] });
  owner = "u2";
  updateAttempt(first, { status: "failed", conversationId: "c1" });
  expect(listAttempts()).toEqual([]);
  owner = "u1";
  expect(listAttempts()).toHaveLength(2);
  expect(listAttempts().find(x => x.id === first.id)).toMatchObject({ status: "failed", draft: { prompt: "第一张", refs: ["ref"] } });
  removeAttempt(first.id);
  expect(listAttempts().map(x => x.id)).toEqual([second.id]);
});
it("hands a failed draft to its creation page once, without exposing it to another account", () => {
  const attempt = beginAttempt("video", { script: "镜头", durationSec: 8 });
  updateAttempt(attempt, { status: "failed" });
  queueRetry(listAttempts()[0]);
  owner = "u2"; expect(takeRetry("video")).toBeNull();
  owner = "u1"; expect(takeRetry("image")).toBeNull();
  expect(takeRetry("video")?.draft).toMatchObject({ script: "镜头", durationSec: 8 });
  expect(takeRetry("video")).toBeNull();
});
it("never resurrects a deleted attempt after a late update", () => {
  const attempt = beginAttempt("image", { prompt: "图" });
  removeAttempt(attempt.id);
  updateAttempt(attempt, { status: "failed" });
  expect(listAttempts()).toEqual([]);
});
