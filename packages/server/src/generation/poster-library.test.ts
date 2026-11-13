import { describe, expect, it, vi } from "vitest";
import { createPosterLibraryRoutes } from "../routes/poster-library.js";
import { PosterLibrary, startPosterLibraryRefresh } from "./poster-library.js";

type PosterPage = NonNullable<ReturnType<PosterLibrary["page"]>>;
const HEADER = "\uFEFF品类,商品名,图片本地路径,图片原始URL\r\n";
const food = "食品零食,饼干,/workspace/posters/食品零食/cookies.png,https://untrusted.example/cookies.png";

describe("poster library", () => {
  it("filters the entire category before paging, with exact dimensions and unknowns only in all", async () => {
    const rows = Array.from({ length: 55 }, (_, i) => `食品零食,${i % 2 ? "Tea" : "饼干"} ${i},/workspace/posters/食品零食/${i}.png,${i},20`);
    const library = new PosterLibrary(async () => "品类,商品名,图片本地路径,width,height\n" + rows.join("\n"));
    await library.refresh();
    expect(library.hasDimensions()).toBe(true);
    const first = library.page("食品零食", 0, "ＴＥＡ")!;
    expect(first.items).toHaveLength(24); expect(first.nextOffset).toBe(24);
    expect(library.page("食品零食", 24, "tea")?.items).toHaveLength(3);
    expect(library.page("食品零食", 0, "", "square")?.items.map(item => item.filename)).toEqual(["20.png"]);
    expect(library.page("食品零食", 0, "", "portrait")?.items).toHaveLength(19);
    expect(library.page("食品零食", 0, "", "landscape")?.items).toHaveLength(24);
    expect(library.page("食品零食", 24, "", "landscape")?.items).toHaveLength(10);
    const app = createPosterLibraryRoutes(library);
    const path = `/images?category=${encodeURIComponent("食品零食")}`;
    expect((await (await app.request(`${path}&q=Tea&orientation=square`)).json() as PosterPage).items).toEqual([]);
    expect((await app.request(`${path}&orientation=guess`)).status).toBe(400);
    expect((await app.request(`${path}&q=${"a".repeat(101)}`)).status).toBe(400);
  });
  it("coalesces failures, backs off, recovers and aborts an on-demand request on shutdown", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => HEADER + food).mockRejectedValueOnce(new Error("offline"));
    const library = new PosterLibrary(load, () => 0.5);
    try {
      await Promise.all([library.ensureAvailable(), library.ensureAvailable(), library.ensureAvailable()]);
      expect(load).toHaveBeenCalledTimes(1);
      await library.ensureAvailable();
      expect(load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await library.ensureAvailable();
      expect(library.categories()).toEqual(["食品零食"]);
      expect(load).toHaveBeenCalledTimes(2);
      let signal: AbortSignal | undefined;
      const pending = new PosterLibrary(async s => {
        signal = s;
        return new Promise<string>((_, reject) => s?.addEventListener("abort", () => reject(new Error("stopped"))));
      });
      const request = pending.ensureAvailable();
      pending.stop();
      await request;
      expect(signal?.aborted).toBe(true);
      expect(pending.categories()).toBeUndefined();
    } finally { library.stop(); vi.useRealTimers(); }
  });
  it("groups CSV rows by their local folder and pages the hosted images", async () => {
    const rows = [
      '家居日用,"礼盒, ""新品""",/workspace/posters/食品零食/茶 #1.webp,https://untrusted.example/a',
      ...Array.from({ length: 25 }, (_, i) => `食品零食,礼盒 ${i},/workspace/posters/食品零食/box-${i}.jpg,`),
      food,
      food,
      "家居日用,无效,/workspace/posters/../a.png,",
      "家居日用,无效,https://untrusted.example/a.png,",
      "家居日用,无效,/workspace/posters/家居日用/a.svg,",
      "家居日用,餐具,/workspace/posters/家居日用/tableware.jpg,",
    ];
    const library = new PosterLibrary(async () => HEADER + rows.join("\r\n"));
    const app = createPosterLibraryRoutes(library);
    expect((await app.request("/categories")).status).toBe(200);
    await library.refresh();
    expect(await (await app.request("/categories")).json()).toEqual({ categories: ["食品零食", "家居日用"], orientations: false });
    const query = `/images?category=${encodeURIComponent("食品零食")}`;
    const first = await (await app.request(query)).json() as PosterPage;
    expect(first.items).toHaveLength(24);
    expect(first.nextOffset).toBe(24);
    const firstPoster = first.items[0];
    expect(firstPoster).toMatchObject({ name: '礼盒, "新品"', category: "食品零食", filename: "茶 #1.webp" });
    expect(firstPoster.url).toMatch(/^https:\/\/todoucloud\.com\/posters\/[^/]+\/[^/]+%20%231\.webp\?v=[a-f0-9]{16}$/);
    const last = await (await app.request(`${query}&offset=24`)).json() as PosterPage;
    expect(last.items).toHaveLength(3);
    expect(last.nextOffset).toBeNull();
    expect(library.select({ category: "食品零食", filename: "unknown.png" })).toBeNull();
    expect(library.select({ category: "食品零食", filename: "cookies.png" })?.revision).toMatch(/^[a-f0-9]{16}$/);
  });

  it("keeps the last successful snapshot when a refresh cannot parse the index", async () => {
    const loadIndex = vi.fn(async () => HEADER + food);
    const library = new PosterLibrary(loadIndex);
    await library.refresh();
    loadIndex.mockResolvedValueOnce("<html>Unavailable</html>");
    await expect(library.refresh()).rejects.toThrow("Missing poster CSV header");
    expect(library.page("食品零食", 0)?.items).toHaveLength(1);
  });

  it("loads on startup and refreshes every night at 23:00 Shanghai time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T14:59:50Z"));
    const loadIndex = vi.fn(async () => HEADER + food);
    const library = new PosterLibrary(loadIndex);
    const stop = startPosterLibraryRefresh(library);
    try {
      await vi.advanceTimersByTimeAsync(9_999);
      expect(loadIndex).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(loadIndex).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(loadIndex).toHaveBeenCalledTimes(3);
      stop();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(loadIndex).toHaveBeenCalledTimes(3);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
