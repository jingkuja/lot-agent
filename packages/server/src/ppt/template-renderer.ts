import JSZip from "jszip";
import type { PptOutline, PptSlide } from "./renderer.js";

/**
 * 模版克隆渲染：不再"提取几个颜色重画"，而是直接在用户上传的 .pptx 包上工作——
 * 删掉模版原有幻灯片，插入引用模版自身 slideLayout 的新幻灯片。背景图、母版样式、
 * 占位符位置/字体全部由布局继承，模版观感原样保留。任何结构不符合预期都抛错，
 * 由调用方降级到主题提取路径。
 */

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const SLIDE_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const LAYOUT_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const SLIDE_CT =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface Placeholder {
  type?: string;
  idx?: string;
}

interface LayoutInfo {
  /** e.g. "slideLayout2.xml" */
  file: string;
  /** p:sldLayout 的 type 属性（title/secHead/obj/…），可能缺省 */
  kind?: string;
  placeholders: Placeholder[];
}

function parsePlaceholders(xml: string): Placeholder[] {
  const out: Placeholder[] = [];
  for (const m of xml.matchAll(/<p:ph\b([^/>]*)\/?>/g)) {
    const attrs = m[1];
    out.push({
      type: /\btype="([^"]+)"/.exec(attrs)?.[1],
      idx: /\bidx="([^"]+)"/.exec(attrs)?.[1],
    });
  }
  return out;
}

const TITLE_TYPES = new Set(["title", "ctrTitle"]);
/** dt/ftr/sldNum/pic 等不是正文位；无 type（默认 obj/body 语义）或 body/subTitle 才是。 */
function isBodyPh(ph: Placeholder): boolean {
  return ph.type === undefined || ph.type === "body" || ph.type === "subTitle";
}

function titlePh(l: LayoutInfo): Placeholder | undefined {
  return l.placeholders.find((p) => p.type && TITLE_TYPES.has(p.type));
}
function bodyPh(l: LayoutInfo): Placeholder | undefined {
  return l.placeholders.find(isBodyPh);
}

/** 按 cover/section/content 选布局；模版千奇百怪，逐级回退。 */
function pickLayouts(layouts: LayoutInfo[]): Record<PptSlide["layout"], LayoutInfo> {
  if (!layouts.length) throw new Error("template has no slide layouts");
  const byKind = (...kinds: string[]) =>
    layouts.find((l) => l.kind && kinds.some((k) => l.kind!.toLowerCase() === k.toLowerCase()));
  const cover =
    byKind("title") ??
    layouts.find((l) => l.placeholders.some((p) => p.type === "ctrTitle")) ??
    layouts[0];
  const section = byKind("secHead", "sectionHead", "titleOnly") ?? cover;
  const content =
    byKind("obj", "tx", "blank", "twoColTx", "txt") ??
    layouts.find((l) => l !== cover && titlePh(l) && bodyPh(l)) ??
    layouts.find((l) => titlePh(l) && bodyPh(l)) ??
    cover;
  return { cover, section, content };
}

function phAttr(ph: Placeholder | undefined, fallbackType: string): string {
  if (!ph) return `type="${fallbackType}"`;
  const type = ph.type ? ` type="${ph.type}"` : "";
  const idx = ph.idx ? ` idx="${ph.idx}"` : "";
  return (type + idx).trim() || `type="${fallbackType}"`;
}

/**
 * 插入文本的显式字号（百分点，1pt=100）。母版默认标题常达 44pt、正文 28pt，
 * 空 spPr 会让文本回落到那个巨大默认值。这里按版式给出合理字号，只设 sz——
 * 不碰字体与颜色，模版自己的字体族/配色仍从占位符继承。
 */
function titleSz(layout: PptSlide["layout"]): number {
  return layout === "cover" ? 3200 : layout === "section" ? 3000 : 2600;
}
const BODY_SZ = 1800;

function slideXml(s: PptSlide, layout: LayoutInfo): string {
  const shapes: string[] = [];
  const tsz = titleSz(s.layout);
  shapes.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
      `<p:nvPr><p:ph ${phAttr(titlePh(layout), "title")}/></p:nvPr></p:nvSpPr><p:spPr/>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="${tsz}"/><a:t>${esc(s.title)}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
  if (s.bullets?.length) {
    const body = bodyPh(layout);
    if (body) {
      const paras = s.bullets
        .map(
          (b) =>
            `<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="zh-CN" sz="${BODY_SZ}"/><a:t>${esc(b)}</a:t></a:r></a:p>`
        )
        .join("");
      shapes.push(
        `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
          `<p:nvPr><p:ph ${phAttr(body, "body")}/></p:nvPr></p:nvSpPr><p:spPr/>` +
          `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`
      );
    }
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shapes.join("") +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

function slideRelsXml(layoutFile: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="${REL_NS}">` +
    `<Relationship Id="rId1" Type="${LAYOUT_REL}" Target="../slideLayouts/${layoutFile}"/>` +
    `</Relationships>`
  );
}

/** 在 zip 中按路径前缀查找文件，路径比较大小写不敏感。 */
function findFile(zip: JSZip, prefix: string): string | null {
  const lower = prefix.toLowerCase();
  for (const p of Object.keys(zip.files)) {
    if (p.toLowerCase().startsWith(lower) && !zip.files[p].dir) return p;
  }
  return null;
}

/** 读取文件，路径大小写不敏感；找不到则抛错。 */
async function mustRead(zip: JSZip, path: string): Promise<string> {
  // 先精确匹配
  let f = zip.file(path);
  if (!f) {
    // 大小写不敏感搜索
    const real = findFile(zip, path);
    if (real) f = zip.file(real);
  }
  if (!f) throw new Error(`template missing ${path}`);
  return f.async("string");
}

/** 读取文件，路径大小写不敏感；找不到返回 null。 */
async function tryRead(zip: JSZip, path: string): Promise<string | null> {
  try {
    return await mustRead(zip, path);
  } catch {
    return null;
  }
}

/** 读布局清单（数字序，保证 slideLayout2 排在 slideLayout10 前面）。 */
async function readLayouts(zip: JSZip): Promise<LayoutInfo[]> {
  const layoutFiles = Object.keys(zip.files)
    .filter((p) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(p)) // 大小写不敏感
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)/i)![1]);
      const nb = Number(b.match(/(\d+)/i)![1]);
      return na - nb;
    });
  const layouts: LayoutInfo[] = [];
  for (const path of layoutFiles) {
    const xml = await mustRead(zip, path);
    layouts.push({
      file: path.slice(path.lastIndexOf("/") + 1),
      kind: /<p:sldLayout\b[^>]*\btype="([^"]+)"/.exec(xml)?.[1],
      placeholders: parsePlaceholders(xml),
    });
  }
  return layouts;
}

/** 中性浅色主题槽位——用作背景等同于"白板"，不算设计。 */
const NEUTRAL_SCHEME = new Set([
  "bg1", "bg2", "lt1", "lt2", "light1", "light2", "background1", "background2",
]);

/** hex 是否接近纯白（相对亮度 > 0.9）——近白背景等同白板。 */
function isNearWhiteHex(hex: string): boolean {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.9;
}

/**
 * 判断一段 slideMaster/slideLayout XML 是否携带"可复用的视觉设计"——
 * 背景图/图片填充/渐变、视觉上非白的实色背景（深色或彩色），或版面里的装饰图片。
 * 纯白/近白/浅灰中性背景 + 只有占位符的空白版式返回 false（克隆它们只会得到白板）。
 */
function partIsDesigned(xml: string): boolean {
  const bg = /<p:bg\b[\s\S]*?<\/p:bg>/i.exec(xml)?.[0] ?? "";
  // 背景图片 / 图片填充 / 渐变
  if (/<a:blip\b|<a:blipFill\b|<a:gradFill\b/i.test(bg)) return true;
  // 显式 hex 实色背景，但排除近白
  const srgb = /<a:solidFill>\s*<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/i.exec(bg)?.[1];
  if (srgb && !isNearWhiteHex(srgb)) return true;
  // 主题色实色背景，但排除中性浅色槽位（bg*/lt*）——只有深色/彩色才算设计
  const sc = /<a:solidFill>\s*<a:schemeClr\s+val="([^"]+)"/i
    .exec(bg)?.[1]
    ?.toLowerCase();
  if (sc && !NEUTRAL_SCHEME.has(sc)) return true;
  // 版面里嵌了装饰图片
  if (/<p:pic\b/i.test(xml)) return true;
  return false;
}

/**
 * 模版的设计是放在可复用的母版/版式里（值得"克隆"套版），还是逐页画在幻灯片上
 * （克隆只会得到空白骨架 → 白板 + 母版默认巨大字号）？
 *
 * 只检查会被实际用到的部件：所有母版，加上将被选中的封面/正文版式——
 * 只有这些带背景/装饰，克隆才有意义。判为"空白版式型"时调用方应改走
 * 主题提取 + 内置精美渲染器。**坏 zip 会抛错**，供调用方区分"解析失败"。
 */
export async function templateHasReusableDesign(bytes: Buffer): Promise<boolean> {
  const zip = await JSZip.loadAsync(bytes); // 坏 zip 在此抛出，交由调用方处理
  // 母版：背景通常在此，作用于所有幻灯片
  const masterPaths = Object.keys(zip.files).filter((p) =>
    /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(p)
  );
  for (const p of masterPaths) {
    if (partIsDesigned(await mustRead(zip, p))) return true;
  }
  // 只有封面/正文版式带设计才值得克隆（节页色块救不了白板正文）
  const layouts = await readLayouts(zip);
  if (!layouts.length) return false;
  const picked = pickLayouts(layouts);
  for (const l of new Set([picked.cover, picked.content])) {
    if (partIsDesigned(await mustRead(zip, `ppt/slideLayouts/${l.file}`))) {
      return true;
    }
  }
  return false;
}

export async function renderPptxFromTemplate(
  outline: PptOutline,
  templateBytes: Buffer
): Promise<Buffer> {
  if (!outline.slides.length) throw new Error("outline has no slides");
  const zip = await JSZip.loadAsync(templateBytes);

  let presentation = await mustRead(zip, "ppt/presentation.xml");
  // presRels 某些老模版可能没有；缺了就构造一份空的
  let presRels = await tryRead(zip, "ppt/_rels/presentation.xml.rels");
  if (!presRels) {
    presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}"></Relationships>`;
  }
  let contentTypes = await tryRead(zip, "[Content_Types].xml");
  if (!contentTypes) {
    contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;
  }

  // 1. 读布局清单（数字序，保证 slideLayout2 排在 slideLayout10 前面）
  const layouts = await readLayouts(zip);
  const picked = pickLayouts(layouts);

  // 2. 摘掉模版自带的幻灯片（部件、rels、Content_Types、presentation 引用）
  for (const path of Object.keys(zip.files)) {
    if (
      path.toLowerCase().startsWith("ppt/slides/") ||
      path.toLowerCase().startsWith("ppt/notesslides/")
    ) {
      zip.remove(path);
    }
  }
  contentTypes = contentTypes.replace(
    /<Override PartName="\/ppt\/(?:slides|notesSlides)\/[^"]+"[^>]*>/gi,
    ""
  );
  presRels = presRels.replace(
    new RegExp(`<Relationship [^>]*Type="${SLIDE_REL}"[^>]*/>`, "gi"),
    ""
  );

  // 3. 插入新幻灯片
  const sldIds: string[] = [];
  const newRels: string[] = [];
  const newOverrides: string[] = [];
  outline.slides.forEach((s, i) => {
    const n = i + 1;
    const layout = picked[s.layout] ?? picked.content;
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(s, layout));
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, slideRelsXml(layout.file));
    newOverrides.push(
      `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${SLIDE_CT}"/>`
    );
    const rid = `rIdGenSlide${n}`;
    newRels.push(`<Relationship Id="${rid}" Type="${SLIDE_REL}" Target="slides/slide${n}.xml"/>`);
    sldIds.push(`<p:sldId id="${256 + i}" r:id="${rid}"/>`);
  });

  contentTypes = contentTypes.replace("</Types>", newOverrides.join("") + "</Types>");
  presRels = presRels.replace("</Relationships>", newRels.join("") + "</Relationships>");

  const sldIdLst = `<p:sldIdLst>${sldIds.join("")}</p:sldIdLst>`;
  if (/<p:sldIdLst[\s\S]*?<\/p:sldIdLst>/i.test(presentation)) {
    presentation = presentation.replace(/<p:sldIdLst[\s\S]*?<\/p:sldIdLst>/i, sldIdLst);
  } else if (/<p:sldIdLst\s*\/>/i.test(presentation)) {
    presentation = presentation.replace(/<p:sldIdLst\s*\/>/i, sldIdLst);
  } else {
    presentation = presentation.replace(/<\/p:sldMasterIdLst>/i, `</p:sldMasterIdLst>${sldIdLst}`);
  }
  if (!presentation.includes(sldIdLst)) {
    throw new Error("could not place sldIdLst in presentation.xml");
  }

  zip.file("[Content_Types].xml", contentTypes);
  zip.file("ppt/_rels/presentation.xml.rels", presRels);
  zip.file("ppt/presentation.xml", presentation);

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
}
