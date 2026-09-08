import { describe, expect, it, vi } from "vitest";
import { conversationWorkflows } from "./0014-conversation-workflows.js";
import { migrations } from "./index.js";

describe("conversation workflow migration", () => {
  it("adds confirmation drafts, outreach versions and campaign results", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await conversationWorkflows.up({ query } as any);
    const ddl = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(conversationWorkflows.version).toBe(14);
    expect(migrations.find((migration) => migration.version === 14)).toBe(conversationWorkflows);
    expect(ddl).toContain("de_conversation_action_drafts");
    expect(ddl).toContain("de_outreach_drafts");
    expect(ddl).toContain("de_campaign_results");
    expect(ddl).toContain("awaiting_confirmation");
  });
});
