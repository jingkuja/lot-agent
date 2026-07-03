import { randomUUID } from "node:crypto";
import type { Tool, ToolResult, ObjectStorage } from "@lot-agent/core";
import type { DB } from "../db/database.js";
import {
  extractTheme,
  DEFAULT_THEME,
  type PptTheme,
} from "../ppt/theme-extractor.js";
import { renderPptx, type PptSlide } from "../ppt/renderer.js";
import {
  renderPptxFromTemplate,
  templateHasReusableDesign,
} from "../ppt/template-renderer.js";

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const LAYOUTS = new Set(["cover", "section", "content"]);
const MAX_SLIDES = 40;

interface PptToolDeps {
  /** 产出文件的存储（data/documents，/static/documents） */
  storage: ObjectStorage;
  /** 用户上传文件的存储（读取模版字节） */
  uploadStorage: ObjectStorage;
  db: DB;
}

/**
 * `generate_ppt` — 大纲 → .pptx。可选套用用户上传模版（templateAssetId）的
 * 配色/字体；模版缺失或解析失败降级默认主题（结果里注明），渲染同步进行。
 */
export function createPptTool(deps: PptToolDeps): Tool {
  const { storage, uploadStorage, db } = deps;

  return {
    name: "generate_ppt",
    description:
      "根据大纲生成 .pptx 演示文稿并返回下载链接。" +
      "可传 templateAssetId（用户上传的 PPT 模版，见消息中的 [PPT模版已上传…] 标记）以套用其配色与字体；没有模版就不要传。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "演示文稿标题（用于文件名与提示）" },
        templateAssetId: {
          type: "string",
          description: "用户上传模版的 assetId。仅在消息里出现过模版标记时传入。",
        },
        slides: {
          type: "array",
          description: "每页一个条目，按顺序渲染",
          items: {
            type: "object",
            properties: {
              layout: { type: "string", enum: ["cover", "section", "content"] },
              title: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              notes: { type: "string" },
            },
            required: ["layout", "title"],
          },
        },
      },
      required: ["title", "slides"],
    },
    async execute(input, context): Promise<ToolResult> {
      const { title = "", templateAssetId, slides } =
        (input as {
          title?: string;
          templateAssetId?: string;
          slides?: PptSlide[];
        }) ?? {};

      if (!Array.isArray(slides) || slides.length === 0) {
        return { content: "generate_ppt 需要非空的 slides 数组。", isError: true, errorKind: "validation" };
      }
      if (slides.length > MAX_SLIDES) {
        return { content: `slides 过多（最多 ${MAX_SLIDES} 页）。`, isError: true, errorKind: "validation" };
      }
      for (const s of slides) {
        if (!LAYOUTS.has(s.layout) || !s.title?.trim()) {
          return {
            content: "每页需要合法的 layout（cover/section/content）和非空 title。",
            isError: true,
            errorKind: "validation",
          };
        }
      }

      const userId = context.userId ?? "default";

      // 模版处理按"设计放在哪里"分流：
      //  · 富模版（背景/装饰在母版/版式上，可复用）→ 克隆套版，继承背景与母版样式；
      //  · 空白版式型（设计逐页画在幻灯片上，版式是空白 Office 版式）→ 克隆只会
      //    得到白板 + 母版默认巨大字号，反而更难看，所以改为提取其配色/字体，
      //    喂给内置的精美渲染器；
      //  · 坏 zip / 解析失败 → 默认样式。逐级注明。
      let buffer: Buffer | null = null;
      let theme: PptTheme = DEFAULT_THEME;
      let themeNote = "";
      if (templateAssetId) {
        let bytes: Buffer | null = null;
        try {
          const asset = await db.getAsset(templateAssetId);
          if (!asset || asset.user_id !== userId) throw new Error("template not found");
          bytes = await uploadStorage.get(asset.storage_key);
        } catch {
          themeNote = "\n注意：模版解析失败，已使用默认样式。";
        }
        if (bytes) {
          try {
            // 坏 zip 在此抛出 → 落到 catch 记"解析失败"
            const rich = await templateHasReusableDesign(bytes);
            if (rich) {
              try {
                buffer = await renderPptxFromTemplate({ title, slides }, bytes);
                themeNote = "\n已套用上传模版的版式、背景与母版样式。";
              } catch {
                // 克隆意外失败：退到主题提取（extractTheme 从不抛错，坏 zip
                // 返回 DEFAULT_THEME 本体，靠引用相等识别静默降级）。
                theme = await extractTheme(bytes);
                themeNote =
                  theme === DEFAULT_THEME
                    ? "\n注意：模版解析失败，已使用默认样式。"
                    : "\n注意：模版版式克隆失败，已退化为仅套用模版配色与字体。";
              }
            } else {
              theme = await extractTheme(bytes);
              themeNote =
                theme === DEFAULT_THEME
                  ? "\n注意：模版仅含空白版式，已使用默认样式。"
                  : "\n模版为空白版式型，已提取其配色与字体套用到内置精美版式。";
            }
          } catch {
            themeNote = "\n注意：模版解析失败，已使用默认样式。";
          }
        }
      }

      if (!buffer) {
        try {
          buffer = await renderPptx({ title, slides }, theme);
        } catch (err) {
          return {
            content: `PPT 渲染失败: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      const id = randomUUID();
      const key = `${id}.pptx`;
      const { url } = await storage.put({ key, body: buffer, contentType: PPTX_MIME });
      await db.createAsset({
        id,
        userId,
        type: "document",
        storageKey: key,
        url,
        mime: PPTX_MIME,
        sizeBytes: buffer.byteLength,
      });

      return {
        content:
          `已生成演示文稿「${title || key}」（${slides.length} 页）。\n` +
          `下载链接：${url}\nasset_id: ${id}${themeNote}`,
      };
    },
  };
}
