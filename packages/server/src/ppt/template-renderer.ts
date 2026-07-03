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
  const byKind = (...kinds: string[]) => layouts.find((l) => l.kind && kinds.includes(l.kind));
  const cover =
    byKind("title") ??
    layouts.find((l) => l.placeholders.some((p) => p.type === "ctrTitle")) ??
    layouts[0];
  const section = byKind("secHead", "titleOnly") ?? cover;
  const content =
    byKind("obj", "tx") ??
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

function slideXml(s: PptSlide, layout: LayoutInfo): string {
  const shapes: string[] = [];
  shapes.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
      `<p:nvPr><p:ph ${phAttr(titlePh(layout), "title")}/></p:nvPr></p:nvSpPr><p:spPr/>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${esc(s.title)}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
  if (s.bullets?.length) {
    const body = bodyPh(layout);
    if (body) {
      const paras = s.bullets
        .map((b) => `<a:p><a:pPr lvl="0"/><a:r><a:t>${esc(b)}</a:t></a:r></a:p>`)
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

async function mustRead(zip: JSZip, path: string): Promise<string> {
  const f = zip.file(path);
  if (!f) throw new Error(`template missing ${path}`);
  return f.async("string");
}

export async function renderPptxFromTemplate(
  outline: PptOutline,
  templateBytes: Buffer
): Promise<Buffer> {
  if (!outline.slides.length) throw new Error("outline has no slides");
  const zip = await JSZip.loadAsync(templateBytes);

  let presentation = await mustRead(zip, "ppt/presentation.xml");
  let presRels = await mustRead(zip, "ppt/_rels/presentation.xml.rels");
  let contentTypes = await mustRead(zip, "[Content_Types].xml");

  // 1. 读布局清单（数字序，保证 slideLayout2 排在 slideLayout10 前面）
  const layoutFiles = Object.keys(zip.files)
    .filter((p) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
  const layouts: LayoutInfo[] = [];
  for (const path of layoutFiles) {
    const xml = await mustRead(zip, path);
    layouts.push({
      file: path.slice("ppt/slideLayouts/".length),
      kind: /<p:sldLayout\b[^>]*\btype="([^"]+)"/.exec(xml)?.[1],
      placeholders: parsePlaceholders(xml),
    });
  }
  const picked = pickLayouts(layouts);

  // 2. 摘掉模版自带的幻灯片（部件、rels、Content_Types、presentation 引用）
  for (const path of Object.keys(zip.files)) {
    if (path.startsWith("ppt/slides/") || path.startsWith("ppt/notesSlides/")) {
      zip.remove(path);
    }
  }
  contentTypes = contentTypes.replace(
    /<Override PartName="\/ppt\/(?:slides|notesSlides)\/[^"]+"[^>]*>/g,
    ""
  );
  presRels = presRels.replace(
    new RegExp(`<Relationship [^>]*Type="${SLIDE_REL}"[^>]*/>`, "g"),
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
  if (/<p:sldIdLst[\s\S]*?<\/p:sldIdLst>/.test(presentation)) {
    presentation = presentation.replace(/<p:sldIdLst[\s\S]*?<\/p:sldIdLst>/, sldIdLst);
  } else if (/<p:sldIdLst\s*\/>/.test(presentation)) {
    presentation = presentation.replace(/<p:sldIdLst\s*\/>/, sldIdLst);
  } else {
    presentation = presentation.replace(/<\/p:sldMasterIdLst>/, `</p:sldMasterIdLst>${sldIdLst}`);
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
