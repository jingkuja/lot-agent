import { Hono } from "hono";
import type { PosterLibrary, PosterOrientation } from "../generation/poster-library.js";

export function createPosterLibraryRoutes(library: PosterLibrary) {
  const app = new Hono();
  app.get("/categories", async (c) => {
    await library.ensureAvailable();
    const categories = library.categories();
    return categories ? c.json({ categories, orientations: library.hasDimensions() }) : c.json({ error: "爆款参考图暂时无法读取" }, 503);
  });
  app.get("/images", async (c) => {
    const category = c.req.query("category");
    const offset = Number(c.req.query("offset") ?? 0);
    const query = (c.req.query("q") ?? "").trim();
    const orientation = c.req.query("orientation") ?? "all";
    if (query.length > 100 || !["all", "portrait", "landscape", "square"].includes(orientation)) {
      return c.json({ error: "Invalid poster filter" }, 400);
    }
    if (!category || !Number.isSafeInteger(offset) || offset < 0) return c.json({ error: "Invalid category or offset" }, 400);
    await library.ensureAvailable();
    const page = library.page(category, offset, query, orientation as PosterOrientation);
    if (page === undefined) return c.json({ error: "爆款参考图暂时无法读取" }, 503);
    return page ? c.json(page) : c.json({ error: "爆款分类不存在" }, 404);
  });
  return app;
}
