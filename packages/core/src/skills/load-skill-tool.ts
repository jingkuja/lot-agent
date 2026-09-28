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
      "Load a skill document by name. [Available skills] lists names and purposes. Load a relevant skill before following its workflow.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name from [Available skills].",
        },
      },
      required: ["name"],
    },
    cacheable: true,
    retrySafe: true,
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
          content: `Skill not found "${name}". Available skills: ${available || "(none)"}`,
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
    "[Available skills]\n" +
    "The following skills are not loaded. When a skill is relevant, " +
    `call ${LOAD_SKILL_TOOL_NAME} to load it before continuing. Do not load irrelevant skills.\n` +
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
