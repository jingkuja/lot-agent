import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";

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
          console.warn(`Failed to load skill ${entry}:`, error);
        }
      }
      if (this.skills.length === 0) {
        console.warn(`No skills found in ${dir}`);
      }
    } catch (error) {
      console.warn(`Failed to read skills directory ${dir}:`, error);
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

  match(message: string, opts?: { agentId?: string; skills?: Skill[] }): Skill[] {
    const target = opts?.skills ?? this.skills;
    const lower = message.toLowerCase();
    const out: Skill[] = [];
    for (const s of target) {
      if (s.agents && s.agents.length > 0) {
        // Agent-scoped skill: inject unconditionally for its declared agent(s),
        // never for any other agent, regardless of trigger words.
        if (opts?.agentId && s.agents.includes(opts.agentId)) out.push(s);
      } else if (s.triggers.some((t) => lower.includes(t.toLowerCase()))) {
        out.push(s);
      }
    }
    return out;
  }

  getSkills(): Skill[] {
    return this.skills;
  }
}
