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

describe("SkillLoader.match caps and dedup", () => {
  const mk = (name: string, trigger: string, content = "x") => ({
    name,
    description: "",
    triggers: [trigger],
    content,
  });

  it("caps the number of returned skills to maxSkills (default 3)", () => {
    const l = loaderWith([mk("a", "go"), mk("b", "go"), mk("c", "go"), mk("d", "go")]);
    expect(l.match("go")).toHaveLength(3);
  });

  it("respects an explicit maxSkills", () => {
    const l = loaderWith([mk("a", "go"), mk("b", "go"), mk("c", "go")]);
    expect(l.match("go", { maxSkills: 1 })).toHaveLength(1);
  });

  it("dedupes skills sharing the same name", () => {
    const l = loaderWith([mk("dup", "go"), mk("dup", "go")]);
    const r = l.match("go");
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("dup");
  });

  it("drops skills that overflow the token budget, keeping earlier matches", () => {
    const big = "词".repeat(500); // ~500 tokens of CJK
    const l = loaderWith([mk("a", "go", big), mk("b", "go", big)]);
    const r = l.match("go", { maxTokens: 600 });
    expect(r.map((s) => s.name)).toEqual(["a"]);
  });
});
