import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = new URL("./miniprogram/", import.meta.url);
const { pages } = JSON.parse(readFileSync(new URL("app.json", root), "utf8")) as { pages: string[] };
let page: any;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("wx", { showShareMenu: vi.fn() });
  vi.stubGlobal("Page", (definition: any) => { page = definition; });
});
afterEach(() => vi.unstubAllGlobals());

describe("page sharing", () => {
  it.each(pages.filter(path => path !== "pages/preview/index"))(
    "%s shares a clean entry with a bundled cover instead of private page contents",
    async (path) => {
      const name = path.split("/")[1];
      await import(`./miniprogram/pages/${name}/index.ts`);
      page.onReady();
      expect(wx.showShareMenu).toHaveBeenCalledWith({ menus: ["shareAppMessage", "shareTimeline"] });

      // Drafts, account data and incoming queries must not become share metadata.
      page.data = { prompt: "private draft", src: "https://private.example/image.png", user: { phone: "13800138000" } };
      page.options = { prompt: "private draft", src: "https://private.example/image.png" };
      const friend = page.onShareAppMessage();
      const timeline = page.onShareTimeline();
      expect(friend.path).toBe(path === "pages/boot/index" ? "/pages/studio/index" : `/${path}`);
      expect(friend.title).toBeTruthy();
      expect(friend.imageUrl).toMatch(/^\/assets\/.+\.png$/);
      expect(existsSync(new URL(friend.imageUrl.slice(1), root))).toBe(true);
      expect(timeline).toEqual({ title: friend.title, imageUrl: friend.imageUrl, query: "" });
      expect(JSON.stringify({ friend, timeline })).not.toMatch(/private|13800138000/);
    },
  );
});
