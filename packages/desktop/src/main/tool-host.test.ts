import { afterEach, describe, expect, it, vi } from "vitest";
import { realpath, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DesktopToolBroker } from "../../../server/src/desktop/broker.js";
import { tmpdir } from "node:os";
const native = vi.hoisted(() => ({ showOpenDialog: vi.fn(), showMessageBox: vi.fn() }));
vi.mock("electron", () => ({ dialog: native, BrowserWindow: class {} }));
import { DesktopToolHost } from "./tool-host.js";

let host: DesktopToolHost | undefined;
afterEach(() => { host?.reset(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function setup() {
  const frame = { url: "http://127.0.0.1:3456/" };
  const contents = { id: 7, mainFrame: frame };
  host = new DesktopToolHost({ getWindow: () => ({ webContents: contents }) as any, getToken: () => "account-token", getServerUrl: () => "https://api.example.test", getRendererOrigin: () => "http://127.0.0.1:3456" });
  return { host, frame, contents };
}
describe("Electron local execution boundary", () => {
  it("rejects frames, other windows and remote pages", () => {
    const { host, frame, contents } = setup();
    expect(() => host.assertSender({ sender: contents, senderFrame: frame } as any)).not.toThrow();
    expect(() => host.assertSender({ sender: contents, senderFrame: { ...frame } } as any)).toThrow();
    expect(() => host.assertSender({ sender: {}, senderFrame: frame } as any)).toThrow();
    frame.url = "https://untrusted.example/";
    expect(() => host.assertSender({ sender: contents, senderFrame: frame } as any)).toThrow();
  });
  it("requires native folder selection and keeps capability out of the renderer", async () => {
    const { host } = setup();
    expect(await host.prepare("chat")).toBe(false);
    native.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [await realpath(tmpdir())] });
    await host.choose();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === "POST" ? { capability: "a".repeat(64), version: 2 } : { request: null, activeRequestId: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await host.prepare("chat")).toBe(true);
    expect(JSON.stringify(await host.state())).not.toContain("a".repeat(64));
    const url = "http://127.0.0.1:3456/api/conversations/chat/messages";
    expect(host.attachHeader(url, 99, "POST", { "x-lot-desktop-capability": "forged" })).toEqual({});
    expect(host.attachHeader("https://evil.test/api/conversations/chat/messages", 7, "POST", {})).toEqual({});
    expect(host.attachHeader(url, 7, "POST", {})).toEqual({ "X-Lot-Desktop-Capability": "a".repeat(64) });
    expect(host.attachHeader(url, 7, "POST", {})).toEqual({});
    host.finish("chat");
    expect((await host.state()).activeRuns).toBe(0);
    expect(fetchMock.mock.calls.some(([, init]) => init.method === "DELETE")).toBe(true);
  });
  it("rejects late preparation after logout or directory revocation", async () => {
    const { host } = setup();
    native.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [await realpath(tmpdir())] });
    await host.choose();
    let complete!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => init.method === "POST" ? new Promise<Response>(resolve => { complete = resolve; }) : Promise.resolve(new Response("{}"))));
    const preparing = host.prepare("chat");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    host.reset();
    complete(new Response(JSON.stringify({ capability: "a".repeat(64), version: 2 })));
    await expect(preparing).rejects.toThrow("authorization changed");
    expect((await host.state()).directory).toBeNull();
    expect((await host.state()).activeRuns).toBe(0);
  });
  it("requires server capability negotiation before allowing native tools", async () => {
    const { host } = setup();
    native.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [await realpath(tmpdir())] });
    await host.choose();
    const fetchMock = vi.fn(async () => Response.json({ capability: "a".repeat(64) }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(host.prepare("chat")).rejects.toThrow("Update the desktop server");
    expect((await host.state()).activeRuns).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});


it("executes a broker request on the selected computer directory and returns its result", async () => {
  const { host } = setup();
  const root = await realpath(await mkdtemp(join(tmpdir(), "lot-desktop-e2e-")));
  const broker = new DesktopToolBroker();
  let capability = "";
  try {
    await writeFile(join(root, "fixture.txt"), "real local file content");
    native.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [root] });
    await host.choose();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "POST" && url.endsWith("/session")) {
        capability = broker.create("user", "chat", JSON.parse(String(init.body)));
        return Response.json({ capability, version: 2 });
      }
      if (init.method === "DELETE") { broker.close(capability); return Response.json({ ok: true }); }
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        const ok = broker.complete(capability, "user", "chat", body.id, body.result);
        return Response.json({ ok }, { status: ok ? 200 : 409 });
      }
      const data = broker.poll(capability, "user", "chat");
      return Response.json(data ?? {}, { status: data ? 200 : 404 });
    }));
    await host.prepare("chat");
    const tools = broker.claim(capability, "user", "chat")!;
    const read = tools.find(tool => tool.name === "desktop_read_file")!;
    const result = await read.execute({ path: "fixture.txt" }, { workingDirectory: "/unused-on-server", userId: "user", conversationId: "chat" });
    expect(result).toEqual({ content: "real local file content" });
    const write = tools.find(tool => tool.name === "desktop_write_file")!;
    const writing = write.execute({ path: "created.txt", content: "approved content" }, { workingDirectory: "/unused-on-server", userId: "user", conversationId: "chat" });
    await vi.waitFor(async () => expect((await host.state("chat")).approvals).toHaveLength(1), { timeout: 2000 });
    await expect(readFile(join(root, "created.txt"), "utf8")).rejects.toThrow();
    const pending = (await host.state("chat")).approvals[0];
    expect(pending.detail).toContain("approved content");
    host.approvals.respond("chat", pending.id, "once");
    expect((await writing).isError).not.toBe(true);
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("approved content");
    const denied = write.execute({ path: "denied.txt", content: "blocked" }, { workingDirectory: "/unused-on-server", userId: "user", conversationId: "chat" });
    await vi.waitFor(async () => expect((await host.state("chat")).approvals).toHaveLength(1), { timeout: 2000 });
    host.approvals.respond("chat", (await host.state("chat")).approvals[0].id, "deny");
    expect((await denied).isError).toBe(true);
    await expect(readFile(join(root, "denied.txt"), "utf8")).rejects.toThrow();
    const remove = tools.find(tool => tool.name === "desktop_delete_file")!;
    const deleting = remove.execute({ path: "created.txt" }, { workingDirectory: "/unused-on-server", userId: "user", conversationId: "chat" });
    await vi.waitFor(async () => expect((await host.state("chat")).approvals).toHaveLength(1), { timeout: 2000 });
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("approved content");
    const deletion = (await host.state("chat")).approvals[0];
    expect(deletion.name).toBe("desktop_delete_file");
    host.approvals.respond("chat", deletion.id, "once");
    expect((await deleting).isError).not.toBe(true);
    await expect(readFile(join(root, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(native.showMessageBox).not.toHaveBeenCalled();
  } finally { host.reset(); broker.close(capability); await rm(root, { recursive: true, force: true }); }
});
