import { describe, expect, it, vi } from "vitest";
import { RagClient } from "./rag-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RagClient", () => {
  it("scopes list requests with the server key and external user identity", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      data: [{ id: "kb1", name: "制度库", description: "公司制度", document_count: 3, available_document_count: 2 }],
    }));
    const client = new RagClient({ baseUrl: "https://rag.example", integrationKey: "shared" });

    await expect(client.listKnowledgeBases({ externalUserId: "42", name: "Alice" })).resolves.toEqual([
      { id: "kb1", name: "制度库", description: "公司制度", documentCount: 3, availableDocumentCount: 2 },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rag.example/console/api/integrations/lot-agent/datasets",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Lot-Agent-Key": "shared",
          "X-Lot-User-Id": "42",
          "X-Lot-User-Name": "Alice",
        }),
      })
    );
    fetchMock.mockRestore();
  });

  it("posts selected datasets and maps compact retrieval records", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      records: [{
        dataset_id: "kb1", dataset_name: "制度库", segment_id: "s1",
        document_name: "报销.md", content: "差旅标准", answer: "每日500元", score: 0.91,
      }],
    }));
    const client = new RagClient({ baseUrl: "https://rag.example/", integrationKey: "shared" });
    const result = await client.retrieve({ externalUserId: "42", name: "Alice" }, ["kb1"], "差旅报销");

    expect(result[0]).toMatchObject({ datasetId: "kb1", documentName: "报销.md", score: 0.91 });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      dataset_ids: ["kb1"], query: "差旅报销",
    });
    fetchMock.mockRestore();
  });

  it("creates a short-lived authenticated knowledge-base link", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ url: "https://rag.example/?lot_token=signed" })
    );
    const client = new RagClient({ baseUrl: "https://rag.example", integrationKey: "shared" });
    await expect(client.createKnowledgeBaseLink({ externalUserId: "42", name: "Alice" }))
      .resolves.toBe("https://rag.example/?lot_token=signed");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: "{}" });
    fetchMock.mockRestore();
  });
});
