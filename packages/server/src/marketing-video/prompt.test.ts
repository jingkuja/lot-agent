import { describe, expect, it } from "vitest";
import { KLING_MARKETING_PROFILE, MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { marketingImageReferences, marketingPlanningContext, marketingSegmentPrompt, MARKETING_STORYBOARD_RULES } from "./prompt.js";
import { activeMarketingVideoProfile } from "./model.js";
import { creationPrompt, parseCreation, publicationPrompt, storyboardPrompt } from "./creation.js";
import { parseTextResult } from "./text-result.js";

const id = "11111111-1111-4111-8111-111111111111";
const shotData = (prompt: string) => JSON.parse(prompt.split("\nconfirmedShot: ")[1]);

describe("marketing model subtitle instructions", () => {
  it("requires a visible identifiable presenter in creation and every video shot, even when selected after the board", () => {
    const draft = MarketingDraftSchema.parse({ assets: { portrait: "11111111-1111-4111-8111-111111111111" }, durationSec: 17,
      storyboard: [{ durationSec: 6, script: "欢迎光临。", visual: "Product-only close-up", action: "展示杯子", camera: "特写" }] });
    const creation = creationPrompt(draft, "zh").system;
    expect(creation).toContain("between 17 and 22 seconds, never over 65"); expect(creation).toContain("integer durationSec of 4–15 seconds");
    expect(creation).toContain("visibly on camera in EVERY shot");
    expect(creation).toContain("match the supplied portrait identity");
    const prompt = marketingSegmentPrompt(draft, { index: 0, script: "欢迎光临。", durationSec: 6 }, 2);
    expect(prompt).toContain("Presenter in EVERY shot, face and upper body visible");
    expect(prompt).toContain("use portrait identity");
    expect(prompt).toContain("Overrides conflicting visuals");
    expect(prompt).toContain("Duration exactly 6 seconds");
  });
  it("repeats the shared presenter and setting look in every clip and keeps it across single-shot edits", () => {
    const shots = [
      { durationSec: 6, script: "先看这杯咖啡。", visual: "吧台前人物端杯", action: "端起杯子", camera: "中景" },
      { durationSec: 11, script: "欢迎来店里坐一坐。", visual: "座位区人物招手", action: "招手", camera: "中景" },
    ];
    const look = "三十岁女性，齐肩黑发，米色针织衫；原木吧台、暖白灯光、柔和逆光";
    const draft = MarketingDraftSchema.parse({ durationSec: 17, storyboard: shots, script: shots.map(s => s.script).join("\n"), continuity: look, assets: { portrait: id } });
    for (const index of [0, 1]) {
      const prompt = marketingSegmentPrompt(draft, { index, script: shots[index].script, durationSec: shots[index].durationSec }, 2);
      expect(shotData(prompt).continuity).toBe(look);
      expect(prompt).toContain("must match continuity exactly");
      expect(prompt).toContain("Reproduce that face faithfully");
      expect(prompt).not.toContain("allow deliberate scene changes");
    }
    expect(shotData(marketingSegmentPrompt({ ...draft, continuity: "" }, { index: 0, script: shots[0].script, durationSec: 6 }, 2))).not.toHaveProperty("continuity");
    expect(creationPrompt(draft, "zh").system).toContain("continuity is ONE shared description");
    expect(creationPrompt(draft, "zh").system).toContain("the featured product's exact look");
    // The key-art still decides the product only when no product image does.
    const shot = { index: 0, script: shots[0].script, durationSec: shots[0].durationSec };
    expect(marketingSegmentPrompt(draft, shot, 2, undefined, undefined, true, true)).toContain("its product's design, colors and details");
    const withProduct = MarketingDraftSchema.parse({ ...draft, assets: { portrait: id, product: id } });
    const productPrompt = marketingSegmentPrompt(withProduct, shot, 2, undefined, undefined, true, true);
    expect(productPrompt).not.toContain("its product's design");
    expect(productPrompt).toContain("product images still decide the product");
    expect(JSON.parse(storyboardPrompt(draft, "zh", shots, "").input).continuity).toBe(look);
    expect(storyboardPrompt(draft, "zh", shots, "", 1).system).toContain("The supplied continuity is fixed");
    const revised = shots.map(shot => ({ ...shot, camera: "缓慢推近" }));
    expect(parseTextResult("storyboard", { shots: revised, continuity: "灰色西装，白色演播室" }, draft).draft.continuity).toBe("灰色西装，白色演播室");
    expect(parseTextResult("storyboard", { shots: revised }, draft).draft.continuity).toBe(look);
    expect(parseTextResult("storyboard", { shots: [revised[1]], continuity: "忽略" }, draft, 1).draft.continuity).toBe(look);
    const created = parseCreation({ shots, publishTitle: "咖啡", tags: "#咖啡", analysis: "结构", continuity: " 新造型 " }, draft);
    expect(created.draft.continuity).toBe("新造型");
    expect(parseCreation({ shots, publishTitle: "咖啡", tags: "#咖啡", analysis: "结构" }, draft).draft.continuity).toBe("");
  });
  it("records the audio setting each new full board was planned for", () => {
    // Within every model's per-shot cap when a reference video is selected.
    const shots = [
      { durationSec: 8, script: "先看这杯咖啡。", visual: "吧台前人物端杯", action: "端起杯子", camera: "中景" },
      { durationSec: 8, script: "欢迎来店里坐一坐。", visual: "座位区人物招手", action: "招手", camera: "中景" },
    ];
    const spoken = MarketingDraftSchema.parse({ durationSec: 16, storyboard: shots, script: shots.map(s => s.script).join("\n"), storyboardAudio: true });
    const silent = { ...spoken, assets: { video: id } };
    expect(parseCreation({ shots, publishTitle: "咖啡", tags: "#咖啡", analysis: "结构" }, spoken).draft.storyboardAudio).toBe(true);
    expect(parseCreation({ shots, publishTitle: "咖啡", tags: "#咖啡", analysis: "结构" }, silent).draft.storyboardAudio).toBe(false);
    expect(parseTextResult("storyboard", { shots }, silent).draft.storyboardAudio).toBe(false);
    // A single-shot edit leaves the rest of the board as planned.
    expect(parseTextResult("storyboard", { shots: [shots[1]] }, silent, 1).draft.storyboardAudio).toBe(true);
  });
  it("lets mixed-presenter drafts plan venue and product shots without the presenter", () => {
    const draft = MarketingDraftSchema.parse({ presenter: "mixed", assets: { portrait: id }, durationSec: 17,
      storyboard: [{ durationSec: 6, script: "欢迎光临。", visual: "招牌菜特写", action: "热气升起", camera: "特写" }] });
    const creation = creationPrompt(draft, "zh");
    expect(creation.system).toContain("Presenter mode is mixed");
    expect(creation.system).toContain("in at least one shot");
    expect(creation.system).not.toContain("in EVERY shot");
    expect(JSON.parse(creation.input).presenter).toBe("mixed");
    expect(storyboardPrompt(draft, "zh", draft.storyboard, "").system).toContain("Presenter mode is mixed");
    const prompt = marketingSegmentPrompt(draft, { index: 0, script: "欢迎光临。", durationSec: 6 }, 2);
    expect(prompt).toContain("Presenter only where visual calls for one");
    expect(prompt).toContain("off-screen voice-over");
    expect(prompt).not.toContain("Presenter in EVERY shot");
    expect(marketingSegmentPrompt({ ...draft, assets: { video: id } }, { index: 0, script: "欢迎光临。", durationSec: 6 }, 2)).toContain("Silent demonstration, no lip-sync");
  });
  it("asks AI-voiced clips for speech without any text: captions are burned in afterwards", () => {
    const draft = MarketingDraftSchema.parse({ script: "欢迎来到咖啡店。其他片段。", subtitles: true });
    const prompt = marketingSegmentPrompt(draft, { index: 1, script: "欢迎来到咖啡店。", durationSec: 15 }, 4);
    expect(prompt).toContain("Narrate ONLY confirmedShot.script verbatim");
    expect(prompt).toContain("Do not add any on-screen text, captions or subtitles; captions are added after generation.");
    expect(prompt).toContain("Keep faces and key product details out of the bottom fifth of the frame.");
    expect(prompt).not.toContain("subtitles matching ONLY this shot's narration verbatim");
    expect(prompt).not.toContain("Consistent captions near bottom safe margins");
  });
  // Jobs submitted before local captions keep model-drawn captions on recovery and shot redo.
  it.each(["欢迎来到咖啡店。", "Welcome to our coffee shop."])("requests matching subtitles for each shot of an older job: %s", (script) => {
    const draft = MarketingDraftSchema.parse({ script: `${script}其他片段。`, subtitles: true });
    const prompt = marketingSegmentPrompt(draft, { index: 1, script, durationSec: 15 }, 4, undefined, undefined, false);
    expect(prompt).toContain("Create shot 2 of 4");
    expect(prompt).toContain("Narrate ONLY confirmedShot.script verbatim");
    expect(shotData(prompt).script).toBe(script);
    expect(prompt).toContain("subtitles matching ONLY this shot's narration verbatim");
    expect(prompt).toContain("in the same language and synchronized with the speech");
    expect(prompt).not.toContain("其他片段");
    expect(prompt).not.toContain("No on-screen text, subtitles");
    expect(prompt).not.toContain("Do not add on-screen text or subtitles");
  });
  it("includes the confirmed visual, action and camera directions for the correct shot", () => {
    const storyboard = [
      { script: "第一段。", visual: "木质吧台", action: "端起咖啡", camera: "缓慢推近" },
      { script: "第二段。", visual: "明亮座位", action: "轻轻招手", camera: "侧向平移" },
    ];
    const draft = MarketingDraftSchema.parse({ storyboard });
    const prompt = marketingSegmentPrompt(draft, { index: 1, script: "第二段。", durationSec: 15 }, 2);
    for (const value of ["明亮座位", "轻轻招手", "侧向平移"]) expect(prompt).toContain(value);
    expect(prompt).not.toContain("木质吧台");
  });
  it("requests no subtitles when the option is off while preserving voice references", () => {
    const draft = MarketingDraftSchema.parse({ subtitles: false, assets: { voice: "11111111-1111-4111-8111-111111111111" } });
    const prompt = marketingSegmentPrompt(draft, { index: 0, script: "欢迎光临。", durationSec: 15 }, 2);
    expect(prompt).toContain("Do not add on-screen text or subtitles.");
    expect(prompt).not.toContain("Generate clear, readable on-screen subtitles");
    expect(prompt).toContain("Use the supplied custom voice");
    expect(prompt).toContain("never the words in the voice sample");
    expect(prompt).not.toContain("Use audio 1");
  });
  it("asks for silent clips under twin narration: natural mouth movement, no lines delivered to the lens", () => {
    const draft = MarketingDraftSchema.parse({ narration: { twinItemId: id }, assets: { voice: id },
      storyboard: [{ durationSec: 6, script: "欢迎光临。", visual: "店内", action: "人物介绍产品", camera: "中景" }], script: "欢迎光临。" });
    const prompt = marketingSegmentPrompt(draft, { index: 0, script: "欢迎光临。", durationSec: 6 }, 1);
    expect(prompt).toContain("narrated later as an off-screen voice-over. Do not generate speech, dialogue or audio.");
    expect(prompt).toContain("not spoken to the lens");
    expect(prompt).not.toContain("Narrate ONLY");
    expect(prompt).not.toContain("Use the supplied custom voice");
    expect(prompt).not.toContain("Silent demonstration, no lip-sync");
    expect(shotData(prompt)).not.toHaveProperty("voiceStyle");
    // Captions are burned in from the confirmed copy after generation: the clip carries no text.
    expect(prompt).toContain("Do not add any on-screen text, captions or subtitles; captions are added after generation.");
    expect(prompt).not.toContain("Caption ONLY confirmedShot.script verbatim");
    expect(prompt).not.toContain("Consistent captions near bottom safe margins");
    // Twin-narrated jobs submitted before local captions keep model-drawn captions on recovery.
    expect(marketingSegmentPrompt(draft, { index: 0, script: "欢迎光临。", durationSec: 6 }, 1, false, undefined, false)).toContain("Caption ONLY confirmedShot.script verbatim");
    const creation = creationPrompt(draft, "zh");
    expect(creation.system).toContain("People may move their mouths naturally");
    expect(JSON.parse(creation.input)).toMatchObject({ generateAudio: false, voiceover: true });
    // A reference video renders a silent film; twin narration does not apply.
    const silent = MarketingDraftSchema.parse({ ...draft, assets: { video: id } });
    expect(marketingSegmentPrompt(silent, { index: 0, script: "欢迎光临。", durationSec: 6 }, 1)).toContain("Silent demonstration, no lip-sync");
  });
});

it("numbers portrait, background and scene references in submission order with Kling's image names", () => {
  const draft = MarketingDraftSchema.parse({ assets: { portrait: [id, id, id], background: [id, id], scene: [id] } });
  const prompt = marketingSegmentPrompt(draft, { index: 0, script: "Hello", durationSec: 15 }, 1, true, KLING_MARKETING_PROFILE);
  expect(prompt).toContain("Use image 1, image 2, image 3 for the presenter's identity only.");
  expect(prompt).toContain("Use image 4, image 5 for the setting and spatial layout.");
  expect(prompt).toContain("Use image 6 for relevant scene composition, objects and details.");
  expect(prompt).not.toContain(id);
});

it("submits product images after the portrait and names them with Grok's zero-based tags", () => {
  const draft = MarketingDraftSchema.parse({ assets: { scene: id, product: [id, id], portrait: id },
    storyboard: [{ script: "这款保温杯一整天都热乎。", visual: "人物手持保温杯", action: "拧开杯盖", camera: "中景推近" }] });
  expect(marketingImageReferences(draft).map(image => image.role)).toEqual(["portrait", "product", "product", "scene"]);
  const prompt = marketingSegmentPrompt(draft, { index: 0, script: draft.storyboard[0].script, durationSec: 8 }, 2);
  expect(prompt).toContain("Use <IMAGE_0> for the presenter's identity only.");
  expect(prompt).toContain("Use <IMAGE_1>, <IMAGE_2> for the product's exact appearance.");
  expect(prompt).toContain("Use <IMAGE_3> for relevant scene composition, objects and details.");
  expect(prompt).toContain("never redesign it or substitute a generic or different product");
  expect(prompt).toContain("Supplied setting references take precedence");
  // Product alone is not a setting reference: the text background still applies.
  const productOnly = marketingSegmentPrompt(MarketingDraftSchema.parse({ assets: { product: id } }), { index: 0, script: "Hello", durationSec: 8 }, 1);
  expect(productOnly).toContain("backgroundDescription is the default setting");
  expect(productOnly).not.toContain("Background/scene images guide");
  expect(marketingPlanningContext(draft).materials).toMatchObject({ portrait: 1, product: 2, scene: 1 });
  expect(MARKETING_STORYBOARD_RULES).toContain("never introduce a different or competing product");
});

it("uses reference video for silent visuals without requesting voice synthesis", () => {
  const draft = MarketingDraftSchema.parse({ assets: { video: id, voice: id } });
  const prompt = marketingSegmentPrompt(draft, { index: 0, script: "Hello", durationSec: 5 }, 1);
  expect(prompt).toContain("Use video 1 as a reference");
  expect(prompt).toContain("Do not generate speech or audio");
  expect(prompt).toContain("Silent demonstration, no lip-sync");
  expect(prompt).toContain("captions are added after generation");
  expect(marketingSegmentPrompt(draft, { index: 0, script: "Hello", durationSec: 5 }, 1, undefined, undefined, false)).toContain("no speech synchronization is needed");
  expect(prompt).not.toContain("Use audio 1");
  expect(prompt).not.toContain("Use the supplied custom voice");
  expect(prompt).not.toContain("Narrate ONLY");
  expect(shotData(prompt)).not.toHaveProperty("voiceStyle");
});

it.each([
  { assets: { scene: id, cover: id, music: id }, roles: ["scene"] },
  { assets: { background: [id, id], portrait: id, voice: id }, roles: ["portrait", "background", "background"] },
  { assets: { portrait: id, scene: id, video: id }, roles: ["portrait", "scene"] },
  { assets: { cover: id, music: id, voice: id }, roles: [] },
])("numbers only submitted images and accepts legacy slots: $roles", ({ assets, roles }) => {
  const draft = MarketingDraftSchema.parse({ assets });
  expect(marketingImageReferences(draft)).toEqual(roles.map((role, index) => ({ role, imageNumber: index + 1, assetId: id })));
  const prompt = marketingSegmentPrompt(draft, { index: 0, script: "欢迎光临。", durationSec: 8 }, 2);
  expect([...prompt.matchAll(/<IMAGE_(\d+)>/g)].map(match => Number(match[1]))).toEqual(roles.map((_, index) => index));
});

it("honors persisted audio mode independently of the presence of a video reference", () => {
  const withVideo = MarketingDraftSchema.parse({ assets: { video: id, voice: id } });
  const legacy = marketingSegmentPrompt(withVideo, { index: 0, script: "Hello", durationSec: 8 }, 2, true);
  expect(legacy).toContain("Narrate ONLY");
  expect(legacy).toContain("Use video 1");
  expect(legacy).toContain("Use the supplied custom voice");
  const silent = marketingSegmentPrompt(MarketingDraftSchema.parse({ subtitles: false }), { index: 0, script: "Hello", durationSec: 8 }, 2, false);
  expect(silent).not.toContain("Use video 1");
  expect(silent).not.toContain("Narrate ONLY");
  expect(silent).toContain("Do not add on-screen text or subtitles.");
  expect(silent).toContain("communicate the message through visible actions");
});

it("keeps confirmed content in its fields and applies later material/ratio selections", () => {
  const script = '你好。\n"不要改我的台词。"';
  const draft = MarketingDraftSchema.parse({ ratio: "16:9", background: "简约演播室", publishTitle: "不要播报的标题", tags: "#不要播报的标签",
    assets: { portrait: id, scene: id, music: id, cover: id },
    storyboard: [{ script, visual: "窗边陈列台", action: "人物展示杯子", camera: "缓慢平移" }] });
  const prompt = marketingSegmentPrompt(draft, { index: 0, script, durationSec: 15 }, 1);
  expect(shotData(prompt)).toEqual({ script, visual: "窗边陈列台", action: "人物展示杯子", camera: "缓慢平移", backgroundDescription: draft.background, voiceStyle: draft.voice });
  expect(prompt).toContain("aspect ratio 16:9");
  expect(prompt).toContain("change location only if visual names another place");
  expect(prompt).toContain("Supplied setting references take precedence");
  expect(prompt).not.toContain("same presenter, outfit and environment throughout");
  expect(prompt).not.toContain(draft.publishTitle);
  expect(prompt).not.toContain(draft.tags);
});

it("keeps ordinary six-image prompts compact and rejects oversize directions without truncating copy", () => {
  const draft = MarketingDraftSchema.parse({ assets: { portrait: [id, id, id], background: id, scene: [id, id], voice: id },
    storyboard: [{ script: "欢迎来喝咖啡。", visual: "人物在窗边展示咖啡", action: "端起杯子", camera: "中景推近" }] });
  const segment = { index: 0, script: draft.storyboard[0].script, durationSec: 15 };
  expect(marketingSegmentPrompt(draft, segment, 2).length).toBeLessThanOrEqual(2500);
  // Every image role at Grok's 14-image maximum, and Kling's 7, stays compact too.
  const all = MarketingDraftSchema.parse({ ...draft, assets: { portrait: [id, id, id, id], product: [id, id, id, id, id], background: [id, id], scene: [id, id, id], voice: id } });
  expect(marketingSegmentPrompt(all, segment, 2).length).toBeLessThanOrEqual(2500);
  const kling = MarketingDraftSchema.parse({ ...draft, assets: { portrait: [id, id, id], product: [id, id], background: id, scene: id, voice: id } });
  expect(marketingSegmentPrompt(kling, segment, 2, true, KLING_MARKETING_PROFILE).length).toBeLessThanOrEqual(2500);
  expect(activeMarketingVideoProfile().promptMaxChars).toBe(3072);
  const long = MarketingDraftSchema.parse({ ...draft, background: "背景".repeat(300), voice: "声音".repeat(50),
    storyboard: [{ ...draft.storyboard[0], visual: "画面".repeat(300), action: "动作".repeat(200), camera: "镜头".repeat(200) }] });
  expect(() => marketingSegmentPrompt(long, segment, 2)).toThrow("生成提示词过长");
  expect(long.storyboard[0].script).toBe(segment.script);
});

describe("copy and storyboard source boundaries", () => {
  it("omits stale rewrite sources and copy when generating a new topic", () => {
    const draft = MarketingDraftSchema.parse({ topic: "新款咖啡杯", reference: "旧店铺限时五折", script: "过期文案", assets: { portrait: id, background: [id, id], music: id, cover: id }, ratio: "1:1", subtitles: false });
    const prompt = creationPrompt(draft, "zh", { summary: "过期摘要" });
    const input = JSON.parse(prompt.input);
    expect(input).toMatchObject({ topic: draft.topic, copyMode: "generate", ratio: "1:1", subtitles: false, generateAudio: true,
      materials: { portrait: 1, background: 2, scene: 0, video: false, voice: false, music: true } });
    expect(input).not.toHaveProperty("reference");
    expect(input).not.toHaveProperty("evidence");
    expect(input).not.toHaveProperty("script");
    expect(prompt.input).not.toContain(id);
    expect(prompt.system).toContain("NOT provided to this text-planning call");
  });

  it("distinguishes a style-only rewrite brief from replacing the product", () => {
    const draft = MarketingDraftSchema.parse({ copyMode: "rewrite", topic: "语气轻松一些", reference: "这家店提供手冲咖啡。" });
    const prompt = creationPrompt(draft, "zh");
    expect(JSON.parse(prompt.input)).toMatchObject({ topic: draft.topic, reference: draft.reference });
    expect(prompt.system).toContain("only changes style, audience or pacing");
    expect(prompt.system).toContain("explicitly identifies a different product/business");
    expect(prompt.system).not.toContain("No usable audio transcript is supplied");
  });

  it.each([false, true])("keeps analyzed source evidence separate from generation video (speech=%s)", speechAvailable => {
    const draft = MarketingDraftSchema.parse({ copyMode: "rewrite", reference: "https://example.com/source-video", referenceUpload: { id, name: "source.mp4" } });
    const evidence = { observations: [{ description: "窗边喝咖啡" }], ...(speechAvailable ? { speech: { status: "completed", text: "欢迎品尝" } } : {}) };
    const prompt = creationPrompt(draft, "zh", evidence, speechAvailable);
    const input = JSON.parse(prompt.input);
    expect(input.evidence).toEqual(evidence);
    expect(input).not.toHaveProperty("reference");
    expect(input.materials.video).toBe(false);
    expect(input.generateAudio).toBe(true);
    expect(prompt.input).not.toContain("source.mp4");
    expect(prompt.system).toContain(speechAvailable ? "fallible ASR source narration" : "Do not infer that the original video is silent");
    expect(prompt.system).toContain("inference=true");
  });

  it("passes current assets and approved copy to a single-shot revision without old references", () => {
    const draft = MarketingDraftSchema.parse({ reference: "过期来源", ratio: "16:9", subtitles: false, assets: { video: id, portrait: id, voice: id }, storyboard: [
      { durationSec: 7, script: "First approved line.", visual: "正面人物", action: "拿杯子", camera: "中景" },
      { durationSec: 10, script: "Second approved line.", visual: "窗边人物", action: "展示杯子", camera: "中景" },
    ] });
    const prompt = storyboardPrompt(draft, "zh", draft.storyboard, "改为缓慢推近，口播不变", 1);
    expect(JSON.parse(prompt.input)).toMatchObject({ shots: draft.storyboard, selectedIndex: 1, revisionRequest: "改为缓慢推近，口播不变", ratio: "16:9", subtitles: false, generateAudio: false, materials: { video: true, portrait: 1, voice: true } });
    expect(prompt.input).not.toContain("过期来源");
    expect(prompt.input).not.toContain(id);
    expect(prompt.system).toContain("index 1 (shot 2), lasting exactly 10 seconds");
    expect(prompt.system).toContain("do not authorize rewriting or translating narration");
    expect(prompt.system).not.toContain("The target duration is");
  });

  it("passes only final narration to publication copy generation", () => {
    const prompt = publicationPrompt("原样保留的咖啡介绍。", "zh");
    expect(JSON.parse(prompt.input)).toEqual({ script: "原样保留的咖啡介绍。" });
    expect(prompt.system).toContain("publication metadata, not narration");
    expect(prompt.system).toContain("one string of space-separated hashtags");
  });
});
