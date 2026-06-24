import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Tool, ToolResult, ObjectStorage } from "@lot-agent/core";
import type { DB } from "../db/database.js";

/** Python packages the shared skills venv needs for the richer formats.
 *  Mirrors the install commands documented in skills/doc-generation.md. */
const VENV_DEPS = ["python-docx", "reportlab"];

const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
};

const SUPPORTED = new Set(["docx", "pdf", "md", "html"]);

interface DocToolDeps {
  storage: ObjectStorage;
  db: DB;
  /** Directory for the shared Python virtualenv (created on first use). */
  venvDir: string;
  /** Absolute path to skills/scripts/gen_doc.py. */
  scriptPath: string;
  /** Scratch directory for spec/output files. */
  tmpDir: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => res({ code: code ?? -1, stdout, stderr }));
    child.on("error", (err) => res({ code: -1, stdout, stderr: String(err) }));
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function venvPython(venvDir: string): string {
  return process.platform === "win32"
    ? resolve(venvDir, "Scripts", "python.exe")
    : resolve(venvDir, "bin", "python");
}

// Bootstrap is shared across calls; cache the resolved interpreter path.
let envPromise: Promise<string> | null = null;

/**
 * Ensure the shared Python venv exists with the document deps installed, and
 * return its interpreter. On any failure (no python3, no network for pip) we
 * fall back to the system `python3` — the script degrades formats that need a
 * missing library to Markdown, so md/html still work.
 */
async function ensurePython(venvDir: string): Promise<string> {
  const py = venvPython(venvDir);
  if (await pathExists(py)) return py;

  const system = process.env.PYTHON_BIN || "python3";
  const created = await run(system, ["-m", "venv", venvDir]);
  if (created.code !== 0 || !(await pathExists(py))) {
    console.warn(`[doc-tool] venv creation failed, using system python: ${created.stderr}`);
    return system;
  }
  const installed = await run(py, [
    "-m",
    "pip",
    "install",
    "--quiet",
    "--disable-pip-version-check",
    ...VENV_DEPS,
  ]);
  if (installed.code !== 0) {
    console.warn(`[doc-tool] pip install failed (formats will degrade): ${installed.stderr}`);
  }
  return py;
}

function getPython(venvDir: string): Promise<string> {
  if (!envPromise) {
    envPromise = ensurePython(venvDir).catch((err) => {
      envPromise = null; // allow a later retry
      throw err;
    });
  }
  return envPromise;
}

/**
 * `generate_document` — turns Markdown content into a downloadable document
 * (Word .docx / PDF / Markdown / HTML) via a sandboxed Python script, stores it
 * as an asset, and returns the download URL. Stays available on the deployed
 * box even though `execute_command` is disabled.
 */
export function createDocTool(deps: DocToolDeps): Tool {
  const { storage, db, venvDir, scriptPath, tmpDir } = deps;

  return {
    name: "generate_document",
    description:
      "Generate a downloadable document file from Markdown content. " +
      "Supports Word (docx), PDF, Markdown (md) and HTML. Returns a download URL. " +
      "Use this when the user asks to export, generate, or download a document/report.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Document title (rendered as the top heading). Optional.",
        },
        content: {
          type: "string",
          description:
            "Document body as Markdown. Supports #/##/### headings, '- ' bullets and paragraphs.",
        },
        format: {
          type: "string",
          enum: ["docx", "pdf", "md", "html"],
          description: "Output format (default: docx). Falls back to Markdown if a library is missing.",
        },
      },
      required: ["content"],
    },
    async execute(input, context): Promise<ToolResult> {
      const {
        title = "",
        content = "",
        format = "docx",
      } = (input as { title?: string; content?: string; format?: string }) ?? {};

      if (!content.trim()) {
        return { content: "Cannot generate a document: `content` is empty.", isError: true };
      }

      const fmt = SUPPORTED.has(format) ? format : "docx";
      const userId = context.userId ?? "default";
      const id = randomUUID();

      await mkdir(tmpDir, { recursive: true });
      const specPath = resolve(tmpDir, `${id}.spec.json`);
      const outPath = resolve(tmpDir, `${id}.${fmt}`);

      await writeFile(
        specPath,
        JSON.stringify({ title, content, format: fmt, outPath }),
        "utf-8"
      );

      let python: string;
      try {
        python = await getPython(venvDir);
      } catch (err) {
        python = process.env.PYTHON_BIN || "python3";
        console.warn(`[doc-tool] falling back to system python: ${err}`);
      }

      const result = await run(python, [scriptPath, specPath], tmpDir);
      await rm(specPath, { force: true }).catch(() => {});

      if (result.code !== 0) {
        return {
          content: `Document generation failed: ${result.stderr || result.stdout || "unknown error"}`,
          isError: true,
        };
      }

      let parsed: { ok: boolean; path: string; format: string; degraded: boolean; note: string };
      try {
        const lastLine = result.stdout.trim().split("\n").pop() ?? "";
        parsed = JSON.parse(lastLine);
      } catch {
        return { content: `Unexpected script output: ${result.stdout}`, isError: true };
      }

      if (!parsed.ok) {
        return { content: `Document generation failed: ${parsed.note}`, isError: true };
      }

      const actualFmt = parsed.format;
      const buf = await readFile(parsed.path);
      await rm(parsed.path, { force: true }).catch(() => {});

      const key = `${id}.${actualFmt}`;
      const mime = MIME[actualFmt] ?? "application/octet-stream";
      const { url } = await storage.put({ key, body: buf, contentType: mime });
      await db.createAsset({
        id,
        userId,
        type: "document",
        storageKey: key,
        url,
        mime,
        sizeBytes: buf.byteLength,
      });

      const degradeNote = parsed.degraded
        ? `\n注意：缺少生成 ${format} 所需的 Python 库，已降级为 Markdown。可在服务器上运行 \`pip install ${VENV_DEPS.join(" ")}\` 后重试。`
        : "";

      return {
        content:
          `已生成文档「${title || key}」(${actualFmt})。\n` +
          `下载链接：${url}\nasset_id: ${id}${degradeNote}`,
      };
    },
  };
}
