import { describe, it, expect, vi, afterEach } from "vitest";
import { extractImageUrl, ChatCompletionsImageProvider } from "./chat-completions-image.js";

describe("extractImageUrl", () => {
  it("extracts the http(s) url from a markdown image link", () => {
    const content =
      "![image](https://geekus.oss-us-west-1.aliyuncs.com/chatgpt/cc50aa41.png)\n\n";
    expect(extractImageUrl(content)).toBe(
      "https://geekus.oss-us-west-1.aliyuncs.com/chatgpt/cc50aa41.png"
    );
  });
  it("returns the first image url when several are present", () => {
    const content = "![a](http://x/a.png) and ![b](https://y/b.png)";
    expect(extractImageUrl(content)).toBe("http://x/a.png");
  });
  it("returns null when there is no markdown image", () => {
    expect(extractImageUrl("sorry, I cannot generate that.")).toBeNull();
  });
  it("returns null for a non-http(s) url (malformed / wrong format)", () => {
    expect(extractImageUrl("![image](data:image/png;base64,AAAA)")).toBeNull();
    expect(extractImageUrl("![image](/relative/path.png)")).toBeNull();
  });
  it("returns null for empty / undefined content", () => {
    expect(extractImageUrl("")).toBeNull();
    expect(extractImageUrl(undefined as unknown as string)).toBeNull();
  });
});

describe("ChatCompletionsImageProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  const okResponse = (content: string) => ({
    ok: true,
    json: async () => ({
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
  });

  it("create POSTs /chat/completions with messages + size + prompt and Bearer auth", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse("![image](https://x/y.png)")
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new ChatCompletionsImageProvider({
      baseUrl: "https://api/v1",
      apiKey: "k",
      model: "gpt-image-2-token",
    });
    const created = await p.create({ prompt: "生成一只猫.", size: "2048*2048" });
    expect(created.status).toBe("completed");
    expect(created.progress).toBe(100);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "gpt-image-2-token",
      size: "2048*2048",
      prompt: "生成一只猫.",
      messages: [{ role: "user", content: "生成一只猫." }],
    });
  });

  it("poll returns the extracted url as a completed result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse("![image](https://x/cat.png)")) as unknown as typeof fetch);
    const p = new ChatCompletionsImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "m" });
    const created = await p.create({ prompt: "cat" });
    const polled = await p.poll(created.taskId);
    expect(polled.status).toBe("completed");
    expect(polled.progress).toBe(100);
    expect(polled.url).toBe("https://x/cat.png");
  });

  it("create throws when the response has no extractable image url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse("I cannot do that")) as unknown as typeof fetch);
    const p = new ChatCompletionsImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "m" });
    await expect(p.create({ prompt: "x" })).rejects.toThrow(/no image url/i);
  });

  it("create throws on a non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })) as unknown as typeof fetch);
    const p = new ChatCompletionsImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "m" });
    await expect(p.create({ prompt: "x" })).rejects.toThrow(/500/);
  });

  it("poll returns failed for an unknown task id", async () => {
    const p = new ChatCompletionsImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "m" });
    const r = await p.poll("nope");
    expect(r.status).toBe("failed");
  });
});
