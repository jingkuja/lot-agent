import { describe, it, expect } from "vitest";
import { SkillLoader, type Skill } from "./loader.js";
import {
  LOAD_SKILL_TOOL_NAME,
  createLoadSkillTool,
  formatSkillIndex,
  buildSkillPromptParts,
} from "./load-skill-tool.js";
import type { ToolContext } from "../types/index.js";

const ctx: ToolContext = { workingDirectory: "/tmp" };

const skills: Skill[] = [
  {
    name: "doc-gen",
    description: "生成可下载的文档文件",
    triggers: ["生成文档"],
    content: "DOC BODY",
  },
  {
    name: "ppt-craft",
    description: "PPT 工艺",
    triggers: [],
    content: "PPT BODY",
    agents: ["ppt"],
  },
  {
    name: "seo",
    description: "SEO 写作要点",
    triggers: ["seo"],
    content: "SEO BODY",
  },
];

function loaderWith(list: Skill[]): SkillLoader {
  const loader = new SkillLoader();
  (loader as unknown as { skills: Skill[] }).skills = list;
  return loader;
}

describe("createLoadSkillTool", () => {
  it("is a cacheable, parallel-safe tool named load_skill that does not end the turn", () => {
    const tool = createLoadSkillTool(loaderWith(skills));
    expect(tool.name).toBe(LOAD_SKILL_TOOL_NAME);
    expect(tool.cacheable).toBe(true);
    expect(tool.parallelSafe).toBe(true);
    expect(tool.endsTurn).toBeUndefined();
  });

  it("returns the skill content tagged with its name", async () => {
    const tool = createLoadSkillTool(loaderWith(skills));
    const result = await tool.execute({ name: "doc-gen" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("[Skill: doc-gen]\nDOC BODY");
  });

  it("errors with not_found for an unknown skill and lists available names", async () => {
    const tool = createLoadSkillTool(loaderWith(skills));
    const result = await tool.execute({ name: "nope" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("not_found");
    expect(result.content).toContain("doc-gen");
  });
});

describe("formatSkillIndex", () => {
  it("returns empty string for no skills", () => {
    expect(formatSkillIndex([])).toBe("");
  });

  it("lists each skill as name: description under a usage header", () => {
    const block = formatSkillIndex([skills[0], skills[2]]);
    expect(block).toContain("load_skill");
    expect(block).toContain("- doc-gen: 生成可下载的文档文件");
    expect(block).toContain("- seo: SEO 写作要点");
    // 索引只含元信息，不泄漏正文
    expect(block).not.toContain("DOC BODY");
  });
});

describe("buildSkillPromptParts", () => {
  it("fully injects trigger-matched skills and indexes the rest", () => {
    const parts = buildSkillPromptParts(
      loaderWith(skills),
      "帮我生成文档",
      "general",
      ["load_skill"]
    );
    // 命中 trigger 的 doc-gen 全文注入
    expect(parts[0]).toBe("[Skill: doc-gen]\nDOC BODY");
    // 索引块在最后，含未命中的 seo，不含已注入的 doc-gen、不含别的 Agent 的 ppt-craft
    const index = parts[parts.length - 1];
    expect(index).toContain("- seo:");
    expect(index).not.toContain("- doc-gen:");
    expect(index).not.toContain("ppt-craft");
  });

  it("omits the index when the agent's whitelist lacks load_skill", () => {
    const parts = buildSkillPromptParts(loaderWith(skills), "帮我生成文档", "contract", [
      "ask_user",
      "generate_document",
    ]);
    expect(parts).toEqual(["[Skill: doc-gen]\nDOC BODY"]);
  });

  it("treats an undefined whitelist as all-tools (index included)", () => {
    const parts = buildSkillPromptParts(loaderWith(skills), "随便聊聊", "general", undefined);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("- doc-gen:");
    expect(parts[0]).toContain("- seo:");
  });

  it("still force-injects agent-scoped skills and keeps them out of the index", () => {
    const parts = buildSkillPromptParts(loaderWith(skills), "随便聊聊", "ppt", ["load_skill"]);
    expect(parts[0]).toBe("[Skill: ppt-craft]\nPPT BODY");
    const index = parts[parts.length - 1];
    expect(index).not.toContain("ppt-craft");
  });

  it("returns no parts when nothing matches and nothing is indexable", () => {
    const parts = buildSkillPromptParts(loaderWith([]), "hi", "general", ["load_skill"]);
    expect(parts).toEqual([]);
  });
});
