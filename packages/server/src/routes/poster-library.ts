import { Hono } from "hono";
import type { PosterLibrary } from "../generation/poster-library.js";

export function createPosterLibraryRoutes(library: PosterLibrary) {
  const app = new Hono();
  app.get("/categories", (c) => {
    const categories = library.categories();
    return categories ? c.json({ categories }) : c.json({ error: "爆款参考图暂时无法读取" }, 503);
  });
  app.get("/images", (c) => {
    const category = c.req.query("category");
    const offset = Number(c.req.query("offset") ?? 0);
    if (!category || !Number.isSafeInteger(offset) || offset < 0) return c.json({ error: "Invalid category or offset" }, 400);
    const page = library.page(category, offset);
    if (page === undefined) return c.json({ error: "爆款参考图暂时无法读取" }, 503);
    return page ? c.json(page) : c.json({ error: "爆款分类不存在" }, 404);
  });
  return app;
}
