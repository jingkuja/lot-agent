import JSZip from "jszip";

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
