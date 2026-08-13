export interface RagIdentity {
  externalUserId: string;
  name: string;
}

export interface KnowledgeBaseRef {
  id: string;
  name: string;
}

export interface KnowledgeBase extends KnowledgeBaseRef {
  description: string;
  documentCount: number;
  availableDocumentCount: number;
}

export interface RagRecord {
  datasetId: string;
  datasetName: string;
  segmentId: string;
  documentName: string;
  content: string;
  answer: string;
  score: number;
}

export class RagClient {
  private readonly baseUrl: string;
  private readonly integrationKey: string;

  constructor(opts?: { baseUrl?: string; integrationKey?: string }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.RAG_API_URL ?? "https://ai-rag.gafz.com.cn").replace(/\/$/, "");
    this.integrationKey = opts?.integrationKey ?? process.env.RAG_INTEGRATION_KEY ?? "";
  }

  private async request<T>(path: string, identity: RagIdentity, init?: RequestInit): Promise<T> {
    if (!this.integrationKey) throw new Error("RAG_INTEGRATION_KEY is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "X-Lot-Agent-Key": this.integrationKey,
          "X-Lot-User-Id": identity.externalUserId,
          "X-Lot-User-Name": identity.name,
          ...init?.headers,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { message?: string; error?: string } | null;
        throw new Error(body?.message ?? body?.error ?? `RAG request failed (${res.status})`);
      }
      return await res.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async listKnowledgeBases(identity: RagIdentity): Promise<KnowledgeBase[]> {
    const response = await this.request<{
      data: Array<{
        id: string;
        name: string;
        description?: string;
        document_count?: number;
        available_document_count?: number;
      }>;
    }>("/console/api/integrations/lot-agent/datasets", identity);
    return response.data.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description ?? "",
      documentCount: item.document_count ?? 0,
      availableDocumentCount: item.available_document_count ?? 0,
    }));
  }

  async createKnowledgeBaseLink(identity: RagIdentity): Promise<string> {
    const response = await this.request<{ url: string }>(
      "/console/api/integrations/lot-agent/link",
      identity,
      { method: "POST", body: "{}" }
    );
    return response.url;
  }

  async retrieve(identity: RagIdentity, datasetIds: string[], query: string): Promise<RagRecord[]> {
    const response = await this.request<{
      records: Array<{
        dataset_id: string;
        dataset_name: string;
        segment_id: string;
        document_name: string;
        content: string;
        answer?: string;
        score?: number;
      }>;
    }>("/console/api/integrations/lot-agent/retrieve", identity, {
      method: "POST",
      body: JSON.stringify({ dataset_ids: datasetIds, query }),
    });
    return response.records.map((record) => ({
      datasetId: record.dataset_id,
      datasetName: record.dataset_name,
      segmentId: record.segment_id,
      documentName: record.document_name,
      content: record.content,
      answer: record.answer ?? "",
      score: record.score ?? 0,
    }));
  }
}
