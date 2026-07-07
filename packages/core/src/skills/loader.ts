import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { logger } from "../logger/log.js";
import { estimateTokens } from "../context/tokenizer.js";

const log = logger.child({ mod: "skills" });

/** Default cap on how many skills match() returns. */
const DEFAULT_MAX_SKILLS = 3;

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  content: string;
  agents?: string[];
}

interface SkillFrontmatter {
  name: string;
  description: string;
  triggers: string[];
  agents: string[];
}

function unquote(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(raw: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  // Support both \n and \r\n line endings
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error("Invalid skill file: missing frontmatter (expected ---\\n...\\n---\\n)");
  }

  const [, yamlStr, body] = match;
  const frontmatter: SkillFrontmatter = {
    name: "",
    description: "",
    triggers: [],
    agents: [],
  };

  let currentKey = "";
  const lines = yamlStr.split(/\r?\n/);

  for (const line of lines) {
    // Key-value line: "key: value"
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      currentKey = key;
      const trimmedValue = value.trim();

      if (key === "triggers" || key === "agents") {
        (frontmatter as unknown as Record<string, string[]>)[key] = [];
        // Inline value like `triggers: [a, b]`
        if (trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) {
          (frontmatter as unknown as Record<string, string[]>)[key] = trimmedValue
            .slice(1, -1)
            .split(",")
            .map((s) => unquote(s))
            .filter(Boolean);
        } else if (trimmedValue) {
          (frontmatter as unknown as Record<string, string[]>)[key] = [unquote(trimmedValue)];
        }
        // Otherwise list items come on subsequent "- item" lines
      } else {
        (frontmatter as unknown as Record<string, unknown>)[key] = unquote(trimmedValue);
      }
      continue;
    }

    // List item line: "- item" (with any leading whitespace)
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && (currentKey === "triggers" || currentKey === "agents")) {
      (frontmatter as unknown as Record<string, string[]>)[currentKey].push(
        unquote(listMatch[1])
      );
    }
  }

  return { frontmatter, body: body.trim() };
}

export class SkillLoader {
  private skills: Skill[] = [];

  async loadFromDirectory(dir: string): Promise<Skill[]> {
    this.skills = [];
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (extname(entry) !== ".md") continue;
        try {
          const skill = await this.loadFile(join(dir, entry));
          this.skills.push(skill);
        } catch (error) {
          log.warn("failed to load skill", { file: entry, err: error as Error });
        }
      }
      if (this.skills.length === 0) {
        log.warn("no skills found", { dir });
      }
    } catch (error) {
      log.warn("failed to read skills directory", { dir, err: error as Error });
    }
    return this.skills;
  }

  async loadFile(filePath: string): Promise<Skill> {
    const raw = await readFile(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      triggers: frontmatter.triggers,
      content: body,
      agents: frontmatter.agents,
    };
  }

  /**
   * Select skills to inject for a message. Agent-scoped skills always match
   * their agent; unscoped skills match on trigger substrings. Results are
   * deduped by name, capped to `maxSkills` (default 3), and — when `maxTokens`
   * is set — greedily kept only while the cumulative content token estimate
   * fits the budget (overflowing skills are dropped, earlier matches win).
   */
  match(
    message: string,
    opts?: { agentId?: string; skills?: Skill[]; maxSkills?: number; maxTokens?: number }
  ): Skill[] {
    const target = opts?.skills ?? this.skills;
    const lower = message.toLowerCase();
    const maxSkills = opts?.maxSkills ?? DEFAULT_MAX_SKILLS;

    const out: Skill[] = [];
    const seen = new Set<string>();
    let usedTokens = 0;

    for (const s of target) {
      if (out.length >= maxSkills) break;

      const hit =
        s.agents && s.agents.length > 0
          ? // Agent-scoped: inject unconditionally for its declared agent(s),
            // never for any other agent, regardless of trigger words.
            !!opts?.agentId && s.agents.includes(opts.agentId)
          : s.triggers.some((t) => lower.includes(t.toLowerCase()));
      if (!hit) continue;

      if (seen.has(s.name)) continue; // dedup by name

      if (opts?.maxTokens !== undefined) {
        const cost = estimateTokens(s.content);
        if (usedTokens + cost > opts.maxTokens && out.length > 0) continue;
        usedTokens += cost;
      }

      seen.add(s.name);
      out.push(s);
    }
    return out;
  }

  getSkills(): Skill[] {
    return this.skills;
  }
}
