// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client.js";
import { useChat } from "./useChat.js";

vi.mock("../api/client.js", () => ({
  ApiClientError: class extends Error {},
  api: { generate: vi.fn(), getImageSubmission: vi.fn(), cancelTask: vi.fn(), getTask: vi.fn(), uploadFile: vi.fn() },
}));
vi.mock("../lib/notify.js", () => ({ showAlert: vi.fn(), notifyDesktop: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let chat: ReturnType<typeof useChat>;
function Harness({ cid }: { cid: string }) { chat = useChat(cid); return null; }
function mount(cid = "chat") {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(Harness, { cid })));
}
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); vi.resetAllMocks(); });
const response = {
  taskId: "task", userMessage: { id: "user" },
  assistantMessage: { id: "assistant", role: "assistant" as const, status: "generating",
    metadata: { mediaType: "image" as const, status: "generating", supportsProgress: false } },
};

it("cancels a late accepted task and continues polling even when cancellation fails", async () => {
  let accept!: (value: typeof response) => void;
  vi.mocked(api.generate).mockReturnValue(new Promise(resolve => { accept = resolve; }));
  vi.mocked(api.cancelTask).mockRejectedValue(new Error("offline"));
  vi.mocked(api.getTask).mockResolvedValue({ id: "task", status: "cancelled" } as Awaited<ReturnType<typeof api.getTask>>);
  mount();
  let pending!: ReturnType<typeof chat.generateMedia>;
  await act(async () => { pending = chat.generateMedia("product", "image", {}, [], undefined, [], "request-123456789"); });
  await act(async () => { await chat.stop(); });
  expect(vi.mocked(api.generate).mock.calls[0][2]?.aborted).toBe(false);
  await act(async () => { accept(response); await pending; });
  expect(api.cancelTask).toHaveBeenCalledWith("task");
  expect(api.getTask).toHaveBeenCalledWith("task");
  expect(chat.messages.filter(message => message.role === "assistant")).toHaveLength(1);
});

it("checks an ambiguous stopped submission read-only without another POST or duplicate bubbles", async () => {
  vi.mocked(api.generate).mockRejectedValue(new Error("lost response"));
  vi.mocked(api.getImageSubmission).mockResolvedValue(response);
  vi.mocked(api.getTask).mockResolvedValue({ id: "task", status: "cancelled" } as Awaited<ReturnType<typeof api.getTask>>);
  mount();
  await act(async () => { expect(await chat.generateMedia("product", "image", {}, [], undefined, [], "request-123456789")).toBe("unknown"); });
  await act(async () => { await chat.stop(); });
  await act(async () => { expect(await chat.generateMedia("product", "image", {}, [], undefined, [], "request-123456789")).toBe("accepted"); });
  expect(api.generate).toHaveBeenCalledTimes(1);
  expect(api.getImageSubmission).toHaveBeenCalledWith("chat", "request-123456789");
  expect(api.cancelTask).toHaveBeenCalledWith("task");
  expect(chat.messages).toHaveLength(2);
});

it("does not cancel a background task merely because the conversation changes", async () => {
  let accept!: (value: typeof response) => void;
  vi.mocked(api.generate).mockReturnValue(new Promise(resolve => { accept = resolve; }));
  mount();
  let pending!: ReturnType<typeof chat.generateMedia>;
  await act(async () => { pending = chat.generateMedia("product", "image"); });
  act(() => { chat.clear(); root.render(createElement(Harness, { cid: "other" })); });
  await act(async () => { accept(response); await pending; });
  expect(api.cancelTask).not.toHaveBeenCalled();
  expect(api.getTask).not.toHaveBeenCalled();
  expect(chat.messages).toHaveLength(0);
});
