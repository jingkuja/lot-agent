import { describe, expect, it, vi } from "vitest";
import { PgMemoryAdapter } from "./pg-adapter.js";

const failing = (code: string) => Object.assign(new Error("failed"), { code });

describe("PgMemoryAdapter.init", () => {
  it.each(["23505", "42P07"])("carries on when another process created the table first (%s)", async (code) => {
    const query = vi.fn().mockRejectedValueOnce(failing(code)).mockResolvedValue({ rows: [] });
    await expect(new PgMemoryAdapter({ query }).init()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("still fails on anything else", async () => {
    const query = vi.fn().mockRejectedValue(failing("28P01"));
    await expect(new PgMemoryAdapter({ query }).init()).rejects.toThrow("failed");
  });
});
