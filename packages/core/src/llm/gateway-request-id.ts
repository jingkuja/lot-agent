type HeaderSource = Headers | Record<string, string | null | undefined> | undefined;

/** The gateway's log ID for one request (New API: `x-oneapi-request-id`), so a
 * charge in the gateway logs can be matched to it, including for error responses. */
export function gatewayRequestId(headers: HeaderSource): string | undefined {
  const get = (name: string) => headers instanceof Headers ? headers.get(name) : headers?.[name];
  const id = get("x-oneapi-request-id") ?? get("x-request-id");
  return typeof id === "string" && /^[\w.:-]{1,200}$/.test(id) ? id : undefined;
}

/** Await an OpenAI SDK request and report the gateway request ID from its response
 * or error headers. Test doubles without `withResponse` resolve unchanged. */
export async function withGatewayRequestId<T>(request: Promise<T> & { withResponse?: () => Promise<{ data: T; response: Response }> },
  onRequestId?: (id: string) => void): Promise<T> {
  const report = (headers: HeaderSource) => { const id = gatewayRequestId(headers); if (id) onRequestId?.(id); };
  try {
    if (!onRequestId || typeof request.withResponse !== "function") return await request;
    const { data, response } = await request.withResponse();
    report(response.headers);
    return data;
  } catch (error) {
    report((error as { headers?: HeaderSource } | undefined)?.headers);
    throw error;
  }
}
