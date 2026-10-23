import { afterEach, beforeEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error repository script is JavaScript
import { MAX_CODE_WIDTH, SOURCE, lineWidths } from "./check-line-width.mjs";

const script = fileURLToPath(new URL("./check-line-width.mjs", import.meta.url));
const longStatement = `export const total = ${Array.from({ length: 60 }, (_, i) => `value${i}`).join(" + ")};\n`;
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "line-width-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function check(...files: string[]) {
  return spawnSync(process.execPath, [script, "--all", ...files], { encoding: "utf8" });
}

it("checks every TypeScript and JavaScript extension", async () => {
  expect(longStatement.length).toBeGreaterThan(MAX_CODE_WIDTH);
  for (const extension of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
    const file = path.join(root, `fixture.${extension}`);
    await writeFile(file, longStatement);
    const result = check(file);
    expect(result.status, `${extension}: ${result.stdout}`).toBe(1);
    expect(result.stderr).toContain(`fixture.${extension}:1:`);
  }
  expect(SOURCE.test("styles.css")).toBe(false);
  expect(SOURCE.test("data.json")).toBe(false);
});

it("passes short lines and does not count string contents", async () => {
  const file = path.join(root, "fixture.jsx");
  await writeFile(file, `export const short = 1;\nexport const copy = "${"文".repeat(400)}";\nexport const View = () => <p>${"x".repeat(300)}</p>;\n`);
  const result = check(file);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("1 file(s) checked");
  expect(lineWidths(`const a = \`${"y".repeat(500)}\`;`, "a.cjs")).toEqual([13]);
});
