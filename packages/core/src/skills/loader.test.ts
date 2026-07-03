import { describe, it, expect } from "vitest";
import { SkillLoader } from "./loader.js";

function loaderWith(skills: any[]): SkillLoader {
  const l = new SkillLoader();
  (l as any).skills = skills;
  return l;
}

describe("SkillLoader.match agent scoping", () => {
  const trig = { name: "doc", description: "", triggers: ["生成文档"], content: "DOC" };
  const scoped = { name: "ppt-authoring", description: "", triggers: [], content: "PPT", agents: ["ppt"] };

  it("injects agent-scoped skill unconditionally for its agent", () => {
    const l = loaderWith([trig, scoped]);
    const r = l.match("随便什么", { agentId: "ppt" });
    expect(r.map((s) => s.name)).toContain("ppt-authoring");
  });
  it("does NOT inject scoped skill for other agents", () => {
    const l = loaderWith([trig, scoped]);
    const r = l.match("随便什么", { agentId: "general" });
    expect(r.map((s) => s.name)).not.toContain("ppt-authoring");
  });
  it("keeps trigger behavior for unscoped skills", () => {
    const l = loaderWith([trig, scoped]);
    expect(l.match("请帮我生成文档", { agentId: "general" }).map((s) => s.name)).toContain("doc");
    expect(l.match("你好", { agentId: "general" }).map((s) => s.name)).not.toContain("doc");
  });
  it("scoped skill never matches by trigger for a different agent even if content mentions words", () => {
    const l = loaderWith([scoped]);
    expect(l.match("ppt", { agentId: "general" })).toHaveLength(0);
  });
});
