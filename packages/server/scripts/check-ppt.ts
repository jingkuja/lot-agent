/** Local visual regression fixture. No model calls, credentials or network requests. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderPptx } from "../src/ppt/renderer.js";
import { renderPptPreview } from "../src/ppt/preview.js";
import { THEME_PRESETS } from "../src/ppt/themes.js";
import { validateDeck, type PptDeck } from "@lot-agent/core/presentation";

const output = resolve(process.argv[2] || "../../data/tmp/ppt-quality");
const deck: PptDeck = {
  title: "从问题到行动：产品体验改进", themePreset: "business",
  brief: { audience: "产品与工程团队", objective: "确认改进顺序", durationMinutes: 12, targetSlides: 11, contentMode: "generate", assumptions: ["所有数值为视觉测试示例，不代表真实经营数据"] },
  slides: [
    { layout: "cover", title: "让生成内容更清楚、更可控", subtitle: "产品体验改进 · 视觉测试样例" },
    { layout: "agenda", title: "先对齐问题，再确定改进顺序", items: [{ label: "当前体验与关键问题" }, { label: "证据、方案与取舍" }, { label: "实施节奏与下一步" }] },
    { layout: "section", title: "从一次性交付走向持续修改", subtitle: "内容、视觉与交互需要一起改进" },
    { layout: "content", title: "确认内容应与最终输出保持一致", bullets: ["先说明受众与目标，避免反复追问", "让用户看见每页结论及证据", "确认后直接排版，保留用户改过的文字", "把长解释留在备注中，让正文便于阅读"], notes: "演讲者备注用于解释方法与限制，不挤占正文。" },
    { layout: "keypoints", title: "把修改集中在真正影响理解的地方", items: [{ label: "明确目标", desc: "围绕听众要作出的决定组织内容", icon: "target" }, { label: "保留证据", desc: "让来源、口径与结论同时可见", icon: "shield" }, { label: "直接修改", desc: "改标题、要点和数据后重新导出", icon: "check" }] },
    { layout: "stats", title: "独立指标适合突出展示", items: [{ value: "12", label: "访谈人数", desc: "示例统计" }, { value: "3", label: "主要问题", desc: "用于测试排版" }, { value: "2 周", label: "试点周期", desc: "计划示例" }], source: "示例数据，仅用于视觉测试" },
    { layout: "compare", title: "把用户确认的内容作为生成依据", left: { title: "原有流程", bullets: ["只发送一句确认", "输出依赖再次组织", "修改后重跑整轮对话"] }, right: { title: "改进流程", bullets: ["确认具体页面和主题", "按已确认内容直接导出", "保留其余页面，仅修改需要的字段"] } },
    { layout: "timeline", title: "先修硬伤，再验证完整体验", items: [{ label: "梳理输入", desc: "区分素材与模板" }, { label: "确认内容", desc: "逐页检查结论" }, { label: "生成文稿", desc: "校验文字容量" }, { label: "预览修改", desc: "检查实际输出" }, { label: "验证效果", desc: "收集使用反馈" }, { label: "持续完善", desc: "增加模板资产" }] },
    { layout: "chart", title: "用真实图表呈现可比较的数据", chart: { type: "bar", categories: ["第一轮", "第二轮", "第三轮", "第四轮"], series: [{ name: "完成任务", values: [12, 16, 21, 26] }, { name: "需要修改", values: [9, 8, 6, 4] }], unit: "任务数", source: "示例数据，仅用于视觉测试" }, notes: "数据为人工构造的测试样例，不得用于对外报告。" },
    { layout: "quote", title: "设计原则", quote: { text: "每一页都应帮助听众理解一个清楚的观点。", author: "本项目的写作原则" } },
    { layout: "closing", title: "从一份真实材料开始验证", subtitle: "检查内容准确性、阅读体验与修改效率" },
  ],
};
const error = validateDeck(deck);
if (error) throw new Error(error);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "deck.json"), JSON.stringify(deck, null, 2));
for (const name of ["business", "tech-dark", "warm", "mono", "academic"]) {
  const dir = resolve(output, name);
  await mkdir(dir, { recursive: true });
  const pptx = await renderPptx(deck, THEME_PRESETS[name]);
  await writeFile(resolve(dir, "sample.pptx"), pptx);
  const pages = await renderPptPreview(pptx, deck.slides.length, undefined, resolve("../../assets/fonts"));
  if (!pages) throw new Error(`Preview unavailable for ${name}; verify LibreOffice and pdftoppm installation.`);
  for (let i = 0; i < pages.length; i++) await writeFile(resolve(dir, `slide-${i + 1}.png`), pages[i]);
  console.log(`${name}: ${pages.length} slides rendered to ${dir}`);
}

// Dense mixed-language content checks the smaller text boxes and all chart types.
const dense: PptDeck = {
  title: "容量与图表测试",
  slides: [
    { layout: "content", title: "Readable slides keep the evidence close to each decision", bullets: [
      "Start with the audience, the decision and available evidence.",
      "Keep one claim per slide and show its source nearby.",
      "Put methodology in notes and retain important caveats.",
      "Preserve confirmed wording and theme when exporting again.",
      "Compare alternatives; use timelines for ordered milestones.",
      "Keep missing values visible instead of replacing them with zero.",
      "Review rendered slides before sharing the final presentation.",
      "Label example values separately from source-backed data.",
    ] },
    { layout: "keypoints", title: "六个并列要点仍需保留清楚的文字层级", items: Array.from({ length: 6 }, (_, i) => ({
      label: `第${i + 1}阶段明确受众与当前决策目标`, desc: "在有限版面内保留关键事实及其适用条件，并让听众看清下一步行动。", icon: "target" as const,
    })) },
    { layout: "timeline", title: "六阶段时间线检查较长的标签与说明", items: Array.from({ length: 6 }, (_, i) => ({
      label: `第${i + 1}阶段完成资料核对与结果检查`, desc: "记录来源、保留限制条件，组织团队复核关键结论后再进入下一阶段。",
    })) },
    { layout: "stats", title: "四组指标保留单位与解释", items: Array.from({ length: 4 }, (_, i) => ({
      value: `${i + 1},280 万`, label: "已完成核对的示例收入统计", desc: "这里展示人工构造的数据，仅用于检查版式，不代表实际经营情况。",
    })), source: "测试样例；指标及数值为人工构造" },
    ...(["line", "pie"] as const).map(type => ({ layout: "chart" as const, title: type === "line" ? "折线图展示按时间排列的示例数据" : "饼图展示一个整体的示例构成", chart: {
      type, categories: ["第一季度", "第二季度", "第三季度", "第四季度"], series: [{ name: "完成任务", values: [12, 16, 21, 26] }], unit: "任务数", source: "示例数据，仅用于视觉测试",
    } })),
  ],
};
const denseError = validateDeck(dense);
if (denseError) throw new Error(denseError);
for (const name of ["business", "tech-dark"]) {
  const dir = resolve(output, `${name}-dense`);
  await mkdir(dir, { recursive: true });
  const pptx = await renderPptx(dense, THEME_PRESETS[name]);
  await writeFile(resolve(dir, "sample.pptx"), pptx);
  const pages = await renderPptPreview(pptx, dense.slides.length, undefined, resolve("../../assets/fonts"));
  if (!pages) throw new Error(`Dense preview unavailable for ${name}.`);
  for (let i = 0; i < pages.length; i++) await writeFile(resolve(dir, `slide-${i + 1}.png`), pages[i]);
  console.log(`${name}-dense: ${pages.length} slides rendered to ${dir}`);
}
