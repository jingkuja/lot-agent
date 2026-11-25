import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "@lot-agent/core";
import { ComicDramaAi } from "./drama-ai.js";
import { ComicLibraryError } from "./library-db.js";
import { PgComicLibrary } from "./library-repository.js";

const ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const dramaId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const charId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function mockLlm(responseText: string): LLMProvider {
  return {
    async *chat() {
      yield { type: "text", content: responseText };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

describe("ComicDramaAi outline polish & master script generation", () => {
  it("polishes drama outline, strips accidental code fences, and checks compliance", async () => {
    const llm = mockLlm("```markdown\n第 1 集至第 10 集：暴雨夜的便利店成为城市夜归人的心灵驿站。\n```");
    const ai = new ComicDramaAi({
      repo: {
        getDrama: vi.fn(async () => ({
          drama: {
            id: dramaId, title: "雨夜便利店", synopsis: "都市奇幻", outline: "", scriptContent: "",
            styleKey: "thick_painting", aspectRatio: "9:16" as const, videoModel: null, revision: 1, archivedAt: null,
          },
          episodes: [],
          cast: [],
        })),
      },
      resolveModel: vi.fn(async () => ({ usedModelId: "deepseek-v4.1-flash", modelIds: ["deepseek-v4.1-flash"], llm })),
    });

    const res = await ai.polishOutline(ownerId, dramaId, { outline: "女孩失恋来到便利店。", language: "zh" }, AbortSignal.timeout(5000));
    expect(res.outline).toBe("第 1 集至第 10 集：暴雨夜的便利店成为城市夜归人的心灵驿站。");
    expect(res.modelId).toBe("deepseek-v4.1-flash");

    await expect(ai.polishOutline(ownerId, dramaId, {
      outline: "剧情包含血腥虐杀和肢解。", language: "zh",
    }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "CONTENT_COMPLIANCE_REJECTED" });
  });

  it("generates multi-episode master script and rejects archived dramas", async () => {
    const llm = mockLlm("【第 1 集：风铃】\n场景：便利店深夜。");
    const ai = new ComicDramaAi({
      repo: {
        getDrama: vi.fn(async () => ({
          drama: {
            id: dramaId, title: "雨夜便利店", synopsis: "", outline: "共 6 集。", scriptContent: "",
            styleKey: "thick_painting", aspectRatio: "9:16" as const, videoModel: null, revision: 1, archivedAt: null,
          },
          episodes: [],
          cast: [],
        })),
      },
      resolveModel: vi.fn(async () => ({ usedModelId: "deepseek-v4.1-flash", modelIds: ["deepseek-v4.1-flash"], llm })),
    });

    const scriptRes = await ai.generateScript(ownerId, dramaId, {
      episodeCount: 6, notes: "每集结尾留钩子", language: "zh",
    }, AbortSignal.timeout(5000));
    expect(scriptRes.script).toContain("【第 1 集：风铃】");
    expect(scriptRes.truncated).toBe(false);

    const archivedAi = new ComicDramaAi({
      repo: {
        getDrama: vi.fn(async () => ({
          drama: {
            id: dramaId, title: "已归档", synopsis: "", outline: "", scriptContent: "",
            styleKey: "thick_painting", aspectRatio: "9:16" as const, videoModel: null, revision: 1, archivedAt: new Date().toISOString(),
          },
          episodes: [],
          cast: [],
        })),
      },
      resolveModel: vi.fn(),
    });
    await expect(archivedAi.polishOutline(ownerId, dramaId, {
      outline: "test", language: "zh",
    }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "DIRECTOR_ARCHIVED" });
  });
});

describe("PgComicLibrary character drama attribution", () => {
  it("supports dramaId filtering, ownership check, and FOR UPDATE OF c on edit", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM lot_comic_drama.cd_characters c") && sql.includes("hero.cover")) {
        return {
          rows: [{
            id: charId, name: "林夏", aliases: [], tags: [], roleKey: "lead",
            dramaId, dramaTitle: "雨夜便利店", age: "24", personality: "冷静", appearance: "长发",
            archived: false, cover: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM lot_comic_drama.cd_characters c") && sql.includes("FOR UPDATE OF c")) {
        return {
          rows: [{
            id: charId, name: "林夏", aliases: [], tags: [], roleKey: "lead",
            dramaId: null, dramaTitle: null, age: "24", personality: "冷静", appearance: "长发", archived: false,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM lot_comic_drama.cd_dramas WHERE owner_id=$1 AND id=$2")) {
        return { rows: params[1] === dramaId ? [{ "?column?": 1 }] : [], rowCount: params[1] === dramaId ? 1 : 0 };
      }
      if (sql.startsWith("UPDATE lot_comic_drama.cd_characters SET")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const client: PoolClient = { query, release: vi.fn() } as unknown as PoolClient;
    const pool: Pool = { connect: vi.fn(async () => client), query } as unknown as Pool;
    const lib = new PgComicLibrary(pool);

    const listed = await lib.listCharacters(ownerId, { archived: "false", page: 1, dramaId });
    expect(listed.entries[0]?.dramaTitle).toBe("雨夜便利店");
    expect(calls.some(c => c.sql.includes("AND d.id=$6::uuid"))).toBe(true);

    await lib.listCharacters(ownerId, { archived: "false", page: 1, dramaId: "unassigned" });
    expect(calls.some(c => c.sql.includes("AND d.id IS NULL"))).toBe(true);

    await expect(lib.editCharacter(ownerId, charId, {
      name: "林夏", aliases: [], tags: [], roleKey: "lead",
      dramaId: "99999999-9999-4999-8999-999999999999",
      age: "24", personality: "冷静", appearance: "长发",
    })).rejects.toBeInstanceOf(ComicLibraryError);

    await lib.editCharacter(ownerId, charId, {
      name: "林夏", aliases: [], tags: [], roleKey: "lead", dramaId,
      age: "24", personality: "冷静", appearance: "长发",
    });
    expect(calls.some(c => c.sql.includes("FOR UPDATE OF c"))).toBe(true);
  });
});
