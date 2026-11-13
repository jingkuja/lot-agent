// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../App.js";
import { api } from "../api/client.js";
import { ImageShareControl, imageShareUrl } from "./ImageShareControl.js";
import { PublicImageShare } from "./PublicImageShare.js";

let root: Root;
const token = "a".repeat(48);
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); document.body.replaceChildren(); window.history.replaceState({}, "", "/");
  vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.lotDesktop;
});
const click = async (text: string) => {
  const target = [...document.querySelectorAll("button")].find(button => button.textContent === text);
  expect(target).toBeDefined(); await act(async () => target!.click());
};

it("opens a public share before authentication and fetches without credentials", async () => {
  window.history.replaceState({}, "", `/share/${token}`);
  const mode = vi.spyOn(api, "mode"), me = vi.spyOn(api, "me");
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ title: "公开图片", url: "/static/assets/a.png", mime: "image/png" })));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(App)));
  expect(document.querySelector("img")?.getAttribute("src")).toBe("/static/assets/a.png");
  expect(mode).not.toHaveBeenCalled(); expect(me).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledWith(`/api/public/shares/${token}`, expect.objectContaining({ credentials: "omit", cache: "no-store" }));
});

it("removes an open image after revalidation finds a revoked share and handles invalid tokens", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ title: "image", url: "/a.png", mime: "image/png" })))
    .mockResolvedValue(new Response("{}", { status: 404 }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(PublicImageShare, { token })));
  expect(document.querySelector("img")).not.toBeNull();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.textContent).toContain("作品不存在或分享已撤销");
  await act(async () => root.render(createElement(PublicImageShare, { token: "invalid" })));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("creates, copies and revokes the selected image using the configured public origin on desktop", async () => {
  window.lotDesktop = { getServerUrl: () => "http://localhost:3000" } as typeof window.lotDesktop;
  vi.spyOn(api, "imageShare").mockResolvedValue({ token: null });
  vi.spyOn(api, "getProductLinks").mockResolvedValue({ webUrl: "https://public.example/", tokenhubUrl: "" });
  const create = vi.spyOn(api, "createImageShare").mockResolvedValue({ token });
  const revoke = vi.spyOn(api, "revokeImageShare").mockResolvedValue({ ok: true });
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await act(async () => root.render(createElement(ImageShareControl, { url: "/static/assets/selected.png" })));
  await click("分享"); expect(create).not.toHaveBeenCalled();
  await click("创建分享链接"); expect(create).toHaveBeenCalledWith("/static/assets/selected.png");
  expect(document.body.textContent).toContain("无法收回已下载的图片或原图链接");
  await click("复制链接"); expect(copy).toHaveBeenCalledWith(`https://public.example/share/${token}`);
  await click("撤销分享"); expect(revoke).toHaveBeenCalledWith(token);
  expect(document.querySelector("input")).toBeNull();
  expect(document.body.textContent).toContain("分享已撤销");
});

it("rejects unsafe configured public URLs", () => {
  expect(() => imageShareUrl("javascript:alert(1)", token)).toThrow();
  expect(() => imageShareUrl("https://user:pass@example.com", token)).toThrow();
  expect(() => imageShareUrl("https://public.example", "../private")).toThrow();
});
