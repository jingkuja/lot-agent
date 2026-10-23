/** Line width of TypeScript and JavaScript code under packages/. The contents of string and
 * template literals are not counted, so long interface copy and prompts can stay on one line.
 *
 *   node packages/server/scripts/check-line-width.mjs                lines changed since HEAD, untracked files included
 *   node packages/server/scripts/check-line-width.mjs --base main    lines changed since main
 *   node packages/server/scripts/check-line-width.mjs --all <path>…  every line of the given files or folders
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_CODE_WIDTH = 160;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const ts = createRequire(join(root, "package.json"))("typescript");
const SOURCE = /\.(?:ts|tsx|mts|mjs)$/;
const LITERALS = new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.JsxText]);

/** Code width of every line of a file: characters outside string and template literal contents. */
export function lineWidths(text, fileName) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : fileName.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const content = new Uint8Array(text.length);
  (function visit(node) {
    // Delimiters (quotes, backticks, `${`, `}`) still count; the text between them does not.
    if (LITERALS.has(node.kind)) content.fill(1, node.getStart(file) + 1, Math.max(node.getStart(file) + 1, node.getEnd() - 1));
    ts.forEachChild(node, visit);
  })(file);
  const widths = [];
  let start = 0;
  for (const line of text.split("\n")) {
    let width = 0;
    const end = start + line.trimEnd().length;
    for (let i = start; i < end; i++) if (!content[i]) width++;
    widths.push(width);
    start += line.length + 1;
  }
  return widths;
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Added or changed lines per file since `base`, with untracked files counted whole. */
function changedLines(base) {
  const lines = new Map();
  let file;
  for (const row of git("diff", "-U0", "--no-color", "--no-ext-diff", base, "--", "packages").split("\n")) {
    if (row.startsWith("+++ ")) { file = row.startsWith("+++ b/") ? row.slice(6) : undefined; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (hunk && file && SOURCE.test(file)) {
      const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const numbers = lines.get(file) ?? new Set();
      for (let n = start; n < start + count; n++) numbers.add(n);
      lines.set(file, numbers);
    }
  }
  for (const file of git("ls-files", "--others", "--exclude-standard", "--", "packages").split("\n")) {
    if (SOURCE.test(file)) lines.set(file, "all");
  }
  return lines;
}

function filesUnder(path) {
  const full = join(root, path);
  if (!statSync(full).isDirectory()) return SOURCE.test(path) ? [path] : [];
  return readdirSync(full).flatMap(name => name === "node_modules" || name === "dist" ? [] : filesUnder(join(path, name)));
}

const args = process.argv.slice(2);
const all = args[0] === "--all";
const base = args[0] === "--base" ? args[1] : "HEAD";
const named = () => args.slice(1).flatMap(path => filesUnder(relative(root, resolve(process.cwd(), path))));
const targets = all ? new Map(named().map(file => [file, "all"])) : changedLines(base);
const failures = [];
for (const [file, numbers] of targets) {
  let text;
  try { text = readFileSync(join(root, file), "utf8"); } catch { continue; }
  lineWidths(text, file).forEach((width, index) => {
    if ((numbers === "all" || numbers.has(index + 1)) && width > MAX_CODE_WIDTH) failures.push(`${file}:${index + 1}: ${width} code characters`);
  });
}
if (failures.length) {
  console.error(`Lines over ${MAX_CODE_WIDTH} code characters (string contents not counted):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`Line width OK: ${targets.size} file(s) checked, at most ${MAX_CODE_WIDTH} code characters per line.`);
