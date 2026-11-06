import JSZip from "jszip";
import * as XLSX from "xlsx";

export const EXCEL_MIMES: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** 把 Excel 工作簿转成纯文本：每个工作表渲染为 CSV，便于模型阅读。 */
export function excelToText(bytes: Buffer): string {
  const wb = XLSX.read(bytes, { type: "buffer" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    parts.push(`### Worksheet: ${name}\n${csv}`);
  }
  return parts.join("\n\n");
}

/** 抽出 pptx 各页的可读文本（旧 PPT 作为内容素材时用）。 */
export async function pptxToText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
  const pages: string[] = [];
  for (const n of names) {
    const xml = await zip.file(n)!.async("string");
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
      .map((m) => m[1])
      .filter(Boolean);
    const num = n.match(/(\d+)/)![1];
    if (texts.length) pages.push(`### Slide ${num}\n${texts.join("\n")}`);
  }
  return pages.join("\n\n");
}
