import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSession, setSession, getStudioConversationId } from "./miniprogram/services/session";

const user = { id: "u1", name: "用户", username: "user", phone: null };
let storage: Map<string, unknown>;
let app: any;
beforeEach(() => {
  storage = new Map([["lot:user", user], ["lot:studioConversationId", "old-conversation"]]);
  app = { globalData: { user, pendingRefs: ["private.png"], posterJob: { id: "old" }, activeImageJob: { taskId: "old" } } };
  vi.stubGlobal("getApp", () => app);
  vi.stubGlobal("wx", {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("mini-program account isolation", () => {
  it("clears previous account drafts and active jobs when binding adopts another account", () => {
    setSession("new-token", { ...user, id: "u2" });
    expect(getStudioConversationId()).toBe("");
    expect(app.globalData).toMatchObject({ pendingRefs: [], posterJob: null, activeImageJob: null, user: { id: "u2" } });
  });
  it("preserves the draft when refreshing the same account", () => {
    setSession("refreshed-token", user);
    expect(getStudioConversationId()).toBe("old-conversation");
    expect(app.globalData.pendingRefs).toEqual(["private.png"]);
  });
  it("also clears private in-memory data on logout", () => {
    clearSession();
    expect(getStudioConversationId()).toBe("");
    expect(app.globalData).toMatchObject({ pendingRefs: [], posterJob: null, activeImageJob: null, user: null });
  });
});
