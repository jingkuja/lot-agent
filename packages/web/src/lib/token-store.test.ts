import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTokenStoreForTest,
  clearToken,
  getToken,
  setToken,
} from "./token-store.js";

class FakeLocalStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

const TOKEN_KEY = "lot_token";

describe("token-store", () => {
  let storage: FakeLocalStorage;

  beforeEach(() => {
    storage = new FakeLocalStorage();
    vi.stubGlobal("localStorage", storage);
    __resetTokenStoreForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).window;
    __resetTokenStoreForTest();
  });

  it("round-trips through localStorage in the browser (no bridge)", () => {
    expect(getToken()).toBeNull();
    setToken("abc");
    expect(getToken()).toBe("abc");
    expect(storage.getItem(TOKEN_KEY)).toBe("abc");
    clearToken();
    expect(getToken()).toBeNull();
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("serves reads from memory after the first localStorage read", () => {
    storage.setItem(TOKEN_KEY, "seeded");
    expect(getToken()).toBe("seeded");
    // Mutating the backing store afterwards must not affect the cached value.
    storage.setItem(TOKEN_KEY, "changed");
    expect(getToken()).toBe("seeded");
  });

  it("delegates to the desktop bridge when present", () => {
    const bridge = {
      getToken: vi.fn(() => "secure-token"),
      setToken: vi.fn(),
    };
    (globalThis as Record<string, unknown>).window = {
      lotDesktop: bridge,
    };

    expect(getToken()).toBe("secure-token");
    expect(bridge.getToken).toHaveBeenCalledTimes(1);

    setToken("new-token");
    expect(bridge.setToken).toHaveBeenCalledWith("new-token");
    // localStorage must not be touched on desktop.
    expect(storage.getItem(TOKEN_KEY)).toBeNull();

    clearToken();
    expect(bridge.setToken).toHaveBeenCalledWith(null);
    expect(getToken()).toBeNull();
  });

  it("re-reads from the bridge after a test reset", () => {
    let stored: string | null = "initial";
    (globalThis as Record<string, unknown>).window = {
      lotDesktop: {
        getToken: () => stored,
        setToken: (t: string | null) => {
          stored = t;
        },
      },
    };
    expect(getToken()).toBe("initial");
    setToken("updated");
    __resetTokenStoreForTest();
    expect(getToken()).toBe("updated");
  });
});
