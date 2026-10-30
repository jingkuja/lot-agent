// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GROK_MARKETING_PROFILE, MarketingDraftSchema, type MarketingDraft } from "@lot-agent/core/marketing-video";
import { request } from "../../api/client.js";
import { translate } from "../../i18n/locale.js";
import type { Project } from "./api.js";
import { useDraftSession } from "./session.js";
import { useDraftAutosave, useDraftEditor } from "./useDraftEditor.js";
import { useTextRequests } from "./useTextRequests.js";

vi.mock("../../api/client.js", async original => ({ ...await original<typeof import("../../api/client.js")>(), request: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mounts `hook` in a component and exposes its latest return value. */
function renderHook<T>(hook: () => T) {
  const result = { current: undefined as T };
  function Probe() { result.current = hook(); return null; }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  return { result, rerender: () => act(() => root.render(createElement(Probe))), unmount: () => act(() => root.unmount()) };
}

/** A request the test answers later. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const calls = () => vi.mocked(request).mock.calls.map(([path, init]) =>
  ({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined }));
const projectFor = (path: string, body: { version: number; draft: MarketingDraft }) =>
  ({ id: path.split("/").at(-1)!, version: body.version + 1, draft: body.draft, status: "draft", taskId: null }) as Project;
const settle = () => act(async () => { await Promise.resolve(); });

/** The studio's editor with autosave, as ProjectStudio wires them. */
function editorHook(props: { busy: boolean; ready: boolean; onError(message: string): void }) {
  const session = useDraftSession();
  const editor = useDraftEditor({ ownerId: "owner", session, configured: GROK_MARKETING_PROFILE, onEdit: () => {}, onProject: () => {} });
  useDraftAutosave(editor, { session, ready: props.ready, busy: props.busy, onError: props.onError });
  return { session, editor };
}

beforeEach(() => { vi.mocked(request).mockReset(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe("draft autosave", () => {
  it("saves 900 ms after the last edit, and not while another action runs", async () => {
    vi.useFakeTimers();
    vi.mocked(request).mockImplementation(async (path, init) => projectFor(path, JSON.parse(String(init!.body))) as never);
    const props = { busy: false, ready: true, onError: vi.fn() };
    const { result, rerender } = renderHook(() => editorHook(props));
    act(() => result.current.editor.field("topic", "咖啡"));
    await act(async () => { vi.advanceTimersByTime(899); });
    act(() => result.current.editor.field("topic", "咖啡店"));
    await act(async () => { vi.advanceTimersByTime(899); });
    expect(request).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(calls()).toEqual([{ path: `/marketing-videos/${result.current.editor.draftId.current}`, method: "PUT",
      body: { version: 0, draft: expect.objectContaining({ topic: "咖啡店" }) } }]);
    await settle();
    expect(result.current.editor).toMatchObject({ dirty: false, saving: false, project: { version: 1 } });
    expect(localStorage.getItem("lot:marketing-video:owner")).toBe(result.current.editor.draftId.current);

    props.busy = true; rerender();
    act(() => result.current.editor.field("topic", "新品"));
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(request).toHaveBeenCalledTimes(1);
    props.busy = false; rerender();
    await act(async () => { vi.advanceTimersByTime(900); });
    expect(calls()[1].body).toMatchObject({ version: 1, draft: { topic: "新品" } });
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("runs saves one after another, each with the version the last one returned", async () => {
    const answers = [deferred<Project>(), deferred<Project>()];
    vi.mocked(request).mockImplementation(() => answers[vi.mocked(request).mock.calls.length - 1].promise as never);
    const { result } = renderHook(() => editorHook({ busy: true, ready: true, onError: vi.fn() }));
    const { editor } = result.current;
    act(() => editor.field("topic", "第一版"));
    let first!: Promise<Project>, second!: Promise<Project>;
    act(() => { first = result.current.editor.save(); });
    act(() => result.current.editor.field("topic", "第二版"));
    act(() => { second = result.current.editor.save(); });
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.editor.saving).toBe(true);

    await act(async () => { answers[0].resolve(projectFor(calls()[0].path, calls()[0].body)); await first; });
    await settle();
    expect(calls()[1].body).toMatchObject({ version: 1, draft: { topic: "第二版" } });
    await act(async () => { answers[1].resolve(projectFor(calls()[1].path, calls()[1].body)); await second; });
    expect(result.current.editor).toMatchObject({ saving: false, dirty: false, project: { version: 2 } });
    // Nothing changed since: the saved project is returned without another request.
    await act(async () => { await expect(result.current.editor.save()).resolves.toMatchObject({ version: 2 }); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("drops a save answered after another draft opened, without leaving the editor saving", async () => {
    const answer = deferred<Project>();
    vi.mocked(request).mockReturnValue(answer.promise as never);
    const { result } = renderHook(() => editorHook({ busy: true, ready: true, onError: vi.fn() }));
    act(() => result.current.editor.field("topic", "旧草稿"));
    let pending!: Promise<Project>;
    act(() => { pending = result.current.editor.save(); });
    const oldId = result.current.editor.draftId.current;
    act(() => { result.current.session.next(); result.current.editor.reset(); });
    await act(async () => { answer.resolve(projectFor(calls()[0].path, calls()[0].body)); await pending; });
    expect(result.current.editor.draftId.current).not.toBe(oldId);
    expect(result.current.editor).toMatchObject({ project: null, saving: false, dirty: false });
    expect(result.current.editor.version.current).toBe(0);
    expect(localStorage.getItem("lot:marketing-video:owner")).toBeNull();
  });

  it("ignores a save answered after the studio closed", async () => {
    const answer = deferred<Project>();
    vi.mocked(request).mockReturnValue(answer.promise as never);
    const onProject = vi.fn();
    const { result, unmount } = renderHook(() => {
      const session = useDraftSession();
      return { session, editor: useDraftEditor({ ownerId: "owner", session, configured: GROK_MARKETING_PROFILE, onEdit: () => {}, onProject }) };
    });
    act(() => result.current.editor.field("topic", "关闭前"));
    let pending!: Promise<Project>;
    act(() => { pending = result.current.editor.save(); });
    const errors = vi.spyOn(console, "error");
    unmount();
    await act(async () => { answer.resolve(projectFor(calls()[0].path, calls()[0].body)); await pending; });
    expect(result.current.session.alive).toBe(false);
    expect(onProject).not.toHaveBeenCalled();
    expect(localStorage.getItem("lot:marketing-video:owner")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("text request after a discarded unknown result", () => {
  it("repeats the last request once, with a new request ID, after the server releases it", async () => {
    const draft = MarketingDraftSchema.parse({ topic: "咖啡", script: "欢迎光临转角咖啡店。" });
    let reviews = 0;
    vi.mocked(request).mockImplementation(async (path, init) => {
      if (init?.method === "PUT") return projectFor(path, JSON.parse(String(init.body))) as never;
      reviews++;
      if (reviews === 1) throw new Error("网络中断");
      return { id: path.split("/")[2], version: 1, draft, status: "draft", taskId: null } as never;
    });
    const act_ = vi.fn(async (work: () => Promise<void>) => { await work().catch(() => {}); });
    const { result, rerender } = renderHook(() => {
      const { session, editor } = editorHook({ busy: true, ready: true, onError: vi.fn() });
      const text = useTextRequests({ editor, session, profile: GROK_MARKETING_PROFILE, ownerId: "owner", locale: "zh",
        t: (source, values) => translate(source, "zh", values),
        confirm: async () => true, wait: () => {}, act: act_, setError: () => {}, setNotice: () => {} });
      return { editor, text };
    });
    act(() => result.current.editor.update(draft));
    await act(async () => { await expect(result.current.text.review()).rejects.toThrow("文案检查未完成：网络中断"); });
    const reviewCalls = () => calls().filter(call => call.path.endsWith("/review"));
    const firstId = reviewCalls()[0].body.clientRequestId;

    await act(async () => { await result.current.text.operationState({ id: "op", kind: "review", status: "unknown" }); });
    expect(result.current.text).toMatchObject({ pending: true, unknown: true, retry: { kind: "review" } });
    act(() => result.current.text.retry!.run());
    await settle();
    // Still locked by the unknown result: nothing is sent yet.
    expect(reviewCalls()).toHaveLength(1);

    await act(async () => { await result.current.text.operationState({ id: "op", kind: "review", status: "released" }); });
    await settle(); rerender(); rerender(); await settle();
    expect(act_).toHaveBeenCalledTimes(1);
    expect(reviewCalls()).toHaveLength(2);
    expect(reviewCalls()[1].body.clientRequestId).not.toBe(firstId);
    expect(result.current.text.pending).toBe(false);
  });
});
