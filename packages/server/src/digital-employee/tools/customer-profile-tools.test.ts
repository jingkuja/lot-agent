import { describe, expect, it, vi } from "vitest";
import { createCustomerProfileTools } from "./customer-profile-tools.js";

function tool(name: string, service: Record<string, unknown>) {
  return createCustomerProfileTools(service as any).find((item) => item.name === name)!;
}

describe("customer profile agent tools", () => {
  it("keeps database total separate from the current page", async () => {
    const searchProfilesForAgent = vi.fn(async () => ({
      total: 19,
      page: 1,
      limit: 6,
      items: [{
        id: "00000000-0000-0000-0000-000000000001",
        displayName: "李静",
        aliases: ["李姐"],
        customerRegion: "深圳南山区",
        relationshipStage: "prospect",
        overallHealth: "healthy",
        tags: [],
        summary: "采购负责人",
      }],
    }));
    const result = await tool("search_customer_profiles", { searchProfilesForAgent }).execute(
      { query: "李姐", limit: 6 },
      { userId: "u1", workingDirectory: "/tmp" }
    );
    expect(searchProfilesForAgent).toHaveBeenCalledWith("u1", expect.objectContaining({ query: "李姐", limit: 6 }));
    expect(JSON.parse(result.content)).toMatchObject({ total: 19, limit: 6 });
    expect(JSON.parse(result.content).items).toHaveLength(1);
    expect(JSON.parse(result.content).items[0]).toMatchObject({ customerRegion: "深圳南山区" });
  });

  it("does not commit a profile change when prepare requires confirmation", async () => {
    const service = {
      prepareProfileChange: vi.fn(async () => ({
        draftId: "00000000-0000-0000-0000-000000000010",
        status: "needs_confirmation",
        operation: "update",
        risks: ["identity_ambiguous"],
        question: "李姐对应哪位用户？",
        options: ["李晨", "李静"],
        candidates: [],
      })),
      commitProfileChange: vi.fn(),
    };
    const result = await tool("prepare_customer_profile_change", service).execute(
      { operation: "update", customerMention: "李姐", tags: ["重点客户"] },
      { userId: "u1", workingDirectory: "/tmp", sourceText: "把李姐标记为重点客户" }
    );
    expect(result.content).toContain("ask_user");
    expect(result.content).toContain("李姐对应哪位用户");
    expect(service.commitProfileChange).not.toHaveBeenCalled();
  });
});
