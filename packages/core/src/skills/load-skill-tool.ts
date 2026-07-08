import type { Tool, ToolResult } from "../types/index.js";
import type { Skill, SkillLoader } from "./loader.js";

export const LOAD_SKILL_TOOL_NAME = "load_skill";

interface LoadSkillInput {
  name?: string;
}

/**
 * On-demand skill loading tool. The per-turn system prompt carries a
 * lightweight index (name + description, see formatSkillIndex); the model
 * calls this tool to pull a skill's full content into context only when the
 * task actually needs it.
 */
export function createLoadSkillTool(loader: SkillLoader): Tool {
  return {
    name: LOAD_SKILL_TOOL_NAME,
    description:
      "按名称加载一个技能文档的完整内容。系统提示中的 [可用技能索引] 列出了可加载的技能名称与用途；" +
      "当当前任务与某个技能相关时，先调用本工具加载它，再按其中的方法执行任务。",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "要加载的技能名称（必须来自 [可用技能索引] 中列出的名称）",
        },
      },
      required: ["name"],
    },
    cacheable: true,
    parallelSafe: true,
    async execute(input): Promise<ToolResult> {
      const { name } = (input as LoadSkillInput) ?? {};
      // The per-turn index gates discovery, not access: any loaded skill is
      // loadable by name (the shared tool has no per-request agent scope).
      const skill = loader.getSkills().find((s) => s.name === name);
      if (!skill) {
        const available = loader
          .getSkills()
          .map((s) => s.name)
          .join(", ");
        return {
          content: `未找到技能 "${name}"。可用技能: ${available || "（无）"}`,
          isError: true,
          errorKind: "not_found",
        };
      }
      return { content: `[Skill: ${skill.name}]\n${skill.content}` };
    },
  };
}

/**
 * System-prompt index block for skills that are NOT already injected this
 * turn. Metadata only — full content stays out of context until load_skill
 * is called. Returns "" when there is nothing to index.
 */
export function formatSkillIndex(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => (s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`));
  return (
    "[可用技能索引]\n" +
    "以下技能的完整内容尚未加载。当当前任务与某个技能相关时，" +
    `先调用 ${LOAD_SKILL_TOOL_NAME} 工具加载它，再继续执行；与任务无关时不要加载。\n` +
    lines.join("\n")
  );
}

/**
 * Assemble the per-turn skill prompt parts:
 * 1. Full content for skills selected by SkillLoader.match() — agent-scoped
 *    forced injection plus trigger-keyword prefetch (unchanged fast path).
 * 2. When the agent may call load_skill (whitelist contains it, or an
 *    undefined whitelist = all tools), an index block for the remaining
 *    skills visible to this agent, so the model can load them on demand.
 */
export function buildSkillPromptParts(
  loader: SkillLoader,
  message: string,
  agentId: string,
  toolNames?: string[]
): string[] {
  const matched = loader.match(message, { agentId });
  const parts = matched.map((s) => `[Skill: ${s.name}]\n${s.content}`);

  const canLoad = !toolNames || toolNames.includes(LOAD_SKILL_TOOL_NAME);
  if (canLoad) {
    const injected = new Set(matched.map((s) => s.name));
    const indexable = loader.visibleTo(agentId).filter((s) => !injected.has(s.name));
    const index = formatSkillIndex(indexable);
    if (index) parts.push(index);
  }
  return parts;
}
