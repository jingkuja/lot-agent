import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@lot-agent/core";
import { DesktopToolBroker } from "./broker.js";

const context = { userId: "u1", conversationId: "c1", workingDirectory: "/never-execute-on-server" };
describe("desktop capability broker", () => {
  it("isolates users and conversations and accepts each capability once", () => {
    const broker = new DesktopToolBroker();
    const key = broker.create("u1", "c1");
    expect(broker.claim(key, "u2", "c1")).toBeUndefined();
    expect(broker.claim(key, "u1", "c2")).toBeUndefined();
    expect(broker.claim("desktop", "u1", "c1")).toBeUndefined();
    expect(broker.claim(key, "u1", "c1")).toHaveLength(5);
    expect(broker.claim(key, "u1", "c1")).toBeUndefined();
    expect(broker.poll(key, "u2", "c1")).toBeUndefined();
    broker.close(key);
  });
  it("forwards once, validates result ownership, rejects replay", async () => {
    const broker = new DesktopToolBroker();
    const key = broker.create("u1", "c1");
    const tool = broker.claim(key, "u1", "c1")![1];
    const pending = tool.execute({ path: "a" }, context);
    const request = broker.poll(key, "u1", "c1")!.request!;
    expect(request.name).toBe("desktop_read_file");
    expect(broker.poll(key, "u1", "c1")!.request).toBeNull();
    expect(broker.complete(key, "u2", "c1", request.id, { content: "forged" })).toBe(false);
    expect(broker.complete(key, "u1", "c1", "wrong", { content: "forged" })).toBe(false);
    expect(broker.complete(key, "u1", "c1", request.id, { content: "local result" })).toBe(true);
    expect((await pending).content).toBe("local result");
    expect(broker.complete(key, "u1", "c1", request.id, { content: "replay" })).toBe(false);
    broker.close(key);
  });
  it("enforces execution allowlists and schemas without a host implementation", async () => {
    const broker = new DesktopToolBroker();
    const key = broker.create("u1", "c1");
    const registry = new ToolRegistry();
    broker.claim(key, "u1", "c1")!.forEach(tool => registry.register(tool));
    expect((await registry.execute("desktop_bash", { command: "echo forbidden" }, context, { allowedToolNames: [] })).errorKind).toBe("permission");
    expect((await registry.execute("desktop_bash", { command: 1 }, context)).errorKind).toBe("validation");
    expect(broker.poll(key, "u1", "c1")!.request).toBeNull();
    broker.close(key);
  });
  it("cancels pending work and never redelivers writes", async () => {
    const broker = new DesktopToolBroker();
    const key = broker.create("u1", "c1");
    const controller = new AbortController();
    const tool = broker.claim(key, "u1", "c1")![4];
    const pending = tool.execute({ command: "echo x" }, { ...context, signal: controller.signal });
    broker.poll(key, "u1", "c1");
    controller.abort();
    expect((await pending).errorKind).toBe("unknown_outcome");
    expect(broker.poll(key, "u1", "c1")!.activeRequestId).toBeNull();
    broker.close(key);
  });
  it("revocation fails closed and session limits are per user", async () => {
    const broker = new DesktopToolBroker();
    const key = broker.create("u1", "c1");
    const tool = broker.claim(key, "u1", "c1")![4];
    const pending = tool.execute({ command: "pwd" }, context);
    expect(broker.revoke(key, "other", "c1")).toBe(false);
    broker.close(key);
    expect((await pending).isError).toBe(true);
    expect((await tool.execute({ command: "pwd" }, context)).errorKind).toBe("permission");
    for (let i = 0; i < 4; i++) broker.create("u1", `c${i}`);
    expect(() => broker.create("u1", "c5")).toThrow();
    expect(() => broker.create("u2", "c5")).not.toThrow();
  });
});
