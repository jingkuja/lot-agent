function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readId(result: Record<string, unknown> | undefined): string {
  const id = result?.Id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("火山素材接口未返回有效 ID");
  return id;
}

export type VolcAssetType = "Image" | "Video" | "Audio";
export function assetType(mime: string): VolcAssetType | undefined {
  if (mime.startsWith("image/")) return "Image";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Audio";
}

export class VolcAssetRequestError extends Error {
  constructor(readonly status: number, readonly rejected: boolean, readonly missing = false) {
    super(`火山素材接口请求失败（HTTP ${status}）`);
  }
}

export class VolcAssetsClient {
  private readonly endpoint: string;

  constructor(baseUrl: string, private readonly apiKey: string, private readonly signal: AbortSignal, private readonly fetchImpl = fetch) {
    const base = new URL(baseUrl);
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error("火山素材网关地址配置无效");
    }
    this.endpoint = base.href.replace(/\/+$/, "").replace(/\/v1$/, "") + "/api/v3/assets";
  }

  private async request(action: string, payload: Record<string, unknown>) {
    const response = await this.fetchImpl(`${this.endpoint}?Action=${action}&Version=2024-01-01`, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
    });
    const body = object(await response.json().catch(() => undefined));
    const metadata = object(body?.ResponseMetadata);
    const error = object(metadata?.Error);
    if (!response.ok || error || body?.success === false) {
      const rejected = Boolean(error && response.status < 500) || [400, 401, 403, 429].includes(response.status);
      const code = error?.Code;
      const missing = (response.status === 404 || response.status === 400) && typeof code === "string" && /(?:asset.*notfound|asset.*notexist)/i.test(code);
      throw new VolcAssetRequestError(response.status, rejected, missing);
    }
    if (!metadata && !object(body?.Result)) throw new Error("火山素材接口返回无效响应");
    return object(body?.Result);
  }

  private async find(action: "ListAssetGroups" | "ListAssets", name: string, groupId?: string) {
    const filter = { GroupType: "AIGC", ...(name.length <= 64 ? { Name: name } : {}), ...(groupId ? { GroupIds: [groupId] } : {}) };
    let nextToken: string | undefined;
    do {
      const page = await this.request(action, { Filter: filter, MaxResults: 100, ...(nextToken ? { NextToken: nextToken } : {}) });
      if (!Array.isArray(page?.Items)) throw new Error("火山素材接口未返回有效列表");
      const match = page.Items.map(object).find(entry => entry?.Name === name && (!groupId || entry.GroupId === groupId));
      if (match) return readId(match);
      const next = page.NextToken;
      if (next && next === nextToken) throw new Error("火山素材接口返回了重复的分页凭证");
      nextToken = typeof next === "string" ? next : undefined;
    } while (nextToken);
    return null;
  }

  findGroup(name: string) { return this.find("ListAssetGroups", name); }
  findAsset(name: string, groupId: string) { return this.find("ListAssets", name, groupId); }

  async createGroup(name: string) {
    return readId(await this.request("CreateAssetGroup", { Name: name, GroupType: "AIGC" }));
  }

  async createAsset(groupId: string, name: string, type: VolcAssetType, url: string) {
    return readId(await this.request("CreateAsset", { GroupId: groupId, Name: name, AssetType: type, URL: url }));
  }

  async status(remoteId: string) {
    const status = (await this.request("GetAsset", { Id: remoteId }))?.Status;
    if (status === "Active" || status === "Processing" || status === "Failed") return status;
    throw new Error("火山素材接口未返回有效状态");
  }

  async deleteAsset(remoteId: string) {
    try {
      if (!await this.request("DeleteAsset", { Id: remoteId })) throw new Error("火山素材接口未确认删除");
    }
    catch (error) {
      if (!(error instanceof VolcAssetRequestError && error.missing)) throw error;
    }
  }
}
