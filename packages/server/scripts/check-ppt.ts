/** Local visual regression fixture. No model calls, credentials or network requests. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderPptx } from "../src/ppt/renderer.js";
import { renderPptPreview } from "../src/ppt/preview.js";
import { THEME_PRESETS } from "../src/ppt/themes.js";
import { PPT_THEMES, validateDeck, type PptDeck } from "@lot-agent/core/presentation";

const output = resolve(process.argv[2] || "../../data/tmp/ppt-quality");
const deck: PptDeck = {
  title: "从问题到行动：产品体验改进", themePreset: "business",
  brief: { audience: "产品与工程团队", objective: "确认改进顺序", durationMinutes: 12, targetSlides: 12, contentMode: "generate", assumptions: ["所有数值为视觉测试示例，不代表真实经营数据"] },
  slides: [
    { layout: "cover", title: "让生成内容更清楚、更可控", subtitle: "产品体验改进 · 视觉测试样例" },
    { layout: "agenda", title: "先对齐问题，再确定改进顺序", items: [{ label: "当前体验与关键问题" }, { label: "证据、方案与取舍" }, { label: "实施节奏与下一步" }] },
    { layout: "section", title: "从一次性交付走向持续修改", subtitle: "内容、视觉与交互需要一起改进" },
    { layout: "content", title: "确认内容应与最终输出保持一致", bullets: ["先说明受众与目标，避免反复追问", "让用户看见每页结论及证据", "确认后直接排版，保留用户改过的文字", "把长解释留在备注中，让正文便于阅读"], notes: "演讲者备注用于解释方法与限制，不挤占正文。" },
    { layout: "keypoints", title: "把修改集中在真正影响理解的地方", items: [{ label: "明确目标", desc: "围绕听众要作出的决定组织内容", icon: "target" }, { label: "保留证据", desc: "让来源、口径与结论同时可见", icon: "shield" }, { label: "直接修改", desc: "改标题、要点和数据后重新导出", icon: "check" }] },
    { layout: "stats", title: "独立指标适合突出展示", items: [{ value: "12", label: "访谈人数", desc: "示例统计" }, { value: "3", label: "主要问题", desc: "用于测试排版" }, { value: "2 周", label: "试点周期", desc: "计划示例" }], source: "示例数据，仅用于视觉测试" },
    { layout: "compare", title: "把用户确认的内容作为生成依据", left: { title: "原有流程", bullets: ["只发送一句确认", "输出依赖再次组织", "修改后重跑整轮对话"] }, right: { title: "改进流程", bullets: ["确认具体页面和主题", "按已确认内容直接导出", "保留其余页面，仅修改需要的字段"] } },
    { layout: "timeline", title: "先修硬伤，再验证完整体验", items: [{ label: "梳理输入", desc: "区分素材与模板" }, { label: "确认内容", desc: "逐页检查结论" }, { label: "生成文稿", desc: "校验文字容量" }, { label: "预览修改", desc: "检查实际输出" }, { label: "验证效果", desc: "收集使用反馈" }, { label: "持续完善", desc: "增加模板资产" }] },
    {
      layout: "chart", title: "四轮试点中，完成任务增加，返工减少", bullets: ["第四轮完成 26 项任务，高于第一轮的 12 项。", "需要修改的任务从 9 项降至 4 项。"],
      chart: { type: "bar", categories: ["第一轮", "第二轮", "第三轮", "第四轮"], series: [
        { name: "完成任务", values: [12, 16, 21, 26] }, { name: "需要修改", values: [9, 8, 6, 4] },
      ], unit: "任务数", source: "示例数据，仅用于视觉测试" }, notes: "数据为人工构造的测试样例，不得用于对外报告。",
    },
    { layout: "table", title: "为每项验证任务指定负责人", table: {
      columns: ["验证任务", "负责人", "交付物"],
      rows: [["核对标题与来源", "产品", "逐页修改清单"], ["测试导出与重试", "工程", "导出回归结果"], ["检查中文及深色主题", "设计", "逐页预览"]],
    } },
    { layout: "quote", title: "设计原则", quote: { text: "每一页都应帮助听众理解一个清楚的观点。", author: "本项目的写作原则" } },
    { layout: "closing", title: "从一份真实材料开始验证", subtitle: "检查内容准确性、阅读体验与修改效率" },
  ],
};
const error = validateDeck(deck);
if (error) throw new Error(error);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "deck.json"), JSON.stringify(deck, null, 2));
for (const name of PPT_THEMES) {
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
    { layout: "content", title: "从用户材料提取事实，按表达目标分配页数", bullets: [
      "列出每页需要回答的一个问题并标注关键信息来自哪份材料",
      "遇到缺失值时保留数据口径与适用条件，必要时安排单独的说明页",
      "依据受众对主题的熟悉程度选择术语，记录不确定的信息供下次核对",
      "在导出完成后检查中英文长标题，确认关键信息在页面上都可读",
    ] },
    { layout: "content", title: "从三个角度检查演示文稿", bullets: [
      "内容：逐条核对事实、引用和数据单位", "结构：让证据贴近结论", "版面：检查中英文长文本及深色主题的对比度",
    ] },
    { ...deck.slides.find(s => s.layout === "stats")!, title: "把一项核心指标放在页面首位" },
    { layout: "keypoints", title: "把并列要点安排成开放列", items: [
      { label: "结论", desc: "先确定听众需要理解的判断", icon: "target" }, { label: "证据", desc: "把单位和来源放在数据旁" },
      { label: "下一步", desc: "标出负责人和行动" },
    ] },
    { layout: "timeline", title: "把连续阶段排成箭头", items: [
      { label: "调研", desc: "访谈用户" }, { label: "试点", desc: "收集实际反馈" }, { label: "复盘", desc: "核对结果与预期" },
    ] },
    { layout: "table", title: "六列表格保留缺失值与数据来源", source: "测试样例；数值为人工构造", table: {
      columns: ["门店", "第一轮", "第二轮", "第三轮", "第四轮", "数据状态"],
      rows: Array.from({ length: 8 }, (_, i) => [`门店 ${i + 1}`, "12", "17", "21", i === 3 ? "" : "26", i === 3 ? "等待店长复核末轮统计" : "已按相同口径核对"]),
    } },
    ...(["line", "pie"] as const).map(type => ({ layout: "chart" as const, title: type === "line" ? "折线图展示按时间排列的示例数据" : "饼图展示一个整体的示例构成", chart: {
      type, categories: ["第一季度", "第二季度", "第三季度", "第四季度"], series: [{ name: "完成任务", values: [12, 16, 21, 26] }], unit: "任务数", source: "示例数据，仅用于视觉测试",
    } })),
  ],
};
const denseError = validateDeck(dense);
if (denseError) throw new Error(denseError);
for (const name of ["business", "tech-dark"] as const) {
  const dir = resolve(output, `${name}-dense`);
  await mkdir(dir, { recursive: true });
  const pptx = await renderPptx(dense, THEME_PRESETS[name]);
  await writeFile(resolve(dir, "sample.pptx"), pptx);
  const pages = await renderPptPreview(pptx, dense.slides.length, undefined, resolve("../../assets/fonts"));
  if (!pages) throw new Error(`Dense preview unavailable for ${name}.`);
  for (let i = 0; i < pages.length; i++) await writeFile(resolve(dir, `slide-${i + 1}.png`), pages[i]);
  console.log(`${name}-dense: ${pages.length} slides rendered to ${dir}`);
}
