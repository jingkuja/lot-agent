import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Keeps the digital employee a self-contained agent. The platform names the agent only in
 * listed files, and the module reaches the platform only through listed files.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const server = path.join(root, "packages/server/src");
const web = path.join(root, "packages/web/src");

const AGENT_ID = /digital_employee/;
const MODULE_SOURCE = /(^|\/)digital-employee\//;

/** Final list: registration, entries, ordering and ownership. */
const PLATFORM_FINAL = new Set([
  "server:index.ts",
  "server:workers/index.ts",
  "server:services/agent-service.ts",
  "server:agents/install-order.ts",
  "server:routes/agents.ts",
  "server:knowledge/materials.ts",
  "web:components/BrandHeader.tsx",
  "web:shell/ProductShell.tsx",
]);

/** The module's view of the platform; anything else needs a port. */
const MODULE_IMPORTS = new Set([
  "auth/secret-box.ts",
  "billing/metered-llm.ts",
  "db/database.ts",
  "db/migration-runner.ts",
  "generation/input.ts",
  "models/catalog.ts",
  "services/agent-extensions.ts",
  "services/attachment-extractor.ts",
  "services/response-language-policy.ts",
]);

const IGNORED_FILE = /\.test\.tsx?$|\.d\.ts$/;
const errors = [];
const used = new Set();

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(file);
    return /\.tsx?$/.test(entry.name) && !IGNORED_FILE.test(entry.name) ? [file] : [];
  });
}

function imports(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    const declared = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier;
    if (declared && ts.isStringLiteral(declared)) found.push(declared.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function checkPlatformFile(label, text, specifiers) {
  const names = AGENT_ID.test(text.replace(/^\s*(\/\/|\*).*$/gm, ""));
  const reaches = specifiers.some((specifier) => MODULE_SOURCE.test(specifier));
  if (!names && !reaches) return;
  used.add(label);
  if (PLATFORM_FINAL.has(label)) return;
  errors.push(`${label}: platform code must not name digital_employee or import its module. Add an AgentExtension hook instead`);
}

function checkModuleFile(file, specifiers) {
  for (const specifier of specifiers.filter((value) => value.startsWith("."))) {
    const target = path.relative(server, path.resolve(path.dirname(file), specifier)).replaceAll(path.sep, "/").replace(/\.js$/, ".ts");
    if (target.startsWith("digital-employee/")) continue;
    if (MODULE_IMPORTS.has(target)) {
      used.add(target);
      continue;
    }
    errors.push(`server:${path.relative(server, file)}: imports ${target}, which is not an agreed platform file`);
  }
}

for (const [name, dir] of [["server", server], ["web", web]]) {
  for (const file of walk(dir)) {
    const local = path.relative(dir, file).replaceAll(path.sep, "/");
    const text = fs.readFileSync(file, "utf8");
    const specifiers = imports(file, text);
    if (name === "server" && local.startsWith("digital-employee/")) checkModuleFile(file, specifiers);
    else if (!local.startsWith("modules/digital-employee/") && !local.startsWith("db/migrations/")) {
      checkPlatformFile(`${name}:${local}`, text, specifiers);
    }
  }
}

for (const label of MODULE_IMPORTS) {
  if (!used.has(label)) errors.push(`${label}: no longer needed, remove it from the list`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Agent boundary passed");
}
