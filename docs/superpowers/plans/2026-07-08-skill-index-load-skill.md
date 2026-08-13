# 混合式 Skill 加载（索引 + load_skill 工具）实现方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有 `agents:` 强制注入与 trigger 关键字快路径的基础上，向模型注入一份轻量 skill 索引（name + description），并提供 `load_skill` 内置工具让模型按需加载 skill 正文，解决关键字触发召回差 / 误触发 / 只看当前消息的问题。

**Architecture:** 全部选择逻辑收敛为 core 里的一个纯函数 `buildSkillPromptParts()`：trigger/agent-scoped 命中的 skill 正文照旧全文注入；剩余对该 Agent 可见但未注入的 skill 以「名称: 描述」索引块进入 system prompt；模型通过新注册的 `load_skill` 工具（`createLoadSkillTool(loader)` 工厂，注册进共享 ToolRegistry）在 ReAct 循环内按需取正文。server 侧只改两处：init 时注册工具（在 general def 组装之前，使其自动进入 general 白名单），`streamAgentResponse` 里把原来两行 match+map 换成对纯函数的调用。

**Tech Stack:** TypeScript ESM monorepo（npm workspaces），Vitest（测试与源码同目录 `*.test.ts`），core 包无 HTTP/DB 依赖。

## Global Constraints

- ESM import 必须带显式 `.js` 后缀（如 `from "./loader.js"`），2 空格缩进。
- `packages/core` 不得引入 `pg`/`ioredis`/vendor SDK —— 本方案全部新代码都在 core 的 skills 模块内，仅依赖已有类型。
- TDD：每个逻辑单元先写失败测试再实现；测试文件与源码同目录。
- 工具的 `description` / 提示语与现有 `ask_user`（`packages/core/src/tools/ask-user.ts`）保持一致的中文风格。
- 不改动现有 trigger 匹配与 `agents:` 强制注入行为（`SkillLoader.match()` 的语义保持不变）。
- 测试命令：`npm test -w @lot-agent/core`（core 全量，秒级）；构建：`npm run build`。

---

## 背景（实现者需要知道的现状）

- `packages/core/src/skills/loader.ts` — `SkillLoader` 从 `skills/*.md` 加载 `Skill { name, description, triggers, content, agents? }`；`match(message, { agentId })` 返回要**全文注入**的 skill：`agents:` 声明了的对其 Agent 无条件命中，未声明的按 trigger 子串匹配当前用户消息，上限 3 个。
- `packages/server/src/services/agent-service.ts` — `init()` 中 `registerBuiltinTools()` → 注册 doc/ppt 工具 → `skillLoader.loadFromDirectory()`（约 310 行）→ 组装 `generalDef`，其 `toolNames` = ToolRegistry 里全部工具减 `DISABLED_HOST_TOOLS`（约 352 行）。`streamAgentResponse()`（约 509 行）调用 `skillLoader.match()` 并把结果 map 成 `dynamicParts`，经 `Agent` 的 `dynamicPromptParts` 进入 system prompt。
- `packages/core/src/types/index.ts` — `Tool` 接口含 `cacheable`（同参成功调用在一次 run 内复用）与 `parallelSafe`（只读可并发）；`ToolResult.errorKind` 可用 `"not_found"`。
- 垂直 Agent 的 `toolNames` 白名单在 `packages/core/src/agents/definitions/*.ts`，`definitions.test.ts` 对数组做精确断言 —— 本方案**不改**垂直 Agent 白名单（它们的核心知识走 `agents:` 强制注入；后续想让某个垂直 Agent 用索引，只需在其 `toolNames` 加 `"load_skill"`）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/core/src/skills/loader.ts` | Modify | 新增 `visibleTo(agentId?)` —— 某 Agent 视角下可见的 skill 集合 |
| `packages/core/src/skills/loader.test.ts` | Modify | `visibleTo` 的测试 |
| `packages/core/src/skills/load-skill-tool.ts` | Create | `formatSkillIndex()` 索引块、`createLoadSkillTool()` 工具工厂、`buildSkillPromptParts()` 注入编排纯函数 |
| `packages/core/src/skills/load-skill-tool.test.ts` | Create | 上述三者的测试 |
| `packages/core/src/skills/index.ts` | Modify | 导出新符号 |
| `packages/server/src/services/agent-service.ts` | Modify | init 注册 `load_skill`；streamAgentResponse 改用 `buildSkillPromptParts` |
| `CLAUDE.md` | Modify | Skills 一节补一句混合加载机制 |

---

### Task 1: `SkillLoader.visibleTo(agentId?)`

**Files:**
- Modify: `packages/core/src/skills/loader.ts`
- Test: `packages/core/src/skills/loader.test.ts`

**Interfaces:**
- Consumes: 现有 `Skill` 接口、`this.skills` 私有数组。
- Produces: `visibleTo(agentId?: string): Skill[]` —— 返回顺序保持加载顺序；无 `agents:`（或空数组）的 skill 对所有 Agent 可见；声明了 `agents:` 的仅对列表内的 agentId 可见；不传 `agentId` 时只返回未 scoped 的。Task 2 的 `buildSkillPromptParts` 依赖此签名。

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/skills/loader.test.ts` 末尾（最外层 `describe` 之内、与现有 `describe("match", …)` 平级）追加：

```ts
describe("visibleTo", () => {
  const skills: Skill[] = [
    { name: "unscoped-a", description: "a", triggers: ["aaa"], content: "A" },
    { name: "ppt-only", description: "p", triggers: [], content: "P", agents: ["ppt"] },
    { name: "unscoped-b", description: "b", triggers: [], content: "B", agents: [] },
  ];

  function loaderWith(list: Skill[]): SkillLoader {
    const loader = new SkillLoader();
    // 测试注入：绕过文件系统直接放入内部列表
    (loader as unknown as { skills: Skill[] }).skills = list;
    return loader;
  }

  it("returns unscoped skills plus skills scoped to the given agent", () => {
    const out = loaderWith(skills).visibleTo("ppt");
    expect(out.map((s) => s.name)).toEqual(["unscoped-a", "ppt-only", "unscoped-b"]);
  });

  it("hides agent-scoped skills from other agents", () => {
    const out = loaderWith(skills).visibleTo("general");
    expect(out.map((s) => s.name)).toEqual(["unscoped-a", "unscoped-b"]);
  });

  it("returns only unscoped skills when no agentId given", () => {
    const out = loaderWith(skills).visibleTo();
    expect(out.map((s) => s.name)).toEqual(["unscoped-a", "unscoped-b"]);
  });
});
```

注意：文件顶部已有的 import 若未包含 `Skill` 类型，补成 `import { SkillLoader, type Skill } from "./loader.js";`。若现有测试已有构造内存 Skill 的辅助方式（如通过 `match` 的 `opts.skills`），保持文件内一致即可，但 `visibleTo` 读取的是实例内部列表，必须走上面的注入方式。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w @lot-agent/core`
Expected: FAIL —— `loader.visibleTo is not a function`

- [ ] **Step 3: 最小实现**

在 `packages/core/src/skills/loader.ts` 的 `SkillLoader` 类中、`getSkills()` 之前加：

```ts
  /**
   * Skills visible to an agent: unscoped skills are visible to everyone;
   * agent-scoped skills only to their declared agent(s). Load order preserved.
   */
  visibleTo(agentId?: string): Skill[] {
    return this.skills.filter((s) =>
      s.agents && s.agents.length > 0 ? !!agentId && s.agents.includes(agentId) : true
    );
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w @lot-agent/core`
Expected: PASS（全部）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/loader.ts packages/core/src/skills/loader.test.ts
git commit -m "feat(core): SkillLoader.visibleTo — agent-scoped skill visibility"
```

---

### Task 2: `load_skill` 工具 + 索引块 + 注入编排纯函数

**Files:**
- Create: `packages/core/src/skills/load-skill-tool.ts`
- Create: `packages/core/src/skills/load-skill-tool.test.ts`
- Modify: `packages/core/src/skills/index.ts`

**Interfaces:**
- Consumes: Task 1 的 `SkillLoader.visibleTo(agentId?)`、现有 `SkillLoader.match(message, opts)` 与 `getSkills()`、`Tool`/`ToolResult` 类型（`packages/core/src/types/index.js`）。
- Produces（Task 3 的 server 代码按这些精确签名调用）:
  - `LOAD_SKILL_TOOL_NAME = "load_skill"` （string 常量）
  - `createLoadSkillTool(loader: SkillLoader): Tool`
  - `formatSkillIndex(skills: Skill[]): string` —— 空数组返回 `""`
  - `buildSkillPromptParts(loader: SkillLoader, message: string, agentId: string, toolNames?: string[]): string[]`

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/skills/load-skill-tool.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w @lot-agent/core`
Expected: FAIL —— 无法解析 `./load-skill-tool.js`

- [ ] **Step 3: 实现**

创建 `packages/core/src/skills/load-skill-tool.ts`：

```ts
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
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
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
```

修改 `packages/core/src/skills/index.ts` 为：

```ts
export { SkillLoader, type Skill } from "./loader.js";
export {
  LOAD_SKILL_TOOL_NAME,
  createLoadSkillTool,
  formatSkillIndex,
  buildSkillPromptParts,
} from "./load-skill-tool.js";
```

（core 根 `packages/core/src/index.ts` 已 `export * from "./skills/index.js"`，无需再改。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w @lot-agent/core`
Expected: PASS（全部，包括 Task 1 的用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/skills/load-skill-tool.ts packages/core/src/skills/load-skill-tool.test.ts packages/core/src/skills/index.ts
git commit -m "feat(core): load_skill tool + skill index + buildSkillPromptParts"
```

---

### Task 3: server 接线（注册工具 + 换用编排函数）

**Files:**
- Modify: `packages/server/src/services/agent-service.ts`

**Interfaces:**
- Consumes: Task 2 的 `createLoadSkillTool(loader)` 与 `buildSkillPromptParts(loader, message, agentId, toolNames)`，均从 `@lot-agent/core` 导入。
- Produces: `load_skill` 出现在 ToolRegistry 中且位于 `generalDef.toolNames` 内（general def 由「全部已注册工具 − DISABLED_HOST_TOOLS」组装，注册顺序保证包含）；每回合 system prompt 含索引块（general Agent）。

- [ ] **Step 1: 注册工具（顺序关键：在 generalDef 组装之前）**

在 `agent-service.ts` 的 `init()` 中找到：

```ts
    // Load skills
    await this.skillLoader.loadFromDirectory(this.skillsDir);
    console.log(`Loaded ${this.skillLoader.getSkills().length} skills`);
```

紧随其后加：

```ts
    // load_skill 按需加载工具：索引进 system prompt（见 streamAgentResponse），
    // 正文由模型判断相关后调用本工具拉取。必须在 generalDef 组装前注册，
    // general 的白名单取自「全部已注册工具 − DISABLED_HOST_TOOLS」。
    this.toolRegistry.register(createLoadSkillTool(this.skillLoader));
```

并在文件顶部的 `@lot-agent/core` import 列表中加入 `createLoadSkillTool` 与 `buildSkillPromptParts`（该 import 里已有 `SkillLoader`，直接并列追加两个名字）。

- [ ] **Step 2: 换用编排函数**

在 `streamAgentResponse()` 中找到：

```ts
    // ── Match skills, build agent ──
    const matchedSkills = this.skillLoader.match(userMessage, { agentId: def.id });
    const dynamicParts = matchedSkills.map(
      (s) => `[Skill: ${s.name}]\n${s.content}`
    );
```

替换为：

```ts
    // ── Skill prompt parts（强制注入 + trigger 预取 + 未注入技能的索引）──
    const dynamicParts = buildSkillPromptParts(
      this.skillLoader,
      userMessage,
      def.id,
      def.toolNames
    );
```

- [ ] **Step 3: 编译 + 全量测试**

Run: `npm run build && npm test`
Expected: 构建通过；vitest 全绿（core + server；`definitions.test.ts` 不受影响，因为垂直 Agent 白名单未动）

- [ ] **Step 4: 冒烟验证（DEBUG 模式，验证索引与工具真的生效）**

启动依赖齐全时执行（需要本地 Postgres/Redis；若环境不可用，记录为待人工验证并继续）：

```bash
DEBUG=1 DEBUG_LLM=1 npm run dev:server
```

另开终端，用一条**不含任何 trigger 词**但语义相关的消息试探（doc-generation 的 trigger 全是「生成文档/导出…」类词，这句刻意避开）：

1. 建会话并发消息「帮我把这份内容整理成一份可以下载的 word 版本：……」。
2. 观察 `DEBUG_LLM=1` 的请求日志：system prompt 应包含 `[可用技能索引]` 且列有 `- doc-generation:`。
3. 期望模型先调 `load_skill {"name":"doc-generation"}` 再调 `generate_document`（模型行为非确定，索引出现在 prompt 即为接线成功；工具被实际调用则为端到端成功）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/agent-service.ts
git commit -m "feat(server): wire load_skill tool + per-turn skill index into agent runs"
```

---

### Task 4: 文档更新

**Files:**
- Modify: `CLAUDE.md`（`## Key concepts` 下的 **Skills** 条目）

**Interfaces:** 无代码接口；纯文档。

- [ ] **Step 1: 更新 CLAUDE.md 的 Skills 条目**

找到：

```markdown
- **Skills**: markdown files in root `skills/`, frontmatter supports `agents:` (scope a skill to
  specific Agent ids) and `triggers:` (substring match on the user message).
```

替换为：

```markdown
- **Skills**: markdown files in root `skills/`, frontmatter supports `agents:` (scope a skill to
  specific Agent ids) and `triggers:` (substring match on the user message). Loading is hybrid:
  `agents:` skills are force-injected for their Agent; trigger hits are a prefetch fast path;
  everything else is exposed as a name+description index in the system prompt and loaded on
  demand via the `load_skill` builtin tool (`core/skills/load-skill-tool.ts`,
  `buildSkillPromptParts`). Vertical agents opt in by adding `"load_skill"` to `toolNames`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe hybrid skill loading (index + load_skill)"
```

---

## 明确不做（YAGNI）

- 不改垂直 Agent（ppt/contract/copywriting/image/video）的 `toolNames` —— 它们的知识走 `agents:` 强制注入，改白名单会连带改 `definitions.test.ts` 的精确断言，等有真实需求再加一行。
- 不做 embedding/语义检索选 skill（那是 E4 RAG 的事），不做 skill 内容分段加载。
- 不给索引块做 token 预算控制：索引每条一行（name + description），三五个 skill 合计几十 token，远低于正文注入的量级；skill 数量上百时再考虑。
- `GET /api/skills` 路由与 web 端不动 —— `load_skill` 的 tool_call 走现有 SSE 工具事件渲染。
