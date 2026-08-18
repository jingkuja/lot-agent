import { describe, expect, it, vi } from "vitest";
import { SecretBox } from "../auth/secret-box.js";
import { DigitalEmployeeService } from "./service.js";

function serviceWith(repository: Record<string, unknown>, db: Record<string, unknown> = {}) {
  const service = new DigitalEmployeeService({ pool: {}, ...db } as any, new SecretBox());
  (service as any).repository = repository;
  return service;
}

function draft(row: any) {
  return {
    ...row,
    operation: row.operation,
    status: row.status,
    risks: row.risks,
  };
}

describe("DigitalEmployeeService profile changes", () => {
  it("allows a unique low-risk create to commit in the same agent turn", async () => {
    const service = serviceWith({
      findProfilesByExactMention: vi.fn(async () => []),
      createProfileChangeDraft: vi.fn(async (row) => draft(row)),
    });
    const result = await service.prepareProfileChange(
      "u1",
      { operation: "create", displayName: "李静", customerRegion: "深圳南山区" },
      { sourceMessageId: "00000000-0000-0000-0000-000000000001" }
    );
    expect(result.status).toBe("ready");
    expect(result.risks).toEqual([]);
  });

  it("never treats a single fuzzy candidate as authorization to update", async () => {
    const service = serviceWith({
      findProfilesByExactMention: vi.fn(async () => []),
      listProfiles: vi.fn(async () => ({
        items: [{
          id: "00000000-0000-0000-0000-000000000002",
          displayName: "李静",
          customerRegion: "深圳南山区",
          version: 3,
        }],
        total: 1,
      })),
      createProfileChangeDraft: vi.fn(async (row) => draft(row)),
    });
    const result = await service.prepareProfileChange(
      "u1",
      { operation: "update", customerMention: "李姐", tags: ["重点客户"] },
      { sourceMessageId: "00000000-0000-0000-0000-000000000003" }
    );
    expect(result.status).toBe("needs_confirmation");
    expect(result.risks).toContain("identity_ambiguous");
    expect(result.options).toEqual(["李静（深圳南山区）"]);
  });

  it("resolves a pronoun only through the user-scoped conversation context", async () => {
    const findProfilesByExactMention = vi.fn();
    const service = serviceWith({
      findProfilesByExactMention,
      getProfile: vi.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000002",
        displayName: "李静",
        customerRegion: "深圳南山区",
        status: "active",
        version: 4,
      })),
      createProfileChangeDraft: vi.fn(async (row) => draft(row)),
    }, {
      getConversationCustomerContext: vi.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000002",
        displayName: "李静",
      })),
    });
    const result = await service.prepareProfileChange(
      "u1",
      { operation: "update", customerMention: "她", tags: ["重点客户"] },
      { conversationId: "00000000-0000-0000-0000-000000000010" }
    );
    expect(result.status).toBe("ready");
    expect(findProfilesByExactMention).not.toHaveBeenCalled();
  });
});
