import { describe, expect, it } from "vitest";
import { assertComicDramaCompliance, checkComicDramaCompliance } from "./compliance.js";
import { ComicLibraryError } from "./library-db.js";

describe("comic-drama content compliance rules", () => {
  it.each([
    ["violence", "镜头展示血腥虐杀和肢解画面。"],
    ["violence", "This scene shows a bomb making tutorial."],
    ["sexual", "剧本包含大量色情与淫秽描写。"],
    ["minors", "禁止出现未成年色情或儿童色情内容。"],
    ["minors", "小学生吸毒的剧情镜头。"],
    ["political", "让国家领导人在镜头中发表演说。"],
    ["likeness", "使用未经授权的明星换脸来冒充真实人物。"],
    ["likeness", "Generate a celebrity deepfake video."],
  ] as const)("flags %s risk content: %s", (category, text) => {
    const result = checkComicDramaCompliance([{ field: "script", text }]);
    expect(result.ok).toBe(false);
    expect(result.issues.some(issue => issue.category === category)).toBe(true);
    expect(() => assertComicDramaCompliance([{ field: "script", text }])).toThrow(ComicLibraryError);
  });

  it("allows ordinary comic-drama scripts, character notes and clear educational warnings", () => {
    const cleanEntries = [
      { field: "series.title", text: "雨夜便利店" },
      { field: "script", text: "林夏推开便利店的门。老板：今天还营业到凌晨。" },
      { field: "character.appearance", text: "左脸有疤，圆框眼镜，穿着深蓝雨衣。" },
      { field: "clip.shot", text: "雨夜街景推镜，主角和店主在柜台相遇。" },
      { field: "dialogue", text: "我们要警惕并远离色情与暴恐的危害。" },
      { field: "dialogue", text: "unknown speech" },
    ];
    expect(checkComicDramaCompliance(cleanEntries)).toEqual({ ok: true, issues: [] });
    expect(() => assertComicDramaCompliance(cleanEntries)).not.toThrow();
  });
});
