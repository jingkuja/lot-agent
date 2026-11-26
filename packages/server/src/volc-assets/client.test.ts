import { describe, expect, it, vi } from "vitest";
import { VolcAssetsClient } from "./client.js";

const response = (result: unknown) => Response.json({ ResponseMetadata: { RequestId: "request" }, Result: result });

function setup() {
  const fetcher = vi.fn<typeof fetch>();
  const client = new VolcAssetsClient("https://gateway.example/v1/", "user-key", new AbortController().signal, fetcher);
  return { client, fetcher };
}

describe("Ark material gateway", () => {
  it("looks up exact group names across pages and creates an AIGC group when needed", async () => {
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(response({ Items: [{ Id: "group-other", Name: "lotagent-amy2" }], NextToken: "next" }))
      .mockResolvedValueOnce(response({ Items: [{ Id: "group-amy", Name: "lotagent-amy" }] }))
      .mockResolvedValueOnce(response({ Id: "group-new" }));
    await expect(client.findGroup("lotagent-amy")).resolves.toBe("group-amy");
    await expect(client.createGroup("lotagent-new")).resolves.toBe("group-new");
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://gateway.example/api/v3/assets?Action=ListAssetGroups&Version=2024-01-01",
      expect.objectContaining({
        headers: { "Content-Type": "application/json", Authorization: "Bearer user-key" },
        body: JSON.stringify({ Filter: { GroupType: "AIGC", Name: "lotagent-amy" }, MaxResults: 100, NextToken: "next" }),
      }));
    expect(fetcher.mock.calls[2][1]?.body).toBe(JSON.stringify({ Name: "lotagent-new", GroupType: "AIGC" }));
  });

  it("submits media with its type, reads readiness and deletes by the returned ID", async () => {
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(response({ Id: "asset-1" }))
      .mockResolvedValueOnce(response({ Status: "Processing" })).mockResolvedValueOnce(response({ Status: "Active" }))
      .mockResolvedValueOnce(response({}));
    await expect(client.createAsset("group-amy", "local-id", "Audio", "https://files.example/audio")).resolves.toBe("asset-1");
    await expect(client.status("asset-1")).resolves.toBe("Processing");
    await expect(client.status("asset-1")).resolves.toBe("Active");
    await client.deleteAsset("asset-1");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({
      GroupId: "group-amy", Name: "local-id", AssetType: "Audio", URL: "https://files.example/audio",
    }));
    expect(fetcher).toHaveBeenNthCalledWith(4, "https://gateway.example/api/v3/assets?Action=DeleteAsset&Version=2024-01-01",
      expect.objectContaining({ body: '{"Id":"asset-1"}' }));
  });

  it("distinguishes uncertain creates from explicitly rejected requests", async () => {
    const { client, fetcher } = setup();
    fetcher.mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(Response.json({ ResponseMetadata: { Error: { Code: "InvalidParameter" } } }, { status: 400 }));
    await expect(client.createGroup("lotagent-amy")).rejects.toThrow("timeout");
    await expect(client.createGroup("lotagent-amy")).rejects.toMatchObject({ rejected: true, status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
