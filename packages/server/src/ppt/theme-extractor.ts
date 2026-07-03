import JSZip from "jszip";

export type OverlayMode = "dark" | "light" | "none";
export interface SlideBackground { image: Buffer; ext: "png" | "jpeg"; overlay: OverlayMode }

/** PPT 模版里提取出的可复用样式（颜色为 6 位 hex、无 # 前缀）。 */
export interface PptTheme {
  colors: {
    dk1: string; lt1: string; dk2: string; lt2: string;
    accent1: string; accent2: string; accent3: string;
    accent4: string; accent5: string; accent6: string;
  };
  fonts: { major: string; minor: string };
  /** 幻灯片尺寸（英寸） */
  slideWidthIn: number;
  slideHeightIn: number;
  /** 装饰语言：几何圆 / 斜切色块 / 细网格 / 无装饰。 */
  decor: "circles" | "slant" | "grid" | "minimal";
  /** 整页背景图（按版式角色配置），可选。 */
  backgrounds?: {
    cover?: SlideBackground;
    section?: SlideBackground;
    body?: SlideBackground;
  };
}

export const DEFAULT_THEME: PptTheme = {
  colors: {
    dk1: "1E1E2E", lt1: "FFFFFF", lt2: "F0F0F5", dk2: "4A4A6A",
    accent1: "5B6FE3", accent2: "F06595", accent3: "20C997",
    accent4: "FFB347", accent5: "7C5CFC", accent6: "48B0F7",
  },
  fonts: { major: "Microsoft YaHei", minor: "Microsoft YaHei" },
  slideWidthIn: 13.333,
  slideHeightIn: 7.5,
  decor: "circles",
};

const EMU_PER_INCH = 914400;

/** 从 XML 片段中提取 <a:NAME><a:srgbClr val="…"> 或 <a:NAME><a:sysClr … lastClr="…"> 的 hex 值。 */
function colorOf(xml: string, name: string): string | null {
  const m = xml.match(
    new RegExp(`<a:${name}>.*?(?:val|lastClr)="([0-9A-Fa-f]{6})"`, "s")
  );
  return m ? m[1].toUpperCase() : null;
}

function fontOf(xml: string, which: "majorFont" | "minorFont"): string | null {
  const m = xml.match(
    new RegExp(`<a:${which}>\\s*<a:latin typeface="([^"]+)"`, "s")
  );
  return m?.[1] ?? null;
}

/** 在 zip 里找到第一个 ppt/theme/theme*.xml 文件并返回内容。 */
async function findThemeXml(zip: JSZip): Promise<string | null> {
  // 优先 theme1.xml
  const t1 = zip.file("ppt/theme/theme1.xml");
  if (t1) return t1.async("string");
  // 遍历找任意 themeN.xml
  for (const path of Object.keys(zip.files)) {
    if (/^ppt\/theme\/theme\d+\.xml$/.test(path)) {
      return zip.file(path)!.async("string");
    }
  }
  return null;
}

/** 从 slideMaster 或 slideLayout XML 中提取颜色作为最后兜底。 */
async function extractColorsFromSlideXmls(zip: JSZip): Promise<Partial<PptTheme["colors"]>> {
  const out: Record<string, string> = {};
  // 尝试解析任意 slideMaster 或 slideLayout 中的 <a:solidFill><a:srgbClr val="…">
  const candidates = Object.keys(zip.files).filter(
    (p) => /^ppt\/(slideMasters|slideLayouts)\/.*\.xml$/.test(p)
  );
  for (const path of candidates.slice(0, 4)) {
    const xml = await zip.file(path)!.async("string");
    // 收集所有出现的 srgbClr val
    for (const m of xml.matchAll(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/gi)) {
      const color = m[1].toUpperCase();
      if (color !== "000000" && color !== "FFFFFF" && !out["accent1"]) {
        out["accent1"] = color;
        break;
      }
    }
    if (out["accent1"]) break;
  }
  return out;
}

/**
 * 解析上传的 .pptx 模版；任何失败（坏 zip、缺文件、结构异常）降级默认主题。
 * 契约：降级路径返回 DEFAULT_THEME 本体（同一引用），成功路径返回新对象——
 * 调用方（generate_ppt）靠引用相等识别降级并在结果里注明。
 */
export async function extractTheme(bytes: Buffer): Promise<PptTheme> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const themeXml = await findThemeXml(zip);

    const colors = { ...DEFAULT_THEME.colors };
    let extractedAny = false;
    if (themeXml) {
      for (const key of Object.keys(colors) as (keyof PptTheme["colors"])[]) {
        const v = colorOf(themeXml, key);
        if (v) { colors[key] = v; extractedAny = true; }
      }
    } else {
      // 没找到 theme 文件时，尝试从 slide XML 里捡至少一个 accent
      const fallback = await extractColorsFromSlideXmls(zip);
      if (Object.keys(fallback).length > 0) {
        Object.assign(colors, fallback);
        extractedAny = true;
      }
    }

    const fonts = {
      major: (themeXml && fontOf(themeXml, "majorFont")) ?? DEFAULT_THEME.fonts.major,
      minor: (themeXml && fontOf(themeXml, "minorFont")) ?? DEFAULT_THEME.fonts.minor,
    };
    const fontsDiffer =
      fonts.major !== DEFAULT_THEME.fonts.major ||
      fonts.minor !== DEFAULT_THEME.fonts.minor;

    let { slideWidthIn, slideHeightIn } = DEFAULT_THEME;
    let sizeDiffers = false;
    const presXml = await zip.file("ppt/presentation.xml")?.async("string");
    const size = presXml?.match(/<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
    if (size) {
      slideWidthIn = Number(size[1]) / EMU_PER_INCH;
      slideHeightIn = Number(size[2]) / EMU_PER_INCH;
      if (
        slideWidthIn !== DEFAULT_THEME.slideWidthIn ||
        slideHeightIn !== DEFAULT_THEME.slideHeightIn
      ) {
        sizeDiffers = true;
      }
    }

    if (!extractedAny && !fontsDiffer && !sizeDiffers) return DEFAULT_THEME;
    return { colors, fonts, slideWidthIn, slideHeightIn, decor: "circles" };
  } catch {
    return DEFAULT_THEME;
  }
}

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
