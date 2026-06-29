import { describe, it, expect } from "vitest";
import { MEMORY_POLICY_PROMPT, hasMemoryTools } from "./policy.js";

describe("hasMemoryTools", () => {
  it("true when undefined (all tools allowed)", () => {
    expect(hasMemoryTools(undefined)).toBe(true);
  });
  it("true when a memory tool is whitelisted", () => {
    expect(hasMemoryTools(["web_fetch", "memory_write"])).toBe(true);
  });
  it("false when no memory tool present", () => {
    expect(hasMemoryTools(["web_fetch", "create_document"])).toBe(false);
  });
  it("false for an empty whitelist", () => {
    expect(hasMemoryTools([])).toBe(false);
  });
});

describe("MEMORY_POLICY_PROMPT", () => {
  it("mentions all three tiers and the delete tool", () => {
    expect(MEMORY_POLICY_PROMPT).toContain("user");
    expect(MEMORY_POLICY_PROMPT).toContain("session");
    expect(MEMORY_POLICY_PROMPT).toContain("ephemeral");
    expect(MEMORY_POLICY_PROMPT).toContain("memory_delete");
  });
});
