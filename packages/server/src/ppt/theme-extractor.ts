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
}

export const DEFAULT_THEME: PptTheme = {
  colors: {
    dk1: "1F2430", lt1: "FFFFFF", dk2: "44546A", lt2: "E7E6E6",
    accent1: "4472C4", accent2: "ED7D31", accent3: "A5A5A5",
    accent4: "FFC000", accent5: "5B9BD5", accent6: "70AD47",
  },
  fonts: { major: "Microsoft YaHei", minor: "Microsoft YaHei" },
  slideWidthIn: 13.333,
  slideHeightIn: 7.5,
};

const EMU_PER_INCH = 914400;

/** <a:accent1><a:srgbClr val="…"/> 或 <a:dk1><a:sysClr … lastClr="…"/> 都取到 hex。 */
function colorOf(xml: string, name: string): string | null {
  const m = xml.match(
    new RegExp(`<a:${name}>.*?(?:lastClr|val)="([0-9A-Fa-f]{6})"`, "s")
  );
  return m ? m[1].toUpperCase() : null;
}

function fontOf(xml: string, which: "majorFont" | "minorFont"): string | null {
  const m = xml.match(
    new RegExp(`<a:${which}>\\s*<a:latin typeface="([^"]+)"`, "s")
  );
  return m?.[1] ?? null;
}

/** 解析上传的 .pptx 模版；任何失败（坏 zip、缺文件、结构异常）降级默认主题。 */
export async function extractTheme(bytes: Buffer): Promise<PptTheme> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const themeXml = await zip.file("ppt/theme/theme1.xml")?.async("string");
    if (!themeXml) return DEFAULT_THEME;
    const presXml = await zip.file("ppt/presentation.xml")?.async("string");

    const colors = { ...DEFAULT_THEME.colors };
    for (const key of Object.keys(colors) as (keyof PptTheme["colors"])[]) {
      const v = colorOf(themeXml, key);
      if (v) colors[key] = v;
    }
    const fonts = {
      major: fontOf(themeXml, "majorFont") ?? DEFAULT_THEME.fonts.major,
      minor: fontOf(themeXml, "minorFont") ?? DEFAULT_THEME.fonts.minor,
    };
    let { slideWidthIn, slideHeightIn } = DEFAULT_THEME;
    const size = presXml?.match(/<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
    if (size) {
      slideWidthIn = Number(size[1]) / EMU_PER_INCH;
      slideHeightIn = Number(size[2]) / EMU_PER_INCH;
    }
    return { colors, fonts, slideWidthIn, slideHeightIn };
  } catch {
    return DEFAULT_THEME;
  }
}
