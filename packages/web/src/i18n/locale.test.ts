import { describe, expect, it } from "vitest";
import { resolveLocale, translate } from "./locale.js";

describe("interface language", () => {
  it.each([undefined, 0, -1, "1", true, Infinity, NaN])("keeps Chinese when globle is %s, regardless of saved language", (flag) => {
    expect(resolveLocale(flag, "en")).toBe("zh");
  });
  it.each([1, 2, 0.5])("defaults positive flag %s to Indonesian", (flag) => {
    expect(resolveLocale(flag, null)).toBe("id");
    expect(resolveLocale(flag, "invalid")).toBe("id");
  });
  it.each(["zh", "en", "id"] as const)("restores %s only in international mode", (locale) => {
    expect(resolveLocale(1, locale)).toBe(locale);
  });
  it("translates interface text and preserves unknown content", () => {
    expect(translate("取消", "en")).toBe("Cancel");
    expect(translate("取消", "id")).toBe("Batal");
    expect(translate("取消", "zh")).toBe("取消");
    expect(translate("customer-provided content", "id")).toBe("customer-provided content");
  });
  it("interpolates without translating user values", () => {
    expect(translate("移动“{0}”到项目", "en", ["取消"])).toBe('Move “取消” to project');
  });
});

import { messages } from "./messages.js";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

describe("translation catalog", () => {
  it("keeps interpolation values intact in both languages", () => {
    expect(translate("移动“{0}”到项目", "id", ["取消{1}"])).toBe("Pindahkan “取消{1}” ke proyek");
    expect(translate("参考图最多 5 张", "en")).toBe("Up to 5 reference images");
    expect(translate("（已选 3 项）", "id")).toBe(" (3 dipilih)");
    expect(translate("nothing matches {0}", "en")).toBe("nothing matches {0}");
  });
  it("preserves placeholder counts in every translation", () => {
    for (const [source, translations] of Object.entries(messages)) {
      const slots = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();
      for (const locale of ["en", "id"] as const) {
        expect(translations[locale].trim(), source).not.toBe("");
        expect(slots(translations[locale]), `${locale}: ${source}`).toEqual(slots(source));
      }
    }
  });
  it("covers every explicit interface translation key", () => {
    const missing = new Set<string>();
    function walk(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "i18n") walk(path); continue; }
        if (!entry.name.endsWith(".tsx")) continue;
        const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        function visit(node: ts.Node) {
          if (ts.isCallExpression(node) && node.expression.getText(file) === "t" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
            const key = node.arguments[0].text;
            if (/[\u4e00-\u9fff]/.test(key) && !Object.hasOwn(messages, key)) missing.add(key);
          }
          ts.forEachChild(node, visit);
        }
        visit(file);
      }
    }
    walk(dirname(dirname(fileURLToPath(import.meta.url))));
    expect([...missing]).toEqual([]);
  });
});
