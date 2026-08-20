import { describe, expect, it, vi } from "vitest";
import { campaignSelectedAssets } from "./0015-campaign-selected-assets.js";
import { migrations } from "./index.js";

describe("campaign selected assets migration", () => {
  it("adds selected_assets onto marketing campaigns", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await campaignSelectedAssets.up({ query } as any);
    expect(campaignSelectedAssets.version).toBe(15);
    expect(migrations.at(-1)).toBe(campaignSelectedAssets);
    expect(String(query.mock.calls[0]?.[0])).toContain("selected_assets");
  });
});
