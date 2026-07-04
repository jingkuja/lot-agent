# PPT 制作质量重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `ppt` Agent 的产出从「单调 bullet 列表」升级为「10 种版式 × 可换主题 × 结构化大纲确认」，并让模版/背景图解析真正保留设计感。

**Architecture:** 三个正交层——版式库（`ppt/layouts/*` 每版式一个 builder）、ThemePack（主题参数：配色/字体/装饰/背景图，来源可为模版解析 / 背景图上传 / 内置预设）、制作工艺 skill（agent 作用域，承载叙事与选版规则）。渲染仍走 pptxgenjs 纯代码绘制，产出原生可编辑 .pptx；`SlideSpec → 渲染器` 接口边界保留。交互上新增 `propose_outline`（复用 ask_user 的 `endsTurn` 回合制）+ 前端 OutlineCard。

**Tech Stack:** TypeScript ESM 单仓（npm workspaces）；`@lot-agent/core`（tsup）、`@lot-agent/server`（Hono + pg + pptxgenjs + jszip，tsup）、`@lot-agent/web`（React 19 + Vite）；测试 Vitest，测试文件 `*.test.ts` 就近放置。

## Global Constraints

- **ESM 导入必须带 `.js` 后缀**（如 `from "./renderer.js"`），2 空格缩进。
- **TDD**：纯逻辑单元先写失败测试再实现，测试就近放为 `*.test.ts`。
- **接口在 core、实现在 server**：需要 pg/redis/pptxgenjs 的实现留在 server；core 不引入这些依赖。
- **不新增运行时依赖**：只用已装的 `pptxgenjs`、`jszip`；不引入图片解码库（sharp/jimp 等）。
- **主题颜色为 6 位 hex、无 `#` 前缀**（沿用 `PptTheme` 现有约定）。
- **NUMERIC from pg 是字符串**，用 `Number()` 转（本计划不新增 NUMERIC 列，仅提醒）。
- **web 配色只用 `var(--*)` token**（见 `App.css`：`:root` 亮色、`[data-theme="dark"]` 暗色覆盖），禁止硬编码 hex/rgba。
- **不暴露内部 id**：给用户的文案里不出现 assetId 等内部细节（沿用现有红线）。
- **pptxgenjs 必须用 `createRequire` 引入**（见 `renderer.ts:11`，规避 tsx 下 `ERR_REQUIRE_CYCLE_MODULE`）；新文件若需 pptxgenjs 从 `renderer.ts` 复用同一实例，不要各自 `import`。
- **每个任务结束提交一次**，提交信息用仓库现有中文风格。

---

## 文件结构（本计划新建/修改）

**core**
- 修改 `packages/core/src/skills/loader.ts` — `Skill` 增 `agents?: string[]`；`match` 支持按 agent 过滤 + 无条件注入 agent 作用域 skill。
- 修改 `packages/core/src/agents/definitions/ppt.ts` — systemPrompt 精简为角色+红线，工具增 `propose_outline`。

**server / ppt**
- 修改 `packages/server/src/ppt/renderer.ts` — `PptSlide` v2 类型、`validateSlides`、`PptTheme` 扩展（`decor`/`backgrounds`）、`renderPptx` 改为构建 `BuildCtx` + 分发、共享 helper（accent 轮换、页脚、装饰、背景）。
- 新建 `packages/server/src/ppt/layouts/` — 每版式一个 builder：`cover.ts` `agenda.ts` `section.ts` `content.ts` `keypoints.ts` `stats.ts` `compare.ts` `timeline.ts` `quote.ts` `closing.ts` + `index.ts`（分发表）+ `ctx.ts`（共享类型与 helper）。
- 新建 `packages/server/src/ppt/themes.ts` — 5 套内置 ThemePack 预设 + `getPreset`。
- 修改 `packages/server/src/ppt/theme-extractor.ts` — `extractBackgrounds`（从模版 zip 提背景图）。
- 修改 `packages/server/src/ppt/theme-extractor.fixture.ts`（若无则复用 `template-renderer.fixture.ts`）— 已含母版背景图，可直接用。
- 新建/修改测试：`validation.test.ts`、`themes.test.ts`、`layouts.test.ts`、`renderer.test.ts`、`theme-extractor.test.ts`。

**server / tools & routes**
- 修改 `packages/server/src/tools/ppt-tool.ts` — v2 schema、`themePreset`、`backgrounds` 参数、主题降级链重排、`validateSlides`。
- 新建 `packages/server/src/tools/propose-outline-tool.ts` — `propose_outline`（`endsTurn`）。
- 修改 `packages/server/src/services/agent-service.ts` — 注册 `propose_outline`；skill 注入按 agentId 过滤。
- 修改 `packages/server/src/services/attachment-extractor.ts` — 新 slot `ppt_background`。
- 修改 `packages/server/src/routes/conversations.ts` — slot 白名单加 `ppt_background`。

**web**
- 修改 `packages/web/src/api/client.ts` — `AttachmentSlot` 加 `ppt_background`。
- 修改 `packages/web/src/components/InputBox.tsx` — PPT 模式「背景图」上传按钮 + chip。
- 新建 `packages/web/src/components/OutlineCard.tsx` — 大纲卡片。
- 新建 `packages/web/src/lib/layout-icons.tsx` — 版式图标。
- 修改 `packages/web/src/components/MessageBubble.tsx` + `ChatPanel.tsx` — 渲染 `propose_outline` 卡片。
- 修改 `packages/web/src/App.css` — OutlineCard / 背景图 chip 样式（用 token）。

**skills**
- 新建 `skills/ppt-authoring.md` — agent 作用域制作工艺 skill。

---

# 阶段 P1：版式库 + 主题预设 + 作用域 skill

## Task 1: SlideSpec v2 类型 + validateSlides（纯逻辑）

**Files:**
- Modify: `packages/server/src/ppt/renderer.ts`（`PptSlide` / `PptOutline` 类型段，第 14-24 行）
- Create: `packages/server/src/ppt/validation.ts`
- Test: `packages/server/src/ppt/validation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // renderer.ts 导出
  export type PptLayout =
    | "cover" | "agenda" | "section" | "content" | "keypoints"
    | "stats" | "compare" | "timeline" | "quote" | "closing";
  export interface PptItem { label: string; value?: string; desc?: string }
  export interface PptColumn { title: string; bullets: string[] }
  export interface PptQuote { text: string; author?: string }
  export interface PptSlide {
    layout: PptLayout;
    title: string;
    subtitle?: string;
    bullets?: string[];
    items?: PptItem[];
    left?: PptColumn;
    right?: PptColumn;
    quote?: PptQuote;
    notes?: string;
  }
  export interface PptOutline { title: string; slides: PptSlide[] }
  // validation.ts 导出
  export function validateSlides(slides: unknown): string | null; // 首个错误消息；null=通过
  export const PPT_LAYOUTS: readonly PptLayout[];
  ```

- [ ] **Step 1: 写失败测试** — `packages/server/src/ppt/validation.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { validateSlides } from "./validation.js";

describe("validateSlides", () => {
  it("passes a well-formed mixed deck", () => {
    expect(
      validateSlides([
        { layout: "cover", title: "T", subtitle: "S" },
        { layout: "stats", title: "数据", items: [{ value: "65%", label: "增长" }, { value: "3x", label: "效率" }] },
        { layout: "compare", title: "对比", left: { title: "旧", bullets: ["a"] }, right: { title: "新", bullets: ["b"] } },
        { layout: "timeline", title: "节奏", items: [{ label: "1" }, { label: "2" }, { label: "3" }] },
        { layout: "quote", title: "", quote: { text: "金句", author: "某人" } },
        { layout: "content", title: "要点", bullets: ["x"] },
      ])
    ).toBeNull();
  });

  it("rejects empty array", () => {
    expect(validateSlides([])).toMatch(/至少一页|non-empty|空/);
  });

  it("rejects unknown layout", () => {
    expect(validateSlides([{ layout: "grid", title: "x" }])).toMatch(/layout/);
  });

  it("requires non-empty title on cover/section/closing", () => {
    expect(validateSlides([{ layout: "section", title: "  " }])).toMatch(/title|标题/);
  });

  it("stats requires 2-4 items each with value+label", () => {
    expect(validateSlides([{ layout: "stats", title: "t", items: [{ value: "1", label: "a" }] }])).toMatch(/stats/);
    expect(validateSlides([{ layout: "stats", title: "t", items: [{ label: "a" }, { label: "b" }] }])).toMatch(/value/);
  });

  it("compare requires both columns with 1-5 bullets", () => {
    expect(validateSlides([{ layout: "compare", title: "t", left: { title: "l", bullets: ["a"] } }])).toMatch(/compare|right/);
  });

  it("timeline requires 3-6 items", () => {
    expect(validateSlides([{ layout: "timeline", title: "t", items: [{ label: "1" }, { label: "2" }] }])).toMatch(/timeline/);
  });

  it("content bullets capped at 8", () => {
    const many = Array.from({ length: 9 }, (_, i) => `b${i}`);
    expect(validateSlides([{ layout: "content", title: "t", bullets: many }])).toMatch(/content|8/);
  });

  it("rejects more than 40 slides", () => {
    const s = Array.from({ length: 41 }, () => ({ layout: "content", title: "t", bullets: ["x"] }));
    expect(validateSlides(s)).toMatch(/40/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @lot-agent/server -- validation`
Expected: FAIL（`validation.js` 不存在 / `validateSlides` 未定义）

- [ ] **Step 3: 在 `renderer.ts` 替换类型段**（第 14-24 行原 `PptSlide`/`PptOutline`）

```ts
export type PptLayout =
  | "cover" | "agenda" | "section" | "content" | "keypoints"
  | "stats" | "compare" | "timeline" | "quote" | "closing";
export interface PptItem { label: string; value?: string; desc?: string }
export interface PptColumn { title: string; bullets: string[] }
export interface PptQuote { text: string; author?: string }
export interface PptSlide {
  layout: PptLayout;
  title: string;
  subtitle?: string;
  bullets?: string[];
  items?: PptItem[];
  left?: PptColumn;
  right?: PptColumn;
  quote?: PptQuote;
  notes?: string;
}
export interface PptOutline { title: string; slides: PptSlide[] }
```

- [ ] **Step 4: 实现 `validation.ts`**

```ts
import type { PptLayout, PptSlide } from "./renderer.js";

export const PPT_LAYOUTS: readonly PptLayout[] = [
  "cover", "agenda", "section", "content", "keypoints",
  "stats", "compare", "timeline", "quote", "closing",
];
const LAYOUT_SET = new Set<string>(PPT_LAYOUTS);
const MAX_SLIDES = 40;

function nonEmpty(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}
function bulletsOk(b: unknown, min: number, max: number): boolean {
  return Array.isArray(b) && b.length >= min && b.length <= max && b.every((x) => typeof x === "string");
}

/** 逐版式校验；返回首个错误消息（中文，便于 LLM 自修复），全部通过返回 null。 */
export function validateSlides(slides: unknown): string | null {
  if (!Array.isArray(slides) || slides.length === 0) return "slides 需为非空数组（至少一页）。";
  if (slides.length > MAX_SLIDES) return `slides 过多（最多 ${MAX_SLIDES} 页）。`;
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i] as PptSlide;
    const at = `第 ${i + 1} 页`;
    if (!s || typeof s !== "object") return `${at}不是合法对象。`;
    if (!LAYOUT_SET.has(s.layout)) return `${at}的 layout 非法（应为 ${PPT_LAYOUTS.join("/")}）。`;
    if (s.layout !== "quote" && !nonEmpty(s.title)) return `${at}(${s.layout}) 需要非空 title。`;
    switch (s.layout) {
      case "content":
        if (!bulletsOk(s.bullets, 1, 8)) return `${at}(content) 需要 1-8 条 bullets。`;
        break;
      case "agenda":
        if (s.items !== undefined && !(Array.isArray(s.items) && s.items.length >= 2 && s.items.length <= 10))
          return `${at}(agenda) 的 items 给出时需 2-10 条（也可缺省自动生成）。`;
        break;
      case "keypoints":
        if (!Array.isArray(s.items) || s.items.length < 2 || s.items.length > 6)
          return `${at}(keypoints) 需要 2-6 个 items。`;
        if (!s.items.every((it) => nonEmpty(it?.label))) return `${at}(keypoints) 每个 item 需要 label。`;
        break;
      case "stats":
        if (!Array.isArray(s.items) || s.items.length < 2 || s.items.length > 4)
          return `${at}(stats) 需要 2-4 个 items。`;
        if (!s.items.every((it) => nonEmpty(it?.value) && nonEmpty(it?.label)))
          return `${at}(stats) 每个 item 需要 value 与 label。`;
        break;
      case "compare":
        if (!s.left || !s.right || !nonEmpty(s.left.title) || !nonEmpty(s.right.title))
          return `${at}(compare) 需要 left 与 right，且各有 title。`;
        if (!bulletsOk(s.left.bullets, 1, 5) || !bulletsOk(s.right.bullets, 1, 5))
          return `${at}(compare) 的 left/right 各需 1-5 条 bullets。`;
        break;
      case "timeline":
        if (!Array.isArray(s.items) || s.items.length < 3 || s.items.length > 6)
          return `${at}(timeline) 需要 3-6 个 items。`;
        if (!s.items.every((it) => nonEmpty(it?.label))) return `${at}(timeline) 每个 item 需要 label。`;
        break;
      case "quote":
        if (!s.quote || !nonEmpty(s.quote.text)) return `${at}(quote) 需要非空 quote.text。`;
        break;
      // cover / section / closing：title 已校验
    }
  }
  return null;
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test -w @lot-agent/server -- validation`
Expected: PASS（9 测试）

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/ppt/renderer.ts packages/server/src/ppt/validation.ts packages/server/src/ppt/validation.test.ts
git commit -m "feat(ppt): SlideSpec v2 类型与逐版式校验 validateSlides"
```

---

## Task 2: 内置主题预设 + PptTheme.decor 字段

**Files:**
- Modify: `packages/server/src/ppt/theme-extractor.ts`（`PptTheme` 接口 + `DEFAULT_THEME`）
- Create: `packages/server/src/ppt/themes.ts`
- Test: `packages/server/src/ppt/themes.test.ts`

**Interfaces:**
- Consumes: `PptTheme`（theme-extractor.ts，本任务为其加 `decor`）
- Produces:
  ```ts
  export type Decor = "circles" | "slant" | "grid" | "minimal";
  // PptTheme 新增：decor: Decor
  export const THEME_PRESETS: Record<string, PptTheme>; // key: business/tech-dark/warm/mono/academic
  export function getPreset(name?: string): PptTheme | null;
  export const PRESET_LABELS: { id: string; label: string }[]; // 供 agent/ask_user 选项
  ```

- [ ] **Step 1: 给 `PptTheme` 加 `decor`（theme-extractor.ts）**

在 `PptTheme` 接口（第 4-14 行）末尾加一行，并在 `DEFAULT_THEME`（第 16-25 行）补 `decor`：

```ts
// PptTheme 接口内，slideHeightIn 之后：
  /** 装饰语言：几何圆 / 斜切色块 / 细网格 / 无装饰。 */
  decor: "circles" | "slant" | "grid" | "minimal";
```
```ts
// DEFAULT_THEME 内，slideHeightIn: 7.5 之后：
  decor: "circles",
```
> 现有 `extractTheme` 返回的成功分支对象（第 130 行 `return { colors, fonts, slideWidthIn, slideHeightIn };`）需补 `decor: "circles"`，否则类型不满足。改为：
> `return { colors, fonts, slideWidthIn, slideHeightIn, decor: "circles" };`

- [ ] **Step 2: 写失败测试** — `themes.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { THEME_PRESETS, getPreset, PRESET_LABELS } from "./themes.js";

describe("theme presets", () => {
  it("exposes 5 complete presets", () => {
    expect(Object.keys(THEME_PRESETS)).toHaveLength(5);
    for (const t of Object.values(THEME_PRESETS)) {
      expect(t.colors.accent1).toMatch(/^[0-9A-F]{6}$/);
      expect(t.colors.accent6).toMatch(/^[0-9A-F]{6}$/);
      expect(["circles", "slant", "grid", "minimal"]).toContain(t.decor);
    }
  });
  it("getPreset resolves by id, null on miss", () => {
    expect(getPreset("tech-dark")).toBe(THEME_PRESETS["tech-dark"]);
    expect(getPreset("nope")).toBeNull();
    expect(getPreset(undefined)).toBeNull();
  });
  it("PRESET_LABELS matches preset keys", () => {
    expect(PRESET_LABELS.map((p) => p.id).sort()).toEqual(Object.keys(THEME_PRESETS).sort());
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm test -w @lot-agent/server -- themes`
Expected: FAIL（`themes.js` 不存在）

- [ ] **Step 4: 实现 `themes.ts`**

```ts
import { DEFAULT_THEME, type PptTheme } from "./theme-extractor.js";

const FONTS = { major: "Microsoft YaHei", minor: "Microsoft YaHei" };
const SIZE = { slideWidthIn: 13.333, slideHeightIn: 7.5 };

/** 5 套完整 ThemePack；配色为 6 位 hex 无 #，与 PptTheme 约定一致。 */
export const THEME_PRESETS: Record<string, PptTheme> = {
  business: {
    colors: { dk1: "1B2A4A", lt1: "FFFFFF", lt2: "F2F5FA", dk2: "3C4A63",
      accent1: "2D6CDF", accent2: "17A2B8", accent3: "6C5CE7",
      accent4: "00B894", accent5: "0984E3", accent6: "E17055" },
    fonts: FONTS, ...SIZE, decor: "circles",
  },
  "tech-dark": {
    colors: { dk1: "E8ECF4", lt1: "FFFFFF", lt2: "141A24", dk2: "AEB8CC",
      accent1: "4C8DFF", accent2: "22D3EE", accent3: "A78BFA",
      accent4: "34D399", accent5: "60A5FA", accent6: "F472B6" },
    fonts: FONTS, ...SIZE, decor: "grid",
  },
  warm: {
    colors: { dk1: "3A2A1E", lt1: "FFFFFF", lt2: "FDF6EF", dk2: "6B4E3A",
      accent1: "E8590C", accent2: "F08C00", accent3: "E03131",
      accent4: "F59F00", accent5: "D9480F", accent6: "C2255C" },
    fonts: FONTS, ...SIZE, decor: "slant",
  },
  mono: {
    colors: { dk1: "1A1A1A", lt1: "FFFFFF", lt2: "F5F5F5", dk2: "4A4A4A",
      accent1: "222222", accent2: "555555", accent3: "888888",
      accent4: "2D2D2D", accent5: "6E6E6E", accent6: "999999" },
    fonts: FONTS, ...SIZE, decor: "minimal",
  },
  academic: {
    colors: { dk1: "17332A", lt1: "FFFFFF", lt2: "F0F5F2", dk2: "365248",
      accent1: "2F9E6E", accent2: "1E7A54", accent3: "3BAE8C",
      accent4: "0CA678", accent5: "099268", accent6: "66A80F" },
    fonts: FONTS, ...SIZE, decor: "grid",
  },
};

export const PRESET_LABELS: { id: string; label: string }[] = [
  { id: "business", label: "商务蓝" },
  { id: "tech-dark", label: "科技深色" },
  { id: "warm", label: "暖橙创意" },
  { id: "mono", label: "极简黑白" },
  { id: "academic", label: "学术绿" },
];

export function getPreset(name?: string): PptTheme | null {
  if (!name) return null;
  return THEME_PRESETS[name] ?? null;
}

// 确保 DEFAULT_THEME 被引用（避免 tree-shake 顾虑，无副作用）
export const FALLBACK_THEME: PptTheme = DEFAULT_THEME;
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test -w @lot-agent/server -- themes`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/ppt/theme-extractor.ts packages/server/src/ppt/themes.ts packages/server/src/ppt/themes.test.ts
git commit -m "feat(ppt): PptTheme 增 decor 字段 + 5 套内置主题预设"
```

---

## Task 3: 渲染器重构为 layouts/ + 共享 helper（迁移现有 3 版式）

保持 `renderer.test.ts` 现有断言全绿；把 cover/section/content 抽到独立 builder，引入 `BuildCtx`、accent 轮换、页脚、装饰 helper。**本任务不改视觉断言，只重构 + 加 helper 骨架**（新装饰/页脚绘制但不破坏原有测试）。

**Files:**
- Create: `packages/server/src/ppt/layouts/ctx.ts`
- Create: `packages/server/src/ppt/layouts/cover.ts` `section.ts` `content.ts` `index.ts`
- Modify: `packages/server/src/ppt/renderer.ts`（`renderPptx` 循环改为构建 ctx + 分发；`darken` 移入 ctx.ts）
- Test: 复用现有 `renderer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // layouts/ctx.ts
  export type PptxSlide = any; // pptxgenjs slide（该库无好用类型，保持 any，与 renderer.ts 现状一致）
  export interface BuildCtx {
    c: PptTheme["colors"]; f: PptTheme["fonts"];
    W: number; H: number; theme: PptTheme;
    index: number; total: number; presTitle: string;
  }
  export function darken(hex: string, amount: number): string;
  export function accentAt(c: PptTheme["colors"], i: number): string; // accent1..6 轮换
  export function drawDecor(slide: PptxSlide, ctx: BuildCtx): void;    // 依 theme.decor
  export function drawFooter(slide: PptxSlide, ctx: BuildCtx): void;   // 页码+标题+分隔线
  // layouts/index.ts
  export const BUILDERS: Record<PptLayout, (slide: PptxSlide, s: PptSlide, ctx: BuildCtx) => void>;
  ```
- Consumes: `PptSlide`/`PptLayout`（renderer.ts, Task 1）、`PptTheme`（theme-extractor.ts, Task 2）

- [ ] **Step 1: 实现 `layouts/ctx.ts`**

```ts
import type { PptTheme } from "../theme-extractor.js";

export type PptxSlide = any;

export interface BuildCtx {
  c: PptTheme["colors"];
  f: PptTheme["fonts"];
  W: number;
  H: number;
  theme: PptTheme;
  index: number;   // 0-based
  total: number;
  presTitle: string;
}

/** 把 hex 调暗 amount（0-1）。 */
export function darken(hex: string, amount: number): string {
  const p = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount));
  return [p(0), p(2), p(4)]
    .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

const ACCENTS: (keyof PptTheme["colors"])[] = [
  "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
];
/** 按序轮换取 accent 色（用于卡片/节点/序号多彩化）。 */
export function accentAt(c: PptTheme["colors"], i: number): string {
  return c[ACCENTS[((i % 6) + 6) % 6]];
}

/** 依主题装饰语言画角落装饰；minimal 不画。 */
export function drawDecor(slide: PptxSlide, ctx: BuildCtx): void {
  const { c, W, H, theme } = ctx;
  if (theme.decor === "minimal") return;
  if (theme.decor === "circles") {
    slide.addShape("ellipse", { x: W * 0.82, y: -H * 0.12, w: H * 0.42, h: H * 0.42, fill: { color: c.accent1, transparency: 92 }, line: { type: "none" } });
    return;
  }
  if (theme.decor === "slant") {
    slide.addShape("rect", { x: W * 0.88, y: 0, w: W * 0.12, h: H, fill: { color: c.accent1, transparency: 90 }, line: { type: "none" }, rotate: 12 });
    return;
  }
  if (theme.decor === "grid") {
    for (let i = 1; i <= 3; i++) {
      slide.addShape("line", { x: 0, y: (H / 4) * i, w: W, h: 0, line: { color: c.dk2, width: 0.5, transparency: 92 } });
    }
  }
}

/** 内容类版式底部：细分隔线 + 演示标题 + 页码。 */
export function drawFooter(slide: PptxSlide, ctx: BuildCtx): void {
  const { c, f, W, H, index, total, presTitle } = ctx;
  slide.addShape("line", { x: W * 0.06, y: H * 0.93, w: W * 0.88, h: 0, line: { color: c.dk2, width: 0.75, transparency: 80 } });
  slide.addText(presTitle, { x: W * 0.06, y: H * 0.935, w: W * 0.6, h: 0.3, fontFace: f.minor, fontSize: 9, color: c.dk2, valign: "middle" });
  slide.addText(`${index + 1} / ${total}`, { x: W * 0.74, y: H * 0.935, w: W * 0.2, h: 0.3, fontFace: f.minor, fontSize: 9, color: c.dk2, align: "right", valign: "middle" });
}
```

- [ ] **Step 2: 实现 `layouts/cover.ts`**（迁移现有 buildCover，逻辑等价 + subtitle 支持）

```ts
import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, darken } from "./ctx.js";

export function buildCover(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  const bottom = darken(c.accent1, 0.2);
  slide.background = { color: c.accent1 };
  slide.addShape("rect", {
    x: 0, y: 0, w: W, h: H,
    fill: { type: "gradient", gradientType: "linear", angle: 135, stops: [{ color: c.accent1, position: 0 }, { color: bottom, position: 100 }] },
  });
  slide.addShape("ellipse", { x: W * 0.72, y: -H * 0.18, w: H * 0.65, h: H * 0.65, fill: { color: "FFFFFF", transparency: 90 } });
  slide.addShape("ellipse", { x: -W * 0.06, y: H * 0.72, w: H * 0.35, h: H * 0.35, fill: { color: "FFFFFF", transparency: 88 } });
  slide.addText(s.title, { x: W * 0.08, y: H * 0.32, w: W * 0.84, h: H * 0.24, fontFace: f.major, fontSize: 42, bold: true, color: c.lt1 });
  const sub = s.subtitle ?? s.bullets?.join("  ·  ");
  if (sub) slide.addText(sub, { x: W * 0.08, y: H * 0.6, w: W * 0.84, h: H * 0.12, fontFace: f.minor, fontSize: 16, color: c.lt2 });
}
```

- [ ] **Step 3: 实现 `layouts/section.ts`**（迁移 buildSection + 大章节号 + subtitle）

```ts
import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, darken, accentAt } from "./ctx.js";

export function buildSection(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H, index } = ctx;
  const accent = accentAt(c, index);
  slide.background = { color: c.lt2 };
  slide.addShape("rect", {
    x: 0, y: 0, w: W * 0.06, h: H,
    fill: { type: "gradient", gradientType: "linear", angle: 180, stops: [{ color: accent, position: 0 }, { color: darken(accent, 0.15), position: 100 }] },
  });
  slide.addShape("rect", { x: W * 0.06, y: H - 0.05, w: W * 0.94, h: 0.05, fill: { color: accent } });
  slide.addText(s.title, { x: W * 0.12, y: H * 0.33, w: W * 0.82, h: H * 0.22, fontFace: f.major, fontSize: 36, bold: true, color: c.dk1 });
  if (s.subtitle) slide.addText(s.subtitle, { x: W * 0.12, y: H * 0.55, w: W * 0.82, h: H * 0.12, fontFace: f.minor, fontSize: 16, color: c.dk2 });
}
```

- [ ] **Step 4: 实现 `layouts/content.ts`**（迁移 buildContent + 页脚 + accent 轮换）

```ts
import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter } from "./ctx.js";

export function buildContent(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H, index } = ctx;
  const accent = accentAt(c, index);
  slide.background = { color: c.lt2 };
  slide.addShape("rect", { x: 0, y: 0, w: W, h: 0.07, fill: { color: accent } });
  slide.addText(s.title, { x: W * 0.06, y: H * 0.07, w: W * 0.88, h: H * 0.13, fontFace: f.major, fontSize: 28, bold: true, color: c.dk1 });
  slide.addShape("rect", { x: W * 0.06, y: H * 0.2, w: W * 0.14, h: 0.04, fill: { color: accent } });
  if (s.bullets?.length) {
    slide.addText(
      s.bullets.map((b) => ({ text: b, options: { bullet: { color: accent }, breakLine: true, paraSpaceAfter: 8 } })),
      { x: W * 0.07, y: H * 0.27, w: W * 0.86, h: H * 0.6, fontFace: f.minor, fontSize: 16, color: c.dk2, valign: "top", lineSpacingMultiple: 1.35 }
    );
  }
  drawFooter(slide, ctx);
}
```

- [ ] **Step 5: 实现 `layouts/index.ts`**（分发表，缺失版式暂时指向 content，Task 4 补全）

```ts
import type { PptLayout, PptSlide } from "../renderer.js";
import type { BuildCtx, PptxSlide } from "./ctx.js";
import { buildCover } from "./cover.js";
import { buildSection } from "./section.js";
import { buildContent } from "./content.js";

type Builder = (slide: PptxSlide, s: PptSlide, ctx: BuildCtx) => void;

// Task 4 会替换 agenda/keypoints/stats/compare/timeline/quote/closing 为专用 builder
export const BUILDERS: Record<PptLayout, Builder> = {
  cover: buildCover,
  section: buildSection,
  content: buildContent,
  agenda: buildContent,
  keypoints: buildContent,
  stats: buildContent,
  compare: buildContent,
  timeline: buildContent,
  quote: buildSection,
  closing: buildSection,
};
```

- [ ] **Step 6: 改 `renderer.ts` 的 `renderPptx`**（替换第 36-71 行循环，并删除文件内旧 `darken`/`buildCover`/`buildSection`/`buildContent`）

```ts
import { createRequire } from "node:module";
import type { PptTheme } from "./theme-extractor.js";
import { BUILDERS } from "./layouts/index.js";
import type { BuildCtx } from "./layouts/ctx.js";

const require = createRequire(import.meta.url);
const PptxGenJS: typeof import("pptxgenjs").default = require("pptxgenjs");

// ...（保留 Task 1 的类型导出：PptLayout / PptItem / PptColumn / PptQuote / PptSlide / PptOutline）...

export async function renderPptx(outline: PptOutline, theme: PptTheme): Promise<Buffer> {
  if (!outline.slides.length) throw new Error("outline has no slides");
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "THEME", width: theme.slideWidthIn, height: theme.slideHeightIn });
  pptx.layout = "THEME";

  outline.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    if (s.notes) slide.addNotes(s.notes);
    const ctx: BuildCtx = {
      c: theme.colors, f: theme.fonts,
      W: theme.slideWidthIn, H: theme.slideHeightIn, theme,
      index: i, total: outline.slides.length, presTitle: outline.title,
    };
    (BUILDERS[s.layout] ?? BUILDERS.content)(slide, s, ctx);
  });

  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}
```
> 删掉 renderer.ts 内原有的 `darken`、`buildCover`、`buildSection`、`buildContent`（已迁到 layouts/）。

- [ ] **Step 7: 运行现有渲染测试确认全绿**

Run: `npm test -w @lot-agent/server -- renderer`
Expected: PASS（现有 3 测试不变——slide 数、标题/bullet 文本、空 outline 抛错）

- [ ] **Step 8: 类型检查 + 提交**

Run: `npm run build -w @lot-agent/server`
Expected: 构建通过

```bash
git add packages/server/src/ppt/renderer.ts packages/server/src/ppt/layouts/
git commit -m "refactor(ppt): 渲染器拆分为 layouts/ + BuildCtx/页脚/装饰 helper"
```

---

## Task 4: 7 个新版式 builder + 分发接线

**Files:**
- Create: `packages/server/src/ppt/layouts/agenda.ts` `keypoints.ts` `stats.ts` `compare.ts` `timeline.ts` `quote.ts` `closing.ts`
- Modify: `packages/server/src/ppt/layouts/index.ts`（接线）
- Test: `packages/server/src/ppt/layouts.test.ts`

**Interfaces:**
- Consumes: `BuildCtx`/helper（ctx.ts, Task 3）、`PptSlide`（Task 1）
- Produces: `buildAgenda/buildKeypoints/buildStats/buildCompare/buildTimeline/buildQuote/buildClosing`（均 `(slide, s, ctx) => void`）

- [ ] **Step 1: 写失败测试** — `layouts.test.ts`

```ts
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { renderPptx, type PptOutline } from "./renderer.js";
import { DEFAULT_THEME } from "./theme-extractor.js";

async function slideXml(outline: PptOutline, n: number): Promise<string> {
  const buf = await renderPptx(outline, DEFAULT_THEME);
  const zip = await JSZip.loadAsync(buf);
  return zip.file(`ppt/slides/slide${n}.xml`)!.async("string");
}

describe("new layouts render their content", () => {
  it("stats places every value and label", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "stats", title: "核心数据", items: [{ value: "65%", label: "增长" }, { value: "3x", label: "效率" }] },
    ]}, 1);
    expect(xml).toContain("65%");
    expect(xml).toContain("增长");
    expect(xml).toContain("3x");
  });
  it("compare places both column titles and bullets", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "compare", title: "新老对比", left: { title: "旧策略", bullets: ["投放广"] }, right: { title: "新策略", bullets: ["精准"] } },
    ]}, 1);
    expect(xml).toContain("旧策略");
    expect(xml).toContain("新策略");
    expect(xml).toContain("投放广");
    expect(xml).toContain("精准");
  });
  it("timeline places every node label", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "timeline", title: "节奏", items: [{ label: "调研", desc: "两周" }, { label: "开发" }, { label: "上线" }] },
    ]}, 1);
    for (const t of ["调研", "开发", "上线"]) expect(xml).toContain(t);
  });
  it("keypoints places labels and desc", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "keypoints", title: "亮点", items: [{ label: "快", desc: "毫秒级" }, { label: "省", desc: "低成本" }] },
    ]}, 1);
    expect(xml).toContain("毫秒级");
    expect(xml).toContain("低成本");
  });
  it("quote places text and author", async () => {
    const xml = await slideXml({ title: "", slides: [
      { layout: "quote", title: "", quote: { text: "增长来自复购", author: "CEO" } },
    ]}, 1);
    expect(xml).toContain("增长来自复购");
    expect(xml).toContain("CEO");
  });
  it("agenda auto-generates items from section titles when omitted", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "agenda", title: "目录" },
      { layout: "section", title: "第一章 背景" },
      { layout: "section", title: "第二章 方案" },
    ]}, 1);
    expect(xml).toContain("第一章 背景");
    expect(xml).toContain("第二章 方案");
  });
  it("closing places title and subtitle", async () => {
    const xml = await slideXml({ title: "T", slides: [
      { layout: "closing", title: "谢谢观看", subtitle: "欢迎交流" },
    ]}, 1);
    expect(xml).toContain("谢谢观看");
    expect(xml).toContain("欢迎交流");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @lot-agent/server -- layouts`
Expected: FAIL（stats/compare/... 目前走 content，value/双栏/节点断言不满足；agenda 自动生成不满足）

- [ ] **Step 3: 实现 `layouts/stats.ts`**

```ts
import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter } from "./ctx.js";

export function buildStats(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  slide.background = { color: c.lt2 };
  slide.addText(s.title, { x: W * 0.06, y: H * 0.1, w: W * 0.88, h: H * 0.12, fontFace: f.major, fontSize: 28, bold: true, color: c.dk1 });
  const items = s.items ?? [];
  const n = items.length;
  const gap = W * 0.04;
  const cardW = (W * 0.88 - gap * (n - 1)) / n;
  items.forEach((it, i) => {
    const accent = accentAt(c, i);
    const x = W * 0.06 + i * (cardW + gap);
    slide.addShape("roundRect", { x, y: H * 0.32, w: cardW, h: H * 0.42, rectRadius: 0.12, fill: { color: c.lt1 }, line: { color: accent, width: 1.5 } });
    slide.addText(it.value ?? "", { x, y: H * 0.36, w: cardW, h: H * 0.2, fontFace: f.major, fontSize: 44, bold: true, color: accent, align: "center" });
    slide.addText(it.label, { x, y: H * 0.58, w: cardW, h: H * 0.12, fontFace: f.minor, fontSize: 15, color: c.dk2, align: "center" });
    if (it.desc) slide.addText(it.desc, { x, y: H * 0.66, w: cardW, h: H * 0.08, fontFace: f.minor, fontSize: 11, color: c.dk2, align: "center" });
  });
  drawFooter(slide, ctx);
}
```

- [ ] **Step 4: 实现 `layouts/keypoints.ts`**

```ts
import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter } from "./ctx.js";

export function buildKeypoints(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  slide.background = { color: c.lt2 };
  slide.addText(s.title, { x: W * 0.06, y: H * 0.08, w: W * 0.88, h: H * 0.12, fontFace: f.major, fontSize: 28, bold: true, color: c.dk1 });
  const items = s.items ?? [];
  const cols = items.length <= 3 ? items.length : 2;
  const rows = Math.ceil(items.length / cols);
  const gapX = W * 0.04, gapY = H * 0.04;
  const cardW = (W * 0.88 - gapX * (cols - 1)) / cols;
  const cardH = (H * 0.58 - gapY * (rows - 1)) / rows;
  items.forEach((it, i) => {
    const accent = accentAt(c, i);
    const cx = i % cols, cy = Math.floor(i / cols);
    const x = W * 0.06 + cx * (cardW + gapX);
    const y = H * 0.26 + cy * (cardH + gapY);
    slide.addShape("roundRect", { x, y, w: cardW, h: cardH, rectRadius: 0.08, fill: { color: c.lt1 }, line: { color: c.lt2, width: 1 } });
    slide.addShape("rect", { x, y, w: 0.08, h: cardH, fill: { color: accent } });
    slide.addText(it.label, { x: x + 0.25, y: y + cardH * 0.12, w: cardW - 0.4, h: cardH * 0.35, fontFace: f.major, fontSize: 18, bold: true, color: c.dk1 });
    if (it.desc) slide.addText(it.desc, { x: x + 0.25, y: y + cardH * 0.5, w: cardW - 0.4, h: cardH * 0.42, fontFace: f.minor, fontSize: 13, color: c.dk2, valign: "top", lineSpacingMultiple: 1.3 });
  });
  drawFooter(slide, ctx);
}
```

- [ ] **Step 5: 实现 `layouts/compare.ts`**

```ts
import type { PptSlide, PptColumn } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter } from "./ctx.js";

export function buildCompare(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  slide.background = { color: c.lt2 };
  slide.addText(s.title, { x: W * 0.06, y: H * 0.08, w: W * 0.88, h: H * 0.12, fontFace: f.major, fontSize: 28, bold: true, color: c.dk1 });
  const colW = W * 0.42;
  const col = (column: PptColumn, x: number, accentIdx: number) => {
    const accent = accentAt(c, accentIdx);
    slide.addShape("roundRect", { x, y: H * 0.26, w: colW, h: H * 0.62, rectRadius: 0.08, fill: { color: c.lt1 }, line: { color: c.lt2, width: 1 } });
    slide.addShape("rect", { x, y: H * 0.26, w: colW, h: H * 0.1, fill: { color: accent } });
    slide.addText(column.title, { x: x + 0.2, y: H * 0.26, w: colW - 0.4, h: H * 0.1, fontFace: f.major, fontSize: 18, bold: true, color: "FFFFFF", valign: "middle" });
    slide.addText(
      column.bullets.map((b) => ({ text: b, options: { bullet: { color: accent }, breakLine: true, paraSpaceAfter: 8 } })),
      { x: x + 0.25, y: H * 0.4, w: colW - 0.5, h: H * 0.44, fontFace: f.minor, fontSize: 14, color: c.dk2, valign: "top", lineSpacingMultiple: 1.3 }
    );
  };
  col(s.left!, W * 0.06, 0);
  col(s.right!, W * 0.52, 3);
  drawFooter(slide, ctx);
}
```

- [ ] **Step 6: 实现 `layouts/timeline.ts`**

```ts
import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter } from "./ctx.js";

export function buildTimeline(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  slide.background = { color: c.lt2 };
  slide.addText(s.title, { x: W * 0.06, y: H * 0.08, w: W * 0.88, h: H * 0.12, fontFace: f.major, fontSize: 28, bold: true, color: c.dk1 });
  const items = s.items ?? [];
  const n = items.length;
  const y = H * 0.5;
  slide.addShape("line", { x: W * 0.08, y, w: W * 0.84, h: 0, line: { color: c.dk2, width: 1.5, transparency: 40 } });
  const step = (W * 0.84) / (n - 1 || 1);
  items.forEach((it, i) => {
    const accent = accentAt(c, i);
    const x = W * 0.08 + i * step;
    slide.addShape("ellipse", { x: x - 0.12, y: y - 0.12, w: 0.24, h: 0.24, fill: { color: accent }, line: { color: "FFFFFF", width: 2 } });
    const up = i % 2 === 0;
    slide.addText(`${i + 1}`, { x: x - 0.12, y: y - 0.12, w: 0.24, h: 0.24, fontFace: f.major, fontSize: 11, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
    slide.addText(it.label, { x: x - step * 0.45, y: up ? y - H * 0.22 : y + H * 0.06, w: step * 0.9, h: H * 0.1, fontFace: f.major, fontSize: 14, bold: true, color: c.dk1, align: "center" });
    if (it.desc) slide.addText(it.desc, { x: x - step * 0.45, y: up ? y - H * 0.12 : y + H * 0.16, w: step * 0.9, h: H * 0.1, fontFace: f.minor, fontSize: 11, color: c.dk2, align: "center" });
  });
  drawFooter(slide, ctx);
}
```

- [ ] **Step 7: 实现 `layouts/quote.ts`**

```ts
import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, darken } from "./ctx.js";

export function buildQuote(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H, index } = ctx;
  const accent = accentAt(c, index);
  slide.background = { color: c.dk1 };
  slide.addShape("rect", { x: 0, y: 0, w: W, h: H, fill: { type: "gradient", gradientType: "linear", angle: 135, stops: [{ color: c.dk1, position: 0 }, { color: darken(c.dk1, 0.25), position: 100 }] } });
  slide.addText("“", { x: W * 0.08, y: H * 0.14, w: W * 0.2, h: H * 0.3, fontFace: f.major, fontSize: 120, bold: true, color: accent });
  slide.addText(s.quote?.text ?? "", { x: W * 0.12, y: H * 0.34, w: W * 0.76, h: H * 0.34, fontFace: f.major, fontSize: 30, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
  if (s.quote?.author) slide.addText(`— ${s.quote.author}`, { x: W * 0.12, y: H * 0.72, w: W * 0.76, h: H * 0.1, fontFace: f.minor, fontSize: 16, color: c.lt2, align: "center" });
}
```

- [ ] **Step 8: 实现 `layouts/closing.ts`**

```ts
import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, darken } from "./ctx.js";

export function buildClosing(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  slide.background = { color: c.accent1 };
  slide.addShape("rect", { x: 0, y: 0, w: W, h: H, fill: { type: "gradient", gradientType: "linear", angle: 135, stops: [{ color: c.accent1, position: 0 }, { color: darken(c.accent1, 0.25), position: 100 }] } });
  slide.addShape("ellipse", { x: -W * 0.06, y: H * 0.68, w: H * 0.4, h: H * 0.4, fill: { color: "FFFFFF", transparency: 88 } });
  slide.addText(s.title, { x: W * 0.08, y: H * 0.38, w: W * 0.84, h: H * 0.2, fontFace: f.major, fontSize: 40, bold: true, color: c.lt1, align: "center" });
  if (s.subtitle) slide.addText(s.subtitle, { x: W * 0.08, y: H * 0.6, w: W * 0.84, h: H * 0.1, fontFace: f.minor, fontSize: 16, color: c.lt2, align: "center" });
}
```

- [ ] **Step 9: 实现 `layouts/agenda.ts`**（items 缺省时从后续 section 标题自动生成，需要 outline 上下文——通过 ctx 无法拿到其他页，改为在分发前预处理）

agenda 需要「后续 section 页的标题」。在 `renderPptx` 里，渲染前先算出各 section 标题，塞进一个渲染期临时字段。**实现方式**：`buildAgenda` 读 `ctx` 上新增的可选 `agendaItems?: string[]`。修改 `ctx.ts` 的 `BuildCtx` 增 `agendaItems?: string[]`，并在 `renderPptx` 组装 ctx 时计算。

`ctx.ts` — `BuildCtx` 接口末尾加：
```ts
  /** 供 agenda 版式：缺省 items 时用后续 section 标题填充。 */
  agendaItems?: string[];
```

`renderer.ts` — `renderPptx` 内，`forEach` 之前计算一次：
```ts
  const sectionTitles = outline.slides.filter((x) => x.layout === "section").map((x) => x.title);
```
并在组装 `ctx` 时加 `agendaItems: sectionTitles,`。

`layouts/agenda.ts`：
```ts
import type { PptSlide } from "../renderer.js";
import { type BuildCtx, type PptxSlide, accentAt, drawFooter } from "./ctx.js";

export function buildAgenda(slide: PptxSlide, s: PptSlide, ctx: BuildCtx): void {
  const { c, f, W, H } = ctx;
  slide.background = { color: c.lt2 };
  slide.addText(s.title, { x: W * 0.06, y: H * 0.1, w: W * 0.88, h: H * 0.14, fontFace: f.major, fontSize: 32, bold: true, color: c.dk1 });
  slide.addShape("rect", { x: W * 0.06, y: H * 0.24, w: W * 0.14, h: 0.05, fill: { color: accentAt(c, 0) } });
  const labels = (s.items?.map((it) => it.label) ?? ctx.agendaItems ?? []).slice(0, 10);
  labels.forEach((label, i) => {
    const accent = accentAt(c, i);
    const y = H * 0.34 + i * (H * 0.56 / Math.max(labels.length, 1));
    slide.addShape("ellipse", { x: W * 0.08, y, w: 0.4, h: 0.4, fill: { color: accent } });
    slide.addText(`${i + 1}`, { x: W * 0.08, y, w: 0.4, h: 0.4, fontFace: f.major, fontSize: 14, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
    slide.addText(label, { x: W * 0.16, y, w: W * 0.76, h: 0.4, fontFace: f.minor, fontSize: 18, color: c.dk1, valign: "middle" });
  });
  drawFooter(slide, ctx);
}
```

- [ ] **Step 10: 接线 `layouts/index.ts`**（替换 Task 3 的临时映射）

```ts
import type { PptLayout, PptSlide } from "../renderer.js";
import type { BuildCtx, PptxSlide } from "./ctx.js";
import { buildCover } from "./cover.js";
import { buildSection } from "./section.js";
import { buildContent } from "./content.js";
import { buildAgenda } from "./agenda.js";
import { buildKeypoints } from "./keypoints.js";
import { buildStats } from "./stats.js";
import { buildCompare } from "./compare.js";
import { buildTimeline } from "./timeline.js";
import { buildQuote } from "./quote.js";
import { buildClosing } from "./closing.js";

type Builder = (slide: PptxSlide, s: PptSlide, ctx: BuildCtx) => void;

export const BUILDERS: Record<PptLayout, Builder> = {
  cover: buildCover,
  agenda: buildAgenda,
  section: buildSection,
  content: buildContent,
  keypoints: buildKeypoints,
  stats: buildStats,
  compare: buildCompare,
  timeline: buildTimeline,
  quote: buildQuote,
  closing: buildClosing,
};
```

- [ ] **Step 11: 运行测试确认通过**

Run: `npm test -w @lot-agent/server -- layouts renderer`
Expected: PASS（新 layouts.test.ts 7 测试 + renderer.test.ts 3 测试）

- [ ] **Step 12: 构建 + 提交**

Run: `npm run build -w @lot-agent/server`
```bash
git add packages/server/src/ppt/layouts/ packages/server/src/ppt/renderer.ts packages/server/src/ppt/layouts.test.ts
git commit -m "feat(ppt): 新增 agenda/keypoints/stats/compare/timeline/quote/closing 七种版式"
```

---

## Task 5: generate_ppt 接入 v2 schema + themePreset + validateSlides

**Files:**
- Modify: `packages/server/src/tools/ppt-tool.ts`
- Test: `packages/server/src/tools/ppt-tool.test.ts`（新建；若已有则追加）

**Interfaces:**
- Consumes: `validateSlides`（Task 1）、`getPreset`（Task 2）、`renderPptx`/`PptSlide`（Task 1/4）
- Produces: `generate_ppt` 工具接受完整 v2 `slides` + 可选 `themePreset`；校验走 `validateSlides`

- [ ] **Step 1: 写失败测试** — `ppt-tool.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { createPptTool } from "./ppt-tool.js";

// 极简内存桩：storage.put 返回固定 url，db.createAsset 记录一次
function makeDeps() {
  const puts: any[] = [];
  const storage = { put: async (o: any) => { puts.push(o); return { url: `/static/documents/${o.key}` }; }, get: async () => Buffer.from(""), delete: async () => {} } as any;
  const uploadStorage = { get: async () => { throw new Error("no template"); }, put: async () => ({ url: "" }), delete: async () => {} } as any;
  const db = { getAsset: async () => null, createAsset: async () => {} } as any;
  return { storage, uploadStorage, db, puts };
}

describe("generate_ppt", () => {
  it("rejects invalid stats slide via validateSlides", async () => {
    const { storage, uploadStorage, db } = makeDeps();
    const tool = createPptTool({ storage, uploadStorage, db });
    const r = await tool.execute({ title: "T", slides: [{ layout: "stats", title: "t", items: [{ label: "only" }] }] }, { userId: "u" } as any);
    expect(r.isError).toBe(true);
    expect(r.errorKind).toBe("validation");
  });

  it("renders a mixed deck with a theme preset", async () => {
    const { storage, uploadStorage, db, puts } = makeDeps();
    const tool = createPptTool({ storage, uploadStorage, db });
    const r = await tool.execute({
      title: "季度复盘", themePreset: "tech-dark",
      slides: [
        { layout: "cover", title: "季度复盘" },
        { layout: "stats", title: "数据", items: [{ value: "65%", label: "增长" }, { value: "3x", label: "效率" }] },
        { layout: "closing", title: "谢谢" },
      ],
    }, { userId: "u" } as any);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("/static/documents/");
    expect(puts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @lot-agent/server -- ppt-tool`
Expected: FAIL（当前 schema/校验不认新版式，themePreset 未支持）

- [ ] **Step 3: 改 `ppt-tool.ts`**

改动点：
1. 顶部 import 增 `import { validateSlides } from "../ppt/validation.js";` 和 `import { getPreset } from "../ppt/themes.js";`；`import { renderPptx, type PptSlide } from "../ppt/renderer.js";`（PptSlide 现来自 renderer v2）。
2. 删除本文件内旧的 `LAYOUTS`/`MAX_SLIDES` 常量与手写 for 循环校验（第 17-18、73-87 行），改用 `validateSlides`。
3. `parameters.properties.slides.items` 替换为完整 v2 字段；新增 `themePreset`。
4. `execute` 里：先 `validateSlides`，再解析 preset 作为无模版时的基准主题。

`parameters` 段替换为：
```ts
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "演示文稿标题（用于文件名、页脚与提示）" },
        templateAssetId: { type: "string", description: "用户上传模版的 assetId，仅在消息里出现过模版标记时传入。" },
        themePreset: {
          type: "string",
          enum: ["business", "tech-dark", "warm", "mono", "academic"],
          description: "内置主题预设（无模版时用）：商务蓝/科技深色/暖橙创意/极简黑白/学术绿。",
        },
        slides: {
          type: "array",
          description: "每页一个条目，按顺序渲染。按 layout 选择字段。",
          items: {
            type: "object",
            properties: {
              layout: { type: "string", enum: ["cover", "agenda", "section", "content", "keypoints", "stats", "compare", "timeline", "quote", "closing"] },
              title: { type: "string" },
              subtitle: { type: "string", description: "cover/section/closing 的副标题" },
              bullets: { type: "array", items: { type: "string" }, description: "content 用，1-8 条" },
              items: {
                type: "array",
                description: "agenda/keypoints/stats/timeline 用",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    value: { type: "string", description: "stats 的大字数值" },
                    desc: { type: "string", description: "一句话补充" },
                  },
                  required: ["label"],
                },
              },
              left: { type: "object", description: "compare 左栏", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["title", "bullets"] },
              right: { type: "object", description: "compare 右栏", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["title", "bullets"] },
              quote: { type: "object", description: "quote 用", properties: { text: { type: "string" }, author: { type: "string" } }, required: ["text"] },
              notes: { type: "string", description: "演讲者备注" },
            },
            required: ["layout", "title"],
          },
        },
      },
      required: ["title", "slides"],
    },
```

`execute` 顶部（解构 input 后）替换原校验为：
```ts
      const { title = "", templateAssetId, themePreset, slides } =
        (input as { title?: string; templateAssetId?: string; themePreset?: string; slides?: PptSlide[] }) ?? {};

      const validationError = validateSlides(slides);
      if (validationError) {
        return { content: `generate_ppt 校验失败：${validationError}`, isError: true, errorKind: "validation" };
      }
```

主题基准：把原 `let theme: PptTheme = DEFAULT_THEME;`（第 98 行）改为：
```ts
      let theme: PptTheme = getPreset(themePreset) ?? DEFAULT_THEME;
```
> 其余模版解析/降级逻辑（第 100-148 行）保持不变——模版存在时仍优先走克隆/提取；无模版则用上面的 preset 基准。`slides!` 传入 `renderPptx({ title, slides: slides! }, theme)`。

- [ ] **Step 4: 运行确认通过**

Run: `npm test -w @lot-agent/server -- ppt-tool`
Expected: PASS

- [ ] **Step 5: 构建 + 提交**

Run: `npm run build -w @lot-agent/server`
```bash
git add packages/server/src/tools/ppt-tool.ts packages/server/src/tools/ppt-tool.test.ts
git commit -m "feat(ppt): generate_ppt 接入 v2 版式 schema、themePreset 与 validateSlides"
```

---

## Task 6: skill agents 字段 + ppt-authoring skill + 精简 ppt.ts

**Files:**
- Modify: `packages/core/src/skills/loader.ts`（`Skill` 增 `agents`；`match` 支持 agentId）
- Modify: `packages/server/src/services/agent-service.ts`（注入按 agentId）
- Modify: `packages/core/src/agents/definitions/ppt.ts`（精简 systemPrompt + 工具加 propose_outline）
- Create: `skills/ppt-authoring.md`
- Test: `packages/core/src/skills/loader.test.ts`（新建/追加）

**Interfaces:**
- Produces:
  ```ts
  export interface Skill { name; description; triggers: string[]; content; agents?: string[]; }
  // match 新签名（向后兼容：不传 opts 时等价旧行为）
  match(message: string, opts?: { agentId?: string; skills?: Skill[] }): Skill[]
  ```

- [ ] **Step 1: 写失败测试** — `loader.test.ts`

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @lot-agent/core -- loader`
Expected: FAIL（`match` 不接受 opts / agents 未解析）

- [ ] **Step 3: 改 `loader.ts`**

`Skill` 接口与 `SkillFrontmatter` 增 `agents`：
```ts
export interface Skill { name: string; description: string; triggers: string[]; content: string; agents?: string[]; }
interface SkillFrontmatter { name: string; description: string; triggers: string[]; agents: string[]; }
```
`parseFrontmatter` 初始化 `frontmatter` 增 `agents: []`；把 `triggers` 的多值解析逻辑推广到 `agents`——在 `if (key === "triggers")` 分支旁加同构的 `agents` 分支：
```ts
      if (key === "triggers" || key === "agents") {
        (frontmatter as any)[key] = [];
        if (trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) {
          (frontmatter as any)[key] = trimmedValue.slice(1, -1).split(",").map((s) => unquote(s)).filter(Boolean);
        } else if (trimmedValue) {
          (frontmatter as any)[key] = [unquote(trimmedValue)];
        }
      } else {
```
list-item 分支同理支持 `agents`：
```ts
    if (listMatch && (currentKey === "triggers" || currentKey === "agents")) {
      (frontmatter as any)[currentKey].push(unquote(listMatch[1]));
    }
```
`loadFile` 返回体加 `agents: frontmatter.agents`。

`match` 替换为新签名：
```ts
  match(message: string, opts?: { agentId?: string; skills?: Skill[] }): Skill[] {
    const target = opts?.skills ?? this.skills;
    const lower = message.toLowerCase();
    const out: Skill[] = [];
    for (const s of target) {
      if (s.agents && s.agents.length > 0) {
        // agent 作用域 skill：只对声明的 agent 注入，且无条件（不看 trigger）
        if (opts?.agentId && s.agents.includes(opts.agentId)) out.push(s);
      } else if (s.triggers.some((t) => lower.includes(t.toLowerCase()))) {
        out.push(s);
      }
    }
    return out;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -w @lot-agent/core -- loader`
Expected: PASS（4 测试）

- [ ] **Step 5: 更新调用点 `agent-service.ts`**（第 465 行）

```ts
    const matchedSkills = this.skillLoader.match(userMessage, { agentId: def.id });
```

- [ ] **Step 6: 创建 `skills/ppt-authoring.md`**

```markdown
---
name: ppt-authoring
description: PPT 制作 Agent 的叙事结构与版式选择工艺
agents:
  - ppt
---

你在制作可下载的 .pptx 演示文稿。素材盘点、提问、出大纲、生成、修改的流程如下。

## 输入盘点
用户消息里可能含：
- `[PPT模版已上传: 文件名 (templateAssetId: xxx)]` —— 记下 templateAssetId，生成时原样传给 generate_ppt；
- `[PPT背景图已上传: 文件名 (backgroundAssetId: xxx)]` —— 记下 backgroundAssetId，作为 generate_ppt 的 backgrounds 素材；
- `[附件: …]` 包裹的正文 —— 撰写素材；
- 用户的文字描述。

## 补齐信息
缺少「主题 / 受众 / 篇幅」等影响成稿的关键信息时用 ask_user 提问（一次一个）。
**没有模版也没有背景图时**，用 ask_user 让用户选内置主题，options 固定为：
["商务蓝", "科技深色", "暖橙创意", "极简黑白", "学术绿"]，
对应 generate_ppt 的 themePreset：business / tech-dark / warm / mono / academic。
能合理推断的不要问（篇幅默认 8-12 页）。

## 叙事骨架
cover → agenda（目录）→ 2-4 个章节（每章 section 分隔 + 2-3 页正文）→ closing（结尾/致谢）。

## 版式选择（硬规则，避免通篇 bullet）
- 连续 content 页不超过 2 页；
- 有数字/百分比/指标 → **stats**（每个 item 的 value 必须来自用户素材，禁止编造）；
- 方案/新旧/竞品对比 → **compare**；
- 阶段/步骤/里程碑/时间 → **timeline**；
- 金句/定位语/愿景 → **quote**；
- 并列的要点、优势、模块（成组）→ **keypoints**；
- 只有线性要点时才用 **content**。

## 文案规范
- bullets 每条 ≤ 20 字，观点先行；
- keypoints/timeline 的 desc 一句话；
- stats 的 value 简短（如 65%、3x、2.1w）。

## 流程
1. 盘点输入；2. ask_user 补关键信息（无风格来源时选主题）；
3. 调 **propose_outline** 出结构化大纲，等用户确认或修改；
4. 用户认可后调 **generate_ppt**（把 templateAssetId / backgrounds / themePreset 按盘点结果传入），把下载链接交给用户；
5. 修改时只改对应页，重新 propose_outline 再 generate_ppt。

不要编造 templateAssetId / backgroundAssetId；没有对应标记就不传该参数。不要向用户展示 assetId 等内部细节。
```

- [ ] **Step 7: 精简 `ppt.ts`**

```ts
import type { AgentDefinition } from "../types.js";

export const pptDefinition: AgentDefinition = {
  id: "ppt",
  name: "PPT 制作",
  type: "ppt",
  description: "上传模版或背景图与素材，对话式生成可下载的演示文稿（.pptx）",
  category: "办公",
  systemPrompt: `你是 PPT 制作助手，把用户的主题和素材做成一份可下载的 .pptx 演示文稿。
制作工艺（叙事结构、版式选择、文案规范、流程）见随附的 ppt-authoring 说明，严格遵循。
红线：不编造 templateAssetId / backgroundAssetId；缺对应上传标记就不传该参数；不向用户暴露 assetId 等内部细节；每次产出前先用 propose_outline 让用户确认大纲。`,
  toolNames: ["ask_user", "propose_outline", "generate_ppt"],
  defaultModelId: "deepseek-v4-flash",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string" },
      slides: { type: "number" },
    },
    required: ["topic"],
  },
};
```
> `propose_outline` 工具在 Task 11 才注册；本步先把它列入白名单不影响运行（ToolRegistry 只暴露已注册的工具，未注册的名字被忽略）。若担心，可将 Task 11 提前到本任务后执行。

- [ ] **Step 8: 运行 core 测试 + 构建**

Run: `npm test -w @lot-agent/core && npm run build -w @lot-agent/core`
Expected: PASS（含既有 `definitions.test.ts`；若该测试断言 ppt.toolNames，请同步更新其期望值为 `["ask_user", "propose_outline", "generate_ppt"]`）

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/skills/loader.ts packages/core/src/skills/loader.test.ts packages/core/src/agents/definitions/ppt.ts packages/server/src/services/agent-service.ts skills/ppt-authoring.md
git commit -m "feat(skill): skill 支持 agents 作用域 + ppt-authoring 工艺 skill，精简 ppt 定义"
```

---

# 阶段 P2：模版背景图解析 + 背景图上传 + 降级链

## Task 7: 渲染器背景图支持（SlideBackground + overlay）

**Files:**
- Modify: `packages/server/src/ppt/theme-extractor.ts`（`PptTheme` 增 `backgrounds`）
- Modify: `packages/server/src/ppt/layouts/ctx.ts`（`applyBackground` helper + ink 计算）
- Modify: `packages/server/src/ppt/layouts/{cover,section,content,stats,keypoints,compare,timeline,agenda}.ts`（首行调用 applyBackground；文字色改用 ctx.ink*）
- Test: `packages/server/src/ppt/background.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type OverlayMode = "dark" | "light" | "none";
  export interface SlideBackground { image: Buffer; ext: "png" | "jpeg"; overlay: OverlayMode }
  // PptTheme 新增：backgrounds?: { cover?: SlideBackground; section?: SlideBackground; body?: SlideBackground }
  // ctx.ts
  export function bgRoleFor(layout: PptLayout): "cover" | "section" | "body";
  export function applyBackground(slide: PptxSlide, ctx: BuildCtx): boolean; // 应用则返回 true
  export function inkColors(ctx: BuildCtx): { title: string; body: string; onBg: boolean };
  ```

- [ ] **Step 1: 给 `PptTheme` 加 backgrounds（theme-extractor.ts）**

在 `PptTheme` 接口加：
```ts
  backgrounds?: {
    cover?: SlideBackground;
    section?: SlideBackground;
    body?: SlideBackground;
  };
```
并在文件顶部导出类型：
```ts
export type OverlayMode = "dark" | "light" | "none";
export interface SlideBackground { image: Buffer; ext: "png" | "jpeg"; overlay: OverlayMode }
```
> `DEFAULT_THEME` 与 presets 不带 backgrounds（可选字段，无需改）。

- [ ] **Step 2: 写失败测试** — `background.test.ts`

```ts
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { renderPptx, type PptOutline } from "./renderer.js";
import { DEFAULT_THEME, type PptTheme } from "./theme-extractor.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("renderPptx background", () => {
  it("embeds a cover background image into the pptx media", async () => {
    const theme: PptTheme = { ...DEFAULT_THEME, backgrounds: { cover: { image: PNG, ext: "png", overlay: "dark" } } };
    const outline: PptOutline = { title: "T", slides: [{ layout: "cover", title: "封面" }] };
    const buf = await renderPptx(outline, theme);
    const zip = await JSZip.loadAsync(buf);
    const media = Object.keys(zip.files).filter((p) => /^ppt\/media\/.*\.(png|jpe?g)$/i.test(p));
    expect(media.length).toBeGreaterThan(0);
    const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(slide1).toContain("封面");
  });
  it("renders fine when no backgrounds set (regression)", async () => {
    const buf = await renderPptx({ title: "T", slides: [{ layout: "content", title: "t", bullets: ["a"] }] }, DEFAULT_THEME);
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file("ppt/slides/slide1.xml")).toBeTruthy();
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm test -w @lot-agent/server -- background`
Expected: FAIL（背景图未嵌入 media）

- [ ] **Step 4: 给 `BuildCtx` 加 `layout` 字段 + renderer 传入**

`ctx.ts` 的 `BuildCtx` 接口顶部 import 增 `import type { PptLayout } from "../renderer.js";`，接口内加：
```ts
  layout: PptLayout;
```
`renderer.ts` 组装 ctx 的对象里加一行 `layout: s.layout,`（helper 用它决定背景 role 与文字色）。

- [ ] **Step 5: 在 `ctx.ts` 加背景 helper**

```ts
export function bgRoleFor(layout: PptLayout): "cover" | "section" | "body" {
  if (layout === "cover" || layout === "closing") return "cover";
  if (layout === "section") return "section";
  return "body";
}

/** 若主题为该版式配了背景图：贴整页图 + 遮罩，返回 true（否则不动 slide.background）。 */
export function applyBackground(slide: PptxSlide, ctx: BuildCtx): boolean {
  const bg = ctx.theme.backgrounds?.[bgRoleFor(ctx.layout)];
  if (!bg) return false;
  const b64 = bg.image.toString("base64");
  const mime = bg.ext === "jpeg" ? "image/jpeg" : "image/png";
  slide.background = { data: `data:${mime};base64,${b64}` };
  if (bg.overlay !== "none") {
    const dark = bg.overlay === "dark";
    slide.addShape("rect", { x: 0, y: 0, w: ctx.W, h: ctx.H, fill: { color: dark ? "000000" : "FFFFFF", transparency: dark ? 45 : 25 }, line: { type: "none" } });
  }
  return true;
}

/** 文字色：贴了深遮罩（或无 overlay 的背景）→ 白字；浅遮罩/无背景 → 主题深色。 */
export function inkColors(ctx: BuildCtx): { title: string; body: string; onBg: boolean } {
  const bg = ctx.theme.backgrounds?.[bgRoleFor(ctx.layout)];
  if (bg && bg.overlay !== "light") return { title: "FFFFFF", body: "F0F0F5", onBg: true };
  return { title: ctx.c.dk1, body: ctx.c.dk2, onBg: !!bg };
}
```

- [ ] **Step 6: builder 首行接入背景**

对 `content/stats/keypoints/compare/timeline/agenda` 六个「内容类」builder：把 `slide.background = { color: c.lt2 };` 替换为：
```ts
  const hasBg = applyBackground(slide, ctx);
  if (!hasBg) slide.background = { color: c.lt2 };
  const ink = inkColors(ctx);
```
并把标题色 `color: c.dk1` → `color: ink.title`、正文/bullet 色 `color: c.dk2` → `color: ink.body`。
对 `cover`：在函数首行加 `if (applyBackground(slide, ctx)) { /* 背景图已贴，跳过渐变色块 */ } else { ...原渐变逻辑... }`；标题保持白字（cover 本就白字，遮罩默认 dark 一致）。
对 `section`：同 content 模式接入（背景图时用 ink.title）。
> 各 builder 顶部 import 增 `applyBackground, inkColors`。closing/quote 维持自绘深色背景，不接背景图（overlay 语义冲突），保持原样。

- [ ] **Step 7: 运行测试确认通过（含回归）**

Run: `npm test -w @lot-agent/server -- background layouts renderer`
Expected: PASS

- [ ] **Step 8: 构建 + 提交**

Run: `npm run build -w @lot-agent/server`
```bash
git add packages/server/src/ppt/theme-extractor.ts packages/server/src/ppt/layouts/ packages/server/src/ppt/renderer.ts packages/server/src/ppt/background.test.ts
git commit -m "feat(ppt): 渲染器支持整页背景图 + 可读性遮罩 + 反色文字"
```

---

## Task 8: theme-extractor 从模版提取背景图

**Files:**
- Modify: `packages/server/src/ppt/theme-extractor.ts`（新增 `extractBackgrounds`）
- Test: `packages/server/src/ppt/theme-extractor.test.ts`（追加）；复用 `template-renderer.fixture.ts`（母版已带 `image1.png` 背景）

**Interfaces:**
- Consumes: `SlideBackground`（Task 7）
- Produces:
  ```ts
  export async function extractBackgrounds(bytes: Buffer): Promise<PptTheme["backgrounds"] | null>;
  ```

- [ ] **Step 1: 写失败测试**（追加到 `theme-extractor.test.ts`）

```ts
import { extractBackgrounds } from "./theme-extractor.js";
import { buildTemplatePptx } from "./template-renderer.fixture.js";

describe("extractBackgrounds", () => {
  it("pulls the master background image as body role", async () => {
    const bytes = await buildTemplatePptx();
    const bg = await extractBackgrounds(bytes);
    expect(bg).not.toBeNull();
    expect(bg!.body?.ext).toBe("png");
    expect(bg!.body?.image.length).toBeGreaterThan(0);
  });
  it("returns null on a bad zip", async () => {
    expect(await extractBackgrounds(Buffer.from("not a zip"))).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @lot-agent/server -- theme-extractor`
Expected: FAIL（`extractBackgrounds` 未定义）

- [ ] **Step 3: 实现 `extractBackgrounds`**（加到 theme-extractor.ts 末尾）

```ts
function extOf(path: string): "png" | "jpeg" | null {
  if (/\.png$/i.test(path)) return "png";
  if (/\.jpe?g$/i.test(path)) return "jpeg";
  return null;
}

/** 顺着一个部件的 _rels 找 <p:bg> 里 blip r:embed 指向的 media 图片字节。 */
async function bgImageFrom(zip: JSZip, partPath: string): Promise<SlideBackground | null> {
  const xml = await zip.file(partPath)?.async("string");
  if (!xml) return null;
  const bg = /<p:bg\b[\s\S]*?<\/p:bg>/i.exec(xml)?.[0];
  if (!bg) return null;
  const rid = /<a:blip[^>]*r:embed="([^"]+)"/i.exec(bg)?.[1];
  if (!rid) return null;
  const dir = partPath.slice(0, partPath.lastIndexOf("/"));
  const relsPath = `${dir}/_rels/${partPath.slice(partPath.lastIndexOf("/") + 1)}.rels`;
  const rels = await zip.file(relsPath)?.async("string");
  if (!rels) return null;
  const target = new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`, "i").exec(rels)?.[1];
  if (!target) return null;
  const resolved = target.replace(/^\.\.\//, "ppt/").replace(/^\//, "");
  const mediaPath = resolved.startsWith("ppt/") ? resolved : `ppt/${resolved}`;
  const ext = extOf(mediaPath);
  if (!ext) return null;
  const img = await zip.file(mediaPath)?.async("nodebuffer");
  if (!img) return null;
  return { image: img, ext, overlay: "dark" };
}

/**
 * 从模版提背景图：母版/正文版式背景 → body，封面版式背景 → cover，章节版式 → section。
 * 任何失败（坏 zip 等）返回 null；提不到任何背景也返回 null。
 */
export async function extractBackgrounds(bytes: Buffer): Promise<PptTheme["backgrounds"] | null> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const out: NonNullable<PptTheme["backgrounds"]> = {};
    const masters = Object.keys(zip.files).filter((p) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(p));
    for (const m of masters) {
      const bg = await bgImageFrom(zip, m);
      if (bg) { out.body = bg; break; }
    }
    const layouts = Object.keys(zip.files).filter((p) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(p));
    for (const l of layouts) {
      const xml = await zip.file(l)!.async("string");
      const kind = /<p:sldLayout\b[^>]*\btype="([^"]+)"/i.exec(xml)?.[1]?.toLowerCase();
      if (kind === "title" && !out.cover) { const bg = await bgImageFrom(zip, l); if (bg) out.cover = bg; }
      if ((kind === "sechead" || kind === "sectionhead") && !out.section) { const bg = await bgImageFrom(zip, l); if (bg) out.section = bg; }
    }
    return out.body || out.cover || out.section ? out : null;
  } catch {
    return null;
  }
}
```
> 需在文件顶部确保 `import type { SlideBackground } from ...`——`SlideBackground` 就在本文件定义（Task 7），直接用即可。

- [ ] **Step 4: 运行确认通过**

Run: `npm test -w @lot-agent/server -- theme-extractor`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/ppt/theme-extractor.ts packages/server/src/ppt/theme-extractor.test.ts
git commit -m "feat(ppt): theme-extractor 从模版母版/版式提取背景图"
```

---

## Task 9: 背景图上传槽（web → client → extractor → route）

**Files:**
- Modify: `packages/web/src/api/client.ts`（`AttachmentSlot`）
- Modify: `packages/web/src/components/InputBox.tsx`（背景图按钮 + chip + slot 组装）
- Modify: `packages/web/src/App.css`（`badge-background` 样式，用 token）
- Modify: `packages/server/src/services/attachment-extractor.ts`（`ppt_background` slot + 引用标记）
- Modify: `packages/server/src/routes/conversations.ts`（slot 白名单）
- Test: `packages/server/src/services/attachment-extractor.test.ts`（追加/新建）

**Interfaces:**
- Produces: 上传的背景图在发给模型的正文里表现为 `[PPT背景图已上传: 文件名 (backgroundAssetId: xxx)]`；`AttachmentRef.slot` 增 `"ppt_background"`

- [ ] **Step 1: 写失败测试**（`attachment-extractor.test.ts`）

```ts
import { describe, it, expect } from "vitest";
import { extractAttachment, type AttachmentRef } from "./attachment-extractor.js";

const storage = { get: async () => Buffer.from(""), put: async () => ({ url: "" }), delete: async () => {} } as any;

describe("ppt_background slot", () => {
  it("emits a reference marker, not file content", async () => {
    const att: AttachmentRef = { assetId: "bg1", filename: "bg.png", mime: "image/png", size: 1, url: "/static/uploads/bg1.png", kind: "image", slot: "ppt_background" };
    const part = await extractAttachment(att, storage);
    expect(part.type).toBe("text");
    expect((part as any).text).toContain("PPT背景图已上传");
    expect((part as any).text).toContain("backgroundAssetId: bg1");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @lot-agent/server -- attachment-extractor`
Expected: FAIL（ppt_background 未特判，会当图片读字节）

- [ ] **Step 3: attachment-extractor 增 slot**

`AttachmentRef.slot` 联合类型加 `"ppt_background"`；在 `ppt_template` 特判块（第 79-84 行）后追加：
```ts
  if (att.slot === "ppt_background") {
    return {
      type: "text",
      text: `[PPT背景图已上传: ${att.filename} (backgroundAssetId: ${att.assetId})]`,
    };
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -w @lot-agent/server -- attachment-extractor`
Expected: PASS

- [ ] **Step 5: route slot 白名单**（conversations.ts:167）

替换为完整白名单（顺带修正 contract 两 slot 之前被丢弃的问题）：
```ts
const VALID_SLOTS = new Set(["ppt_template", "ppt_background", "content", "contract_old", "contract_new"]);
// ...
        slot: a.slot && VALID_SLOTS.has(a.slot) ? a.slot : undefined,
```
> `VALID_SLOTS` 定义在文件顶部（模块级）。

- [ ] **Step 6: client 类型**（client.ts:93）

```ts
export type AttachmentSlot = "ppt_template" | "ppt_background" | "content" | "contract_old" | "contract_new";
```

- [ ] **Step 7: InputBox 背景图按钮 + chip + 组装**

state（第 59-64 行附近）加：
```ts
  const [backgroundFiles, setBackgroundFiles] = useState<File[]>([]);
  const backgroundInputRef = useRef<HTMLInputElement>(null);
```
`handleSend` 的 pptMode 分支（第 119-123 行）改为：
```ts
    const picked: PickedFile[] = pptMode
      ? [
          ...(templateFile ? [{ file: templateFile, slot: "ppt_template" as const }] : []),
          ...backgroundFiles.map((f) => ({ file: f, slot: "ppt_background" as const })),
          ...files.map((f) => ({ file: f, slot: "content" as const })),
        ]
      : /* 其余不变 */
```
send 后清空：`setBackgroundFiles([]);`（加入 handleSend 末尾与依赖数组）。
在「PPT 模版」按钮后加背景图按钮（第 299 行 `PPT 模版` 按钮块之后）：
```tsx
              <button
                type="button"
                className="btn-reference"
                onClick={() => backgroundInputRef.current?.click()}
                disabled={disabled || backgroundFiles.length >= 3}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="m21 15-5-5L5 21" />
                </svg>
                背景图
              </button>
```
隐藏 input（放在 templateInputRef input 附近，第 238 行附近）：
```tsx
        <input
          ref={backgroundInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            setBackgroundFiles((prev) => [...prev, ...picked].slice(0, 3));
            e.target.value = "";
          }}
        />
```
chip 区（第 166-190 行的附件预览块）在 template chip 之后加背景图 chip：
```tsx
          {backgroundFiles.map((f, i) => (
            <div className="attachment-chip" key={`__bg${i}`}>
              <span className="attachment-slot-badge badge-background">背景</span>
              <span className="attachment-name" title={f.name}>{f.name}</span>
              <button type="button" className="attachment-remove" onClick={() => setBackgroundFiles((p) => p.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
```
把 `backgroundFiles` 加入顶部「有附件」判断（第 117、166、399 行的 `hasFiles`/条件）与 `handleSend` 依赖数组。

- [ ] **Step 8: App.css 加 badge-background**（仿现有 `.badge-template`）

```css
.attachment-slot-badge.badge-background {
  background: var(--overlay-raise);
  color: var(--accent);
}
```
> 用现有 token；若 `.badge-template` 用的是别的 token，对齐它的写法保持一致观感。

- [ ] **Step 9: 构建校验 + 提交**

Run: `npm run build -w @lot-agent/web && npm run build -w @lot-agent/server`
Expected: 两个构建均通过

```bash
git add packages/web/src/api/client.ts packages/web/src/components/InputBox.tsx packages/web/src/App.css packages/server/src/services/attachment-extractor.ts packages/server/src/services/attachment-extractor.test.ts packages/server/src/routes/conversations.ts
git commit -m "feat(ppt): PPT 模式新增背景图上传槽（web+extractor+route）"
```

---

## Task 10: generate_ppt backgrounds 参数 + 主题降级链重排

**Files:**
- Modify: `packages/server/src/tools/ppt-tool.ts`
- Test: `packages/server/src/tools/ppt-tool.test.ts`（追加）

**Interfaces:**
- Consumes: `extractBackgrounds`（Task 8）、`getPreset`（Task 2）、`renderPptx`（Task 4）、`SlideBackground`/`OverlayMode`（Task 7）
- Produces: `generate_ppt` 新参数
  `backgrounds?: { assetId: string; role?: "cover"|"body"|"section"; overlay?: "dark"|"light"|"none" }[]`

降级优先级（自上而下命中即止）：
```
上传背景图 → ThemePack 渲染（可叠加模版色彩/preset 作为配色基准）
模版背景图提取成功 → ThemePack 渲染（全版式）
提取不到背景 && templateHasReusableDesign → 克隆路径（新版式在 slideXml 前降级映射）
色彩/字体提取（extractTheme）
themePreset / DEFAULT_THEME
```

- [ ] **Step 1: 写失败测试**（追加到 ppt-tool.test.ts）

```ts
it("applies an uploaded background image", async () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const storage = { put: async (o: any) => ({ url: `/static/documents/${o.key}` }), get: async () => Buffer.from(""), delete: async () => {} } as any;
  const uploadStorage = { get: async () => PNG, put: async () => ({ url: "" }), delete: async () => {} } as any;
  const db = { getAsset: async (id: string) => ({ id, user_id: "u", storage_key: `${id}.png`, mime: "image/png" }), createAsset: async () => {} } as any;
  const tool = createPptTool({ storage, uploadStorage, db });
  const r = await tool.execute({
    title: "T",
    backgrounds: [{ assetId: "bg1", role: "cover", overlay: "dark" }],
    slides: [{ layout: "cover", title: "封面" }],
  }, { userId: "u" } as any);
  expect(r.isError).toBeFalsy();
  expect(r.content).toContain("背景图");
});

it("notes ignored background when asset missing", async () => {
  const storage = { put: async (o: any) => ({ url: `/static/documents/${o.key}` }), get: async () => Buffer.from(""), delete: async () => {} } as any;
  const uploadStorage = { get: async () => { throw new Error("x"); }, put: async () => ({ url: "" }), delete: async () => {} } as any;
  const db = { getAsset: async () => null, createAsset: async () => {} } as any;
  const tool = createPptTool({ storage, uploadStorage, db });
  const r = await tool.execute({
    title: "T", backgrounds: [{ assetId: "missing", role: "cover" }],
    slides: [{ layout: "cover", title: "封面" }],
  }, { userId: "u" } as any);
  expect(r.isError).toBeFalsy(); // 忽略该背景，仍成功
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @lot-agent/server -- ppt-tool`
Expected: FAIL（backgrounds 参数未处理）

- [ ] **Step 3: 改 `ppt-tool.ts`**

imports 增：
```ts
import { extractBackgrounds } from "../ppt/theme-extractor.js";
import type { PptTheme, SlideBackground, OverlayMode } from "../ppt/theme-extractor.js";
```
`parameters.properties` 加：
```ts
        backgrounds: {
          type: "array",
          description: "用户上传的背景图（见 [PPT背景图已上传…] 标记）。role 缺省按序 cover/body/section。",
          items: {
            type: "object",
            properties: {
              assetId: { type: "string" },
              role: { type: "string", enum: ["cover", "body", "section"] },
              overlay: { type: "string", enum: ["dark", "light", "none"] },
            },
            required: ["assetId"],
          },
        },
```
`execute` 解构增 `backgrounds`。在「主题基准」`let theme = getPreset(themePreset) ?? DEFAULT_THEME;` 之后、模版处理之前，插入上传背景图解析：
```ts
      // 上传背景图：读字节 → SlideBackground，按 role 装配（缺省按序 cover/body/section）
      const ROLE_ORDER: ("cover" | "body" | "section")[] = ["cover", "body", "section"];
      const uploadedBg: NonNullable<PptTheme["backgrounds"]> = {};
      let ignoredBg = 0;
      if (Array.isArray(backgrounds) && backgrounds.length) {
        for (let i = 0; i < backgrounds.length; i++) {
          const spec = backgrounds[i] as { assetId?: string; role?: "cover" | "body" | "section"; overlay?: OverlayMode };
          const role = spec.role ?? ROLE_ORDER[i] ?? "body";
          try {
            const asset = await db.getAsset(spec.assetId ?? "");
            if (!asset || asset.user_id !== userId) throw new Error("bg not found");
            const bytes = await uploadStorage.get(asset.storage_key);
            const ext: "png" | "jpeg" = /jpe?g$/i.test(asset.mime ?? "") ? "jpeg" : "png";
            uploadedBg[role] = { image: bytes, ext, overlay: spec.overlay ?? "dark" };
            if (backgrounds.length === 1 && !spec.role) uploadedBg.body = uploadedBg.cover = { image: bytes, ext, overlay: spec.overlay ?? "dark" };
          } catch { ignoredBg++; }
        }
      }
      const hasUploadedBg = !!(uploadedBg.cover || uploadedBg.body || uploadedBg.section);
```
把降级链改为（替换第 97-148 行区域的模版处理逻辑主体，保留克隆/extractTheme 分支）：
```ts
      let buffer: Buffer | null = null;
      let themeNote = "";

      if (hasUploadedBg) {
        // 上传背景优先：配色仍可用模版提取/preset 作基准
        if (templateAssetId) {
          try {
            const asset = await db.getAsset(templateAssetId);
            if (asset && asset.user_id === userId) {
              const bytes = await uploadStorage.get(asset.storage_key);
              const extracted = await extractTheme(bytes);
              if (extracted !== DEFAULT_THEME) theme = extracted;
            }
          } catch { /* 配色提取失败无所谓，用 preset/default */ }
        }
        theme = { ...theme, backgrounds: { ...theme.backgrounds, ...uploadedBg } };
        themeNote = "\n已套用你上传的背景图。";
      } else if (templateAssetId) {
        let bytes: Buffer | null = null;
        try {
          const asset = await db.getAsset(templateAssetId);
          if (!asset || asset.user_id !== userId) throw new Error("template not found");
          bytes = await uploadStorage.get(asset.storage_key);
        } catch { themeNote = "\n注意：模版解析失败，已使用默认样式。"; }
        if (bytes) {
          try {
            const tplBg = await extractBackgrounds(bytes);
            if (tplBg) {
              const extracted = await extractTheme(bytes);
              theme = { ...(extracted !== DEFAULT_THEME ? extracted : theme), backgrounds: tplBg };
              themeNote = "\n已提取模版的背景图与配色套用到全部版式。";
            } else {
              const rich = await templateHasReusableDesign(bytes);
              if (rich) {
                try {
                  buffer = await renderPptxFromTemplate({ title, slides: degradeForClone(slides!) }, bytes);
                  themeNote = "\n已套用上传模版的版式、背景与母版样式。";
                } catch {
                  theme = await extractTheme(bytes);
                  themeNote = theme === DEFAULT_THEME ? "\n注意：模版解析失败，已使用默认样式。" : "\n注意：模版版式克隆失败，已退化为仅套用模版配色与字体。";
                }
              } else {
                theme = await extractTheme(bytes);
                themeNote = theme === DEFAULT_THEME ? "\n注意：模版仅含空白版式，已使用默认样式。" : "\n模版为空白版式型，已提取其配色与字体套用到内置精美版式。";
              }
            }
          } catch { themeNote = "\n注意：模版解析失败，已使用默认样式。"; }
        }
      }
      if (ignoredBg > 0) themeNote += `\n（有 ${ignoredBg} 张背景图无法读取，已忽略。）`;
```
在文件内加克隆降级映射纯函数：
```ts
/** 克隆路径只认 cover/section/content；把富版式文本化降级，避免 slideXml 丢内容。 */
function degradeForClone(slides: PptSlide[]): PptSlide[] {
  return slides.map((s) => {
    switch (s.layout) {
      case "stats":
      case "keypoints":
        return { layout: "content", title: s.title, bullets: (s.items ?? []).map((it) => it.value ? `${it.label}：${it.value}${it.desc ? `（${it.desc}）` : ""}` : `${it.label}${it.desc ? `：${it.desc}` : ""}`) };
      case "timeline":
        return { layout: "content", title: s.title, bullets: (s.items ?? []).map((it, i) => `${i + 1}. ${it.label}${it.desc ? `：${it.desc}` : ""}`) };
      case "compare":
        return { layout: "content", title: s.title, bullets: [`【${s.left?.title}】`, ...(s.left?.bullets ?? []), `【${s.right?.title}】`, ...(s.right?.bullets ?? [])] };
      case "quote":
        return { layout: "section", title: s.quote?.text ?? s.title, subtitle: s.quote?.author };
      case "agenda":
        return { layout: "content", title: s.title, bullets: (s.items ?? []).map((it) => it.label) };
      case "closing":
        return { layout: "section", title: s.title, subtitle: s.subtitle };
      default:
        return s;
    }
  });
}
```
> 保留原有 `if (!buffer) { buffer = await renderPptx({ title, slides }, theme); }` 收尾（此时 theme 可能已带 backgrounds）。

- [ ] **Step 4: 运行确认通过（含既有 ppt-tool 测试回归）**

Run: `npm test -w @lot-agent/server -- ppt-tool`
Expected: PASS

- [ ] **Step 5: 构建 + 提交**

Run: `npm run build -w @lot-agent/server`
```bash
git add packages/server/src/tools/ppt-tool.ts packages/server/src/tools/ppt-tool.test.ts
git commit -m "feat(ppt): generate_ppt 支持上传背景图 + 主题降级链重排 + 克隆降级映射"
```

---

# 阶段 P3：propose_outline 工具 + OutlineCard

## Task 11: propose_outline 工具 + 注册

**Files:**
- Create: `packages/server/src/tools/propose-outline-tool.ts`
- Modify: `packages/server/src/services/agent-service.ts`（注册）
- Test: `packages/server/src/tools/propose-outline-tool.test.ts`

**Interfaces:**
- Consumes: `validateSlides`（Task 1）
- Produces: `propose_outline` 工具（`endsTurn: true`），参数 = `{ title, slides }`（与 generate_ppt 同 slides schema）；成功返回占位文本，不产文件

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { proposeOutlineTool } from "./propose-outline-tool.js";

describe("propose_outline", () => {
  it("is an endsTurn tool", () => {
    expect(proposeOutlineTool.endsTurn).toBe(true);
    expect(proposeOutlineTool.name).toBe("propose_outline");
  });
  it("validates and returns a waiting placeholder", async () => {
    const r = await proposeOutlineTool.execute({ title: "T", slides: [{ layout: "cover", title: "封面" }] }, {} as any);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("大纲");
  });
  it("rejects invalid slides with validation errorKind", async () => {
    const r = await proposeOutlineTool.execute({ title: "T", slides: [{ layout: "stats", title: "t", items: [{ label: "x" }] }] }, {} as any);
    expect(r.isError).toBe(true);
    expect(r.errorKind).toBe("validation");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @lot-agent/server -- propose-outline`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `propose-outline-tool.ts`**

```ts
import type { Tool, ToolResult } from "@lot-agent/core";
import { validateSlides } from "../ppt/validation.js";
import type { PptSlide } from "../ppt/renderer.js";

const SLIDE_ITEMS = {
  type: "object",
  properties: {
    layout: { type: "string", enum: ["cover", "agenda", "section", "content", "keypoints", "stats", "compare", "timeline", "quote", "closing"] },
    title: { type: "string" },
    subtitle: { type: "string" },
    bullets: { type: "array", items: { type: "string" } },
    items: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, desc: { type: "string" } }, required: ["label"] } },
    left: { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["title", "bullets"] },
    right: { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["title", "bullets"] },
    quote: { type: "object", properties: { text: { type: "string" }, author: { type: "string" } }, required: ["text"] },
    notes: { type: "string" },
  },
  required: ["layout", "title"],
};

/** propose_outline — 把结构化大纲展示给用户确认；endsTurn，本轮结束等回复。不产文件。 */
export const proposeOutlineTool: Tool = {
  name: "propose_outline",
  description:
    "在生成 PPT 前，把逐页大纲（每页 layout + 标题 + 要点/数据/对比等）展示给用户确认或修改。" +
    "调用后本轮结束，用户会确认或提出修改意见。slides 结构与 generate_ppt 完全一致。",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "演示文稿标题" },
      slides: { type: "array", description: "逐页大纲，结构同 generate_ppt", items: SLIDE_ITEMS },
    },
    required: ["title", "slides"],
  },
  endsTurn: true,
  async execute(input): Promise<ToolResult> {
    const { slides } = (input as { slides?: PptSlide[] }) ?? {};
    const err = validateSlides(slides);
    if (err) return { content: `propose_outline 校验失败：${err}`, isError: true, errorKind: "validation" };
    return { content: "[大纲已展示给用户，等待确认或修改意见；用户的回复将作为下一条消息出现]" };
  },
};
```

- [ ] **Step 4: 注册（agent-service.ts）**

在 `createPptTool` 注册块（第 269-275 行）之后加：
```ts
    this.toolRegistry.register(proposeOutlineTool);
```
顶部 import：`import { proposeOutlineTool } from "../tools/propose-outline-tool.js";`

- [ ] **Step 5: 运行确认通过 + 构建**

Run: `npm test -w @lot-agent/server -- propose-outline && npm run build -w @lot-agent/server`
Expected: PASS + 构建通过

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/tools/propose-outline-tool.ts packages/server/src/tools/propose-outline-tool.test.ts packages/server/src/services/agent-service.ts
git commit -m "feat(ppt): propose_outline 工具（endsTurn 结构化大纲确认）"
```

---

## Task 12: OutlineCard 前端 + 接线

**Files:**
- Create: `packages/web/src/lib/layout-icons.tsx`
- Create: `packages/web/src/components/OutlineCard.tsx`
- Modify: `packages/web/src/components/MessageBubble.tsx`（渲染 propose_outline 卡片）
- Modify: `packages/web/src/components/ChatPanel.tsx`（`hasAsk` 泛化为「hasInteractive」，涵盖 propose_outline）
- Modify: `packages/web/src/App.css`（OutlineCard 样式，用 token）

**Interfaces:**
- Consumes: `message.toolCalls[].input`（含 `{ title, slides }`）、`onQuickReply`（发消息）
- Produces: `OutlineCard` 组件；MessageBubble 对 `tc.name === "propose_outline"` 渲染它

- [ ] **Step 1: 实现 `layout-icons.tsx`**（版式 → 单字/图标 + 中文名）

```tsx
export const LAYOUT_META: Record<string, { icon: string; label: string }> = {
  cover: { icon: "■", label: "封面" },
  agenda: { icon: "☰", label: "目录" },
  section: { icon: "▎", label: "章节" },
  content: { icon: "≡", label: "要点" },
  keypoints: { icon: "▦", label: "卡片" },
  stats: { icon: "▤", label: "数据" },
  compare: { icon: "▥", label: "对比" },
  timeline: { icon: "◷", label: "时间线" },
  quote: { icon: "❝", label: "引言" },
  closing: { icon: "◼", label: "结尾" },
};

export function layoutMeta(layout: string) {
  return LAYOUT_META[layout] ?? { icon: "•", label: layout };
}
```

- [ ] **Step 2: 实现 `OutlineCard.tsx`**

```tsx
import { layoutMeta } from "../lib/layout-icons.js";

interface OutlineSlide {
  layout: string;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  items?: { label: string; value?: string; desc?: string }[];
  left?: { title: string; bullets: string[] };
  right?: { title: string; bullets: string[] };
  quote?: { text: string; author?: string };
}
interface OutlineInput { title?: string; slides?: OutlineSlide[] }

interface OutlineCardProps {
  input: unknown;
  interactive: boolean;
  answer?: string;
  onReply?: (text: string) => void;
}

/** 单页摘要：把结构化字段压成一行提示文字。 */
function summary(s: OutlineSlide): string {
  if (s.bullets?.length) return s.bullets.join(" · ");
  if (s.items?.length) return s.items.map((it) => (it.value ? `${it.label} ${it.value}` : it.label)).join(" · ");
  if (s.left && s.right) return `${s.left.title} ↔ ${s.right.title}`;
  if (s.quote) return `“${s.quote.text}”${s.quote.author ? ` — ${s.quote.author}` : ""}`;
  return s.subtitle ?? "";
}

export function OutlineCard({ input, interactive, answer, onReply }: OutlineCardProps) {
  const parsed = (input ?? {}) as OutlineInput;
  const slides = parsed.slides ?? [];
  return (
    <div className={`outline-card${interactive ? "" : " answered"}`}>
      <div className="outline-head">
        <span className="outline-title">{parsed.title || "演示大纲"}</span>
        <span className="outline-count">共 {slides.length} 页</span>
      </div>
      <ol className="outline-list">
        {slides.map((s, i) => {
          const m = layoutMeta(s.layout);
          const sum = summary(s);
          return (
            <li key={i} className="outline-row">
              <span className="outline-index">{i + 1}</span>
              <span className="outline-layout" title={m.label}>{m.icon}</span>
              <span className="outline-body">
                <span className="outline-slide-title">{s.title || m.label}</span>
                {sum && <span className="outline-slide-sum">{sum}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {interactive ? (
        <div className="outline-actions">
          <button type="button" className="outline-confirm" onClick={() => onReply?.("确认，按此大纲生成")}>
            ✓ 确认生成
          </button>
          <span className="outline-hint">或直接在下方输入修改意见（如「第 3 页改成对比」）</span>
        </div>
      ) : (
        answer && <div className="outline-answered-note">已回复：{answer}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: ChatPanel 泛化交互判定**（第 143-159 行）

把 `hasAsk` 改为涵盖两种 endsTurn 卡片：
```tsx
          const interactiveNames = ["ask_user", "propose_outline"];
          const hasInteractive =
            msg.role === "assistant" &&
            !!msg.toolCalls?.some((tc) => interactiveNames.includes(tc.name));
          const askAnswer = hasInteractive
            ? messages.slice(i + 1).find((m) => m.role === "user")?.content
            : undefined;
```
`MessageBubble` props 保持传 `askAnswer` / `askInteractive={hasInteractive && askAnswer === undefined && !isStreaming}`（变量名沿用，改赋值来源即可）。

- [ ] **Step 4: MessageBubble 渲染 propose_outline**（第 137-148 行的 `if (tc.name === "ask_user")` 分支旁加）

顶部 import：`import { OutlineCard } from "./OutlineCard.js";`
在 map 内、`ask_user` 分支之后加：
```tsx
              if (tc.name === "propose_outline") {
                return (
                  <OutlineCard
                    key={i}
                    input={tc.input}
                    interactive={!!askInteractive}
                    answer={askAnswer}
                    onReply={onQuickReply}
                  />
                );
              }
```
并把 `propose_outline` 的占位 tool result 隐藏（仿第 77 行 ask_user）：
```tsx
    if (message.toolResult?.name === "propose_outline") return null;
```

- [ ] **Step 5: App.css OutlineCard 样式（用 token）**

```css
.outline-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--overlay-raise);
  padding: 14px 16px;
  margin-top: 8px;
}
.outline-card.answered { opacity: 0.7; }
.outline-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.outline-title { font-weight: 600; color: var(--text); }
.outline-count { font-size: 12px; color: var(--text-muted); }
.outline-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.outline-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 8px; background: var(--overlay-sink); }
.outline-index { color: var(--text-muted); font-size: 12px; min-width: 18px; text-align: right; }
.outline-layout { color: var(--accent); width: 18px; text-align: center; }
.outline-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.outline-slide-title { color: var(--text); font-size: 14px; }
.outline-slide-sum { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.outline-actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.outline-confirm { background: var(--accent); color: var(--accent-contrast, #fff); border: none; border-radius: 8px; padding: 7px 16px; cursor: pointer; font-size: 14px; }
.outline-confirm:hover { filter: brightness(1.05); }
.outline-hint, .outline-answered-note { font-size: 12px; color: var(--text-muted); }
```
> 若 `--accent-contrast`/`--overlay-sink`/`--text-muted` 等 token 名与 App.css 实际不符，改用文件里已存在的对应 token（先在 App.css 搜 `--text-muted`/`--overlay` 确认实名）。禁止硬编码 hex（`#fff` 仅作 fallback，若有 `--accent-contrast` 则以它为准）。

- [ ] **Step 6: web 构建校验**

Run: `npm run build -w @lot-agent/web`
Expected: 构建通过

- [ ] **Step 7: 提交**

```bash
git add packages/web/src/lib/layout-icons.tsx packages/web/src/components/OutlineCard.tsx packages/web/src/components/MessageBubble.tsx packages/web/src/components/ChatPanel.tsx packages/web/src/App.css
git commit -m "feat(ppt): OutlineCard 大纲确认卡片 + propose_outline 前端渲染"
```

---

## 收尾校验（全计划完成后）

- [ ] **全量测试**

Run: `npm test`
Expected: 全绿（含新增 validation / themes / layouts / background / theme-extractor / ppt-tool / propose-outline / loader 测试）

- [ ] **全量构建**

Run: `npm run build`
Expected: core / server / web 均构建通过

- [ ] **端到端手验（需 LLM key）**

用 `/run` 或 `npm run dev`，进 PPT Agent：
1. 不传任何文件 → agent 应 ask_user 让选主题 → 选「科技深色」→ propose_outline 出现 OutlineCard（含 stats/compare/timeline 等多版式）→ 点「确认生成」→ 拿到可下载 .pptx，打开确认多版式与页脚生效。
2. 上传一张背景图 → 生成结果封面/内页应贴该背景图 + 文字可读。
3. 上传一个带母版背景图的 .pptx 模版 → 结果应套用其背景图到全版式。

---

## Self-Review 记录（spec 覆盖对照）

| Spec 章节 | 对应 Task |
|---|---|
| 第 1 节 版式库 SlideSpec v2 + validateSlides | Task 1, 3, 4 |
| 第 1 节 多 accent / 页脚 / decor 装饰 | Task 2（decor 数据）、Task 3（helper）、Task 4（各 builder 用色） |
| 第 2 节 ThemePack 结构 + 内置预设 | Task 2, 7 |
| 第 2 节 输入路 a 模版背景图提取 | Task 8 |
| 第 2 节 输入路 b 背景图上传槽 | Task 9 |
| 第 2 节 输入路 c 内置主题预设 | Task 2, 5 |
| 第 2 节 降级链重排 | Task 10 |
| 第 3 节 skill agents 字段 + ppt-authoring | Task 6 |
| 第 4 节 propose_outline + OutlineCard | Task 11, 12 |
| 第 5 节 错误处理（降级注明 / 校验 / 克隆映射） | Task 5, 6, 9, 10 |
| 第 6 节 测试策略 | 各 Task 的 test 步骤 |
| 第 7 节 分期 | P1=Task1-6, P2=Task7-10, P3=Task11-12 |

**暂缓项（不在本计划）**：内页配图/图表、pptx→缩略图逐页预览、HTML 高保真渲染、图片亮度采样自动遮罩——均按 spec 保留接口不实现。
