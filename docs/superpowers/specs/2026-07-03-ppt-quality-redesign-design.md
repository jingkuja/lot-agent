# PPT 制作质量重构（版式库 × ThemePack × 制作工艺 skill）— 设计文档

日期：2026-07-03
状态：已与用户确认方向（产出形态 / 模版入口 / 交互深度三项决策 + 整体方案认可）

## 背景与目标

`ppt` Agent 已能产出真实 .pptx（见 2026-07-02 设计文档），但两个核心痛点：

1. **生成效果平淡**。根源在 `generate_ppt` 只有 3 种版式（cover/section/content），且每页只能
   表达「标题 + 3-6 条 bullets」——无论内容是数据、对比、流程还是引言，最终都渲染成同一种
   bullet 列表页；全篇只用 accent1 一个主题色，无页脚页码，装饰语言单一。
2. **模版解析不全面**。富模版走克隆路径但只填标题/正文两个占位符；「设计逐页画在幻灯片上」
   的空白版式型模版只提取到几个颜色与字体。两条路都丢掉模版的大部分设计信息（尤其背景图）。

本期方案（只设计，分期实现）用三个正交层解决：

- **版式库**（每页长什么样）：3 种 → 10 种版式；
- **ThemePack**（整体什么风格）：模版深化解析 / 背景图上传 / 内置主题预设，三路输入汇入同
  一套主题参数；
- **制作工艺 skill**（agent 怎么规划内容）：agent 作用域 skill 承载叙事结构与版式选择规则。

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 产出形态 | 原生可编辑 .pptx（pptxgenjs 纯代码绘制），不走 HTML→截图高保真路线；`SlideSpec → 渲染器` 接口边界保留将来换渲染实现的可能 |
| 模版入口 | 三路并存：保留 .pptx 模版上传（深化解析）+ 新增背景图上传槽 + 内置主题预设（AskUserCard 选择） |
| 交互深度 | 新增 OutlineCard 结构化大纲卡片（`propose_outline` 工具，复用 ask_user 的 endsTurn 卡片机制）；逐页缩略图预览暂缓 |
| 克隆路径去留 | 降级为 fallback：背景图提取成功一律走 ThemePack 内置渲染（全版式）；提取不到背景但判定富设计才走克隆（新版式按第 5 节规则降级映射） |
| 背景图遮罩 | 不引入图片解码依赖做亮度采样；默认深色渐变遮罩 + 白字，`generate_ppt` 暴露 `overlay: dark/light/none` 由 agent 按用户反馈调整 |
| 制作工艺载体 | skill frontmatter 新增可选 `agents` 字段：声明后只对这些 agent 注入且**无条件注入**（不走 trigger）；`ppt` systemPrompt 保持精简 |

## 第 1 节：版式库 SlideSpec v2

### Schema（`packages/server/src/ppt/renderer.ts` 导出，`generate_ppt` / `propose_outline` 共用）

```ts
interface PptSlide {
  layout:
    | "cover"      // 封面：title + subtitle（副标题/日期/作者）
    | "agenda"     // 目录：items（缺省时渲染期从后续 section 页标题自动生成）
    | "section"    // 章节：大章节号 + title + subtitle
    | "content"    // 常规要点：bullets（保留，视觉增强）
    | "keypoints"  // 卡片网格（2×2 / 3 卡）：items {label, desc}
    | "stats"      // 数据大字页（2-4 个）：items {value, label}
    | "compare"    // 双栏对比：left/right {title, bullets}
    | "timeline"   // 时间线/流程（3-6 节点）：items {label, desc}
    | "quote"      // 引言：quote {text, author}
    | "closing";   // 结尾：title + subtitle（感谢/行动号召）
  title: string;
  subtitle?: string;
  bullets?: string[];
  items?: { label: string; value?: string; desc?: string }[];
  left?: { title: string; bullets: string[] };
  right?: { title: string; bullets: string[] };
  quote?: { text: string; author?: string };
  notes?: string;
}
```

扁平对象 + 按版式校验（JSONSchema 只描述字段，逐版式必填/上限规则放纯函数
`validateSlides(slides): string | null`，返回首个错误消息，可单测）：

| layout | 校验规则 |
|---|---|
| cover / section / closing | title 非空 |
| content | bullets 1-8 条 |
| agenda | items 缺省允许（自动生成）；给了则 2-10 条 |
| keypoints | items 2-6，label 必填 |
| stats | items 2-4，value 与 label 均必填 |
| compare | left、right 均必填，各 bullets 1-5 条 |
| timeline | items 3-6 |
| quote | quote.text 非空 |

### 渲染实现

- `renderer.ts` 拆分：`ppt/layouts/` 目录每版式一个 builder 文件（`cover.ts`、`stats.ts`…），
  `renderer.ts` 保留主题定义分发与公共工具（darken、页脚绘制）。现有 3 个 builder 迁入。
- 所有 builder 共享的质量升级：
  - **多 accent 轮换**：章节序号、keypoints 卡片、timeline 节点、stats 数字按
    accent1→accent6 轮换取色（主题里 6 个 accent 已存在，目前只用 accent1）；
  - **页脚系统**：除 cover/section 外每页绘制页码 + 演示标题 + 细分隔线；
  - **装饰风格 `decor`**：主题声明 `circles`（几何圆，现有 cover 风格）/ `slant`（斜切色块）/
    `grid`（细网格线）/ `minimal`（无装饰）之一，builder 据此选择装饰绘制函数；
  - 中文排版：标题加粗对比、正文行距 1.3-1.4（paraSpaceAfter 已有，补 lineSpacing）、
    bullets 用主题色符号。

## 第 2 节：ThemePack 与三路输入

### 结构（`theme-extractor.ts` 的 `PptTheme` 扩展）

```ts
interface PptTheme {
  colors: { dk1; lt1; dk2; lt2; accent1..accent6 };   // 现有
  fonts: { major; minor };                             // 现有
  slideWidthIn: number; slideHeightIn: number;         // 现有
  decor: "circles" | "slant" | "grid" | "minimal";     // 新增，默认 circles
  backgrounds?: {                                      // 新增
    cover?: SlideBackground;    // 封面整页背景
    section?: SlideBackground;  // 章节页背景（缺省复用 cover）
    body?: SlideBackground;     // 内页背景
  };
}
interface SlideBackground {
  image: Buffer;                       // 图片字节
  ext: "png" | "jpeg";
  overlay: "dark" | "light" | "none";  // 文字可读性遮罩，默认 dark
}
```

渲染器只认 ThemePack，不关心来源。有 `backgrounds` 时对应版式整页贴图
（pptxgenjs `slide.background = { data: base64 }`）+ 渐变遮罩形状 + 反色文字；无背景时
走纯色/装饰绘制。

### 输入路 a：模版深化解析（theme-extractor v2）

现有颜色/字体/尺寸提取保留，新增**背景图提取** `extractBackgrounds(zip)`：

1. 解析 slideMaster / 被选中版式（复用 template-renderer 的 `pickLayouts` 结果）XML 中
   `<p:bg>` 里的 `<a:blip r:embed="rIdN">`，顺着该部件的 `_rels/*.rels` 解析 rId →
   `ppt/media/*` 目标，取出图片字节；
2. 归类：封面版式背景 → `cover`，母版/正文版式背景 → `body`，章节版式背景 → `section`；
3. 空白版式型模版（`templateHasReusableDesign` 为 false）：改从**幻灯片本体**提取——首页
   的整页背景图片（`<p:bg>` 或覆盖全页的 `<p:pic>`，按 xfrm 尺寸 ≥ 90% 页面判定）→ `cover`，
   第二页起同法 → `body`；
4. 仅支持 png/jpeg；其他格式（emf/wmf 等）跳过该项。

### 输入路 b：背景图上传槽（新）

- **web**：`InputBox` PPT 模式新增「背景图」按钮（`image/*`，最多 3 张），attachment chip
  加 `badge-background` 徽标；沿用现有 slot 机制。
- **server**：`attachment-extractor` 新 slot `"ppt_background"` → 只产引用标记
  `[PPT背景图已上传: 文件名 (backgroundAssetId: xxx)]`（同 ppt_template 模式，字节由工具
  凭 assetId 自取）。
- **工具**：`generate_ppt` 新参数
  `backgrounds?: { assetId: string; role?: "cover"|"body"|"section"; overlay?: "dark"|"light"|"none" }[]`；
  role 缺省时按序分配：第 1 张 cover、第 2 张 body、第 3 张 section；只有 1 张时该图
  cover+body 通用。
- 上传背景图的优先级高于模版提取的背景（用户显式给的素材优先）。

### 输入路 c：内置主题预设（`ppt/themes.ts` 新文件）

5-6 套完整 ThemePack：商务蓝（circles）、科技深色（grid）、暖橙创意（slant）、极简黑白
（minimal）、学术绿（grid）。`generate_ppt` 新参数 `themePreset?: string`。无模版无背景时
agent 用现有 ask_user 卡片让用户选主题（选项即预设名），或按主题内容直接推荐并说明。

### 主题解析优先级与降级链（`ppt-tool.ts`）

```
上传背景图 (backgrounds 参数)                    ← 最高优先，可与模版色彩提取叠加
  → 模版背景图提取成功 → ThemePack 渲染（全版式）
  → 提取不到背景 && templateHasReusableDesign → 克隆路径（新版式映射为 content 降级）
  → 色彩/字体提取（现有 extractTheme）
  → themePreset / DEFAULT_THEME
```

每级沿用现有 `themeNote` 注明机制；克隆路径的引用相等降级契约保留。

## 第 3 节：agent 作用域 skill 与制作工艺

### skill 机制扩展（core `skills/loader.ts` + server `agent-service.ts`）

- `Skill` frontmatter 新增可选 `agents: string[]`；
- 匹配规则：声明了 `agents` 的 skill **只对这些 agent 注入且无条件注入**（不参与 trigger
  匹配）；未声明的 skill 维持现有 trigger 行为、对所有 agent 生效；
- `agent-service.streamAgentResponse` 注入处改为
  `skillLoader.match(userMessage, { agentId: def.id })`（loader 内部合并两类）。

### `skills/ppt-authoring.md`（新，`agents: [ppt]`）

`ppt.ts` systemPrompt 精简为角色 + 红线（不编造 assetId、不暴露内部 id、工具纪律）；制作
工艺全部进 skill：

- **叙事骨架**：cover → agenda → 2-4 个章节（每章 section + 2-3 页正文）→ closing；
- **版式多样性硬规则**：连续 content 页 ≤ 2；内容含数字/百分比 → stats；含方案/新旧对比 →
  compare；含阶段/步骤/里程碑 → timeline；有金句/定位语 → quote；并列要点成组 → keypoints；
- **文案规范**：bullets 每条 ≤ 20 字、观点先行；stats 的 value 必须来自用户素材，不得编造；
  keypoints 的 desc 一句话；
- **流程**：盘点输入（模版/背景图/素材标记）→ ask_user 补关键信息（无风格来源时选主题预设）→
  `propose_outline` 出结构化大纲 → 用户确认后 `generate_ppt` → 修改时只改对应页重新 propose。

## 第 4 节：propose_outline 工具 + OutlineCard

- **工具**（server tools 新文件）：参数与 `generate_ppt` 的 `title + slides` 相同 schema，
  标记 `endsTurn: true`（复用 ask_user 的回合制机制）；execute 只做 `validateSlides` 校验后
  返回占位文本 `[大纲已展示给用户，等待确认或修改意见]`，不产文件；
- **web**：`ChatPanel` 对 `propose_outline` 工具调用特殊渲染 `OutlineCard.tsx`（新组件，
  仿 AskUserCard）：头部标题 + 总页数，逐页行 = 版式图标 + 标题 + 要点/条目摘要，底部
  「✓ 确认生成」（回发固定文本"确认，按此大纲生成"）与「✎ 提修改意见」（聚焦输入框）；
  样式全部走 `var(--*)` token；
- 用户提修改意见（如"第 3 页改成对比"）→ agent 只改对应页、重新 propose_outline。

## 第 5 节：错误处理

- 主题降级链每级 themeNote 透明注明（现有模式）；
- `backgrounds` 中 assetId 读不到 / 非本人资产 / 非 png-jpeg → 忽略该项并在结果注明；
- `propose_outline` / `generate_ppt` 校验失败 → `errorKind: "validation"`（现有模式，agent
  可自修复重试）；
- 克隆路径遇到新版式：映射规则纯函数（stats/compare/timeline/keypoints → content bullets 文本
  化；quote → section），不抛错。

## 第 6 节：测试策略（TDD，沿用 fixture 模式）

- `validateSlides`：每版式必填/上限 + 非法 layout 单测；
- theme-extractor v2：构造带背景图的 fixture pptx（仿 `template-renderer.fixture.ts`）→
  断言 backgrounds 提取与归类（master 背景 → body、封面版式 → cover、空白版式型从 slide 提取）；
- renderer：每版式渲染后解 zip 断言文本存在；带 backgrounds 时断言 media 部件与遮罩形状存在；
- SkillLoader：`agents` 字段解析 + 注入范围（ppt 命中、其他 agent 不命中、无 agents 的 skill
  维持 trigger 行为）；
- 降级链：坏 zip / 无背景富模版 / 空白版式型 三个 fixture 走出三条不同 themeNote；
- 克隆路径新版式映射纯函数单测。

## 第 7 节：分期（每期独立可交付）

| 期 | 内容 | 触及 |
|---|---|---|
| P1 | 版式库 10 种 + 多 accent/页脚/decor + 内置主题预设 + skill agents 字段 + ppt-authoring skill | core/skills、server/ppt、skills/、ppt.ts |
| P2 | theme-extractor v2 背景图提取 + 背景图上传槽 + 降级链重排 | server/ppt、attachment-extractor、ppt-tool、web InputBox |
| P3 | propose_outline 工具 + OutlineCard | server/tools、web ChatPanel/OutlineCard |

## 暂缓项（接口不封死）

内页配图与图表生成（依赖真实图片素材管线）、pptx→缩略图逐页预览（依赖 LibreOffice headless
级转换）、HTML→截图高保真渲染模式、图片亮度采样自动遮罩（需图片解码依赖）。
`SlideSpec → 渲染器` 边界天然支持将来替换/并列新的渲染实现。
