import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { translate } from "./locale.js";
import { messages } from "./messages.js";

// Server and core code of the marketing studio returns formatted Chinese messages, and the studio
// shows them through t(): the Chinese text is the catalog key, and a formatted message matches
// its {0}, {1}… template. Every such message therefore needs a catalog entry.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const folders = ["packages/core/src/marketing-video", "packages/server/src/marketing-video", "packages/web/src/modules/marketing-video"];
// Review instructions for the model and the transcribed rule table: data, never shown as interface text.
const dataFiles = new Set(["compliance.ts", "compliance-rules.ts"]);
const notShown = new Set([
  "口播文案：\n{0}\n\n发布标题：{1}\n话题：{2}\n制作草稿：{3}", // description stored with an archived video
  "营销视频、文案与发布信息", // description of the archive collection
  "字幕 Subtitle 99", // caption burned into the FFmpeg probe clip
  "MARKETING_VIDEO_MODEL={0} 不受支持，可选：{1}", // server start-up error for operators
  "片段完成 ", // stage prefix the task panel matches
]);

/** Chinese string and template literals of a file; `${…}` becomes {0}, {1}… in order. */
function chineseMessages(path: string) {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      found.push(node.head.text + node.templateSpans.map((span, index) => `{${index}}${span.literal.text}`).join(""));
      node.templateSpans.forEach(span => visit(span.expression));
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found.filter(text => /[一-鿿]/.test(text));
}

describe("marketing studio messages", () => {
  it("has a catalog entry for every message the server, core and studio code can show", () => {
    const missing: string[] = [];
    for (const folder of folders) {
      for (const name of readdirSync(join(root, folder))) {
        if (!/\.tsx?$/.test(name) || name.includes(".test.") || dataFiles.has(name)) continue;
        for (const text of chineseMessages(join(root, folder, name))) {
          if (!Object.hasOwn(messages, text) && !notShown.has(text)) missing.push(`${folder}/${name}: ${text}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("translates formatted messages through their own template, without Chinese left over", () => {
    const wrong: string[] = [];
    for (const folder of folders) {
      for (const name of readdirSync(join(root, folder))) {
        if (!/\.tsx?$/.test(name) || name.includes(".test.") || dataFiles.has(name)) continue;
        for (const key of chineseMessages(join(root, folder, name))) {
          if (!/\{\d+\}/.test(key) || notShown.has(key)) continue;
          // As the server sends it: placeholders already filled with plain numbers.
          const formatted = key.replace(/\{(\d+)\}/g, (_, index: string) => String(Number(index) + 7));
          for (const locale of ["en", "id"] as const) {
            const expected = messages[key][locale].replace(/\{(\d+)\}/g, (_, index: string) => String(Number(index) + 7));
            const actual = translate(formatted, locale);
            if (actual !== expected) wrong.push(`${locale}: ${formatted} → ${actual}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(translate("声音样例时长需为 2–15 秒", "en")).toBe("Voice samples must be 2–15 seconds long.");
    expect(translate("声音样例时长需为 2–15 秒", "id")).toBe("Durasi sampel suara harus 2–15 detik.");
  });
});
