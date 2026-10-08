import { randomUUID } from "node:crypto";
import type { Tool, ToolResult, ObjectStorage } from "@lot-agent/core";
import type { DB } from "../db/database.js";
import { DOWNLOAD_RESULT_HINT } from "./artifact-result.js";
import {
  extractTheme,
  extractBackgrounds,
  DEFAULT_THEME,
  type PptTheme,
  type SlideBackground,
  type OverlayMode,
} from "../ppt/theme-extractor.js";
import { renderPptx, type PptSlide } from "../ppt/renderer.js";
import { PPT_DECK_SCHEMA, PPT_ARTIFACT_PREFIX, inspectDeck, validateDeck, type PptDeck } from "@lot-agent/core/presentation";
import { getPreset } from "../ppt/themes.js";
import {
  renderPptxFromTemplate,
  templateHasReusableDesign,
} from "../ppt/template-renderer.js";

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

interface PptToolDeps {
  /** 产出文件的存储（data/documents，/static/documents） */
  storage: ObjectStorage;
  /** 用户上传文件的存储（读取模版字节） */
  uploadStorage: ObjectStorage;
  db: DB;
  renderPreview?: (buffer: Buffer, count: number, signal?: AbortSignal) => Promise<Buffer[] | null>;
}

/** 克隆路径只认 cover/section/content；把富版式文本化降级，避免 slideXml 丢内容。 */
function degradeForClone(slides: PptSlide[]): PptSlide[] {
  return slides.map((s) => {
    switch (s.layout) {
      case "stats":
      case "keypoints":
        return {
          ...s,
          layout: "content",
          title: s.title,
          bullets: (s.items ?? []).map((it) =>
            it.value
              ? `${it.label}：${it.value}${it.desc ? `（${it.desc}）` : ""}`
              : `${it.label}${it.desc ? `：${it.desc}` : ""}`
          ),
        };
      case "timeline":
        return {
          ...s,
          layout: "content",
          title: s.title,
          bullets: (s.items ?? []).map((it, i) => `${i + 1}. ${it.label}${it.desc ? `：${it.desc}` : ""}`),
        };
      case "compare":
        return {
          ...s,
          layout: "content",
          title: s.title,
          bullets: [`【${s.left?.title}】`, ...(s.left?.bullets ?? []), `【${s.right?.title}】`, ...(s.right?.bullets ?? [])],
        };
      case "quote":
        return { ...s, layout: "section", title: s.quote?.text ?? s.title, subtitle: s.quote?.author };
      case "agenda":
        return { ...s, layout: "content", title: s.title, bullets: (s.items ?? slides.filter(slide => slide.layout === "section").map(slide => ({ label: slide.title }))).map((it) => it.label) };
      case "closing":
        return { ...s, layout: "section", title: s.title, subtitle: s.subtitle };
      default:
        return s;
    }
  });
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
      "Generate a .pptx presentation from the outline and return a download link. Pass templateAssetId only for a user-uploaded template identified by an upload marker; otherwise omit it.",
    parameters: PPT_DECK_SCHEMA,
    execConfig: { timeoutMs: 90_000 },
    async execute(input, context): Promise<ToolResult> {
      context.signal?.throwIfAborted();
      const { title = "", templateAssetId, themePreset, slides, backgrounds } =
        (input as {
          title?: string;
          templateAssetId?: string;
          themePreset?: string;
          slides?: PptSlide[];
          backgrounds?: { assetId?: string; role?: "cover" | "body" | "section"; overlay?: OverlayMode }[];
        }) ?? {};

      const validationError = validateDeck(input);
      if (validationError) {
        return { content: `generate_ppt validation failed: ${validationError}`, isError: true, errorKind: "validation" };
      }

      const deck = input as PptDeck;
      const userId = context.userId ?? "default";

      let theme: PptTheme = getPreset(themePreset ?? "business") ?? DEFAULT_THEME;

      // 上传背景图：读字节 → SlideBackground，按 role 装配（缺省按序 cover/body/section）
      const ROLE_ORDER: ("cover" | "body" | "section")[] = ["cover", "body", "section"];
      const uploadedBg: NonNullable<PptTheme["backgrounds"]> = {};
      let ignoredBg = 0;
      if (Array.isArray(backgrounds) && backgrounds.length) {
        for (let i = 0; i < backgrounds.length; i++) {
          const spec = backgrounds[i] as { assetId?: string; role?: "cover" | "body" | "section"; overlay?: OverlayMode };
          const role = spec.role ?? ROLE_ORDER[i] ?? "body";
          try {
            const asset = await db.getAsset(spec.assetId ?? "");
            if (!asset || asset.user_id !== userId) throw new Error("bg not found");
            const bytes = await uploadStorage.get(asset.storage_key);
            const ext: "png" | "jpeg" = /jpe?g$/i.test(asset.mime ?? "") ? "jpeg" : "png";
            const bg: SlideBackground = { image: bytes, ext, overlay: spec.overlay ?? "dark" };
            uploadedBg[role] = bg;
            if (backgrounds.length === 1 && !spec.role) { uploadedBg.body = bg; uploadedBg.cover = bg; }
          } catch { ignoredBg++; }
        }
      }
      const hasUploadedBg = !!(uploadedBg.cover || uploadedBg.body || uploadedBg.section);

      // 模版处理按"设计放在哪里"分流，降级链自上而下命中即止：
      //  1. 上传背景图 → ThemePack 渲染（配色仍可用模版提取/preset 作基准）；
      //  2. 模版背景图提取成功 → ThemePack 渲染（全版式）；
      //  3. 提不到背景但模版"有可复用设计"（富模版：背景/装饰在母版/版式上）→
      //     克隆套版，继承背景与母版样式（新版式先降级映射为 content/section）；
      //  4. 空白版式型（设计逐页画在幻灯片上，版式是空白 Office 版式）→ 克隆只会
      //     得到白板 + 母版默认巨大字号，反而更难看，所以改为提取其配色/字体，
      //     喂给内置的精美渲染器；
      //  5. 坏 zip / 解析失败 / 无模版 → 默认样式（或 themePreset）。逐级注明。
      let buffer: Buffer | null = null;
      let themeNote = "";

      if (hasUploadedBg) {
        // 上传背景优先：配色仍可用模版提取作基准
        if (templateAssetId) {
          try {
            const asset = await db.getAsset(templateAssetId);
            if (asset && asset.user_id === userId) {
              const bytes = await uploadStorage.get(asset.storage_key);
              const extracted = await extractTheme(bytes);
              if (extracted !== DEFAULT_THEME) theme = extracted;
            }
          } catch { /* 配色提取失败无所谓，用 preset/default */ }
        }
        theme = { ...theme, backgrounds: { ...theme.backgrounds, ...uploadedBg } };
        themeNote = "\n已套用你上传的背景图。";
      } else if (templateAssetId) {
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
            const tplBg = await extractBackgrounds(bytes);
            if (tplBg) {
              const extracted = await extractTheme(bytes);
              theme = { ...(extracted !== DEFAULT_THEME ? extracted : theme), backgrounds: tplBg };
              themeNote = "\n已提取模版的背景图与配色套用到全部版式。";
            } else {
              const rich = await templateHasReusableDesign(bytes);
              // A generic clone has no semantic slots for charts/cards. Keep the
              // confirmed native layout instead of silently flattening its content.
              const cloneCompatible = slides!.every(s => ["cover", "section", "content", "closing", "agenda"].includes(s.layout) && !s.notes && !s.source && !s.subtitle);
              if (rich && !cloneCompatible) {
                const extracted = await extractTheme(bytes);
                if (extracted !== DEFAULT_THEME) theme = extracted;
                themeNote = "\n已沿用模版配色与字体；复杂版式、来源及备注使用内置渲染，保留已确认内容。";
              } else if (rich) {
                try {
                  buffer = await renderPptxFromTemplate({ title, slides: degradeForClone(slides!) }, bytes);
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
            }
          } catch {
            themeNote = "\n注意：模版解析失败，已使用默认样式。";
          }
        }
      }
      if (ignoredBg > 0) themeNote += `\n（有 ${ignoredBg} 张背景图无法读取，已忽略。）`;

      context.signal?.throwIfAborted();
      if (!buffer) {
        try {
          buffer = await renderPptx({ title, slides: slides! }, theme);
        } catch (err) {
          return {
            content: `PPT 渲染失败: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      context.signal?.throwIfAborted();
      const id = randomUUID();
      const key = `${id}.pptx`;
      const { url } = await storage.put({ key, body: buffer, contentType: PPTX_MIME });
      if (context.signal?.aborted) {
        // This key belongs only to this attempt; no asset row has been published.
        await storage.delete(key).catch(() => {});
        context.signal.throwIfAborted();
      }
      const storedKeys = [key];
      const previewUrls: string[] = [];
      try {
        let previews: Buffer[] | null = null;
        try { previews = await deps.renderPreview?.(buffer, slides!.length, context.signal) ?? null; }
        catch { context.signal?.throwIfAborted(); }
        if (previews?.length === slides!.length) {
          try {
            for (let i = 0; i < previews.length; i++) {
              context.signal?.throwIfAborted();
              const previewKey = `${id}-slide-${i + 1}.png`;
              storedKeys.push(previewKey);
              const preview = await storage.put({ key: previewKey, body: previews[i], contentType: "image/png" });
              previewUrls.push(preview.url);
            }
          } catch {
            await Promise.allSettled(storedKeys.slice(1).map(k => storage.delete(k)));
            previewUrls.length = 0;
            context.signal?.throwIfAborted();
          }
        }
        context.signal?.throwIfAborted();
        await db.createAsset({
          id, userId, type: "document", storageKey: key, url, mime: PPTX_MIME, sizeBytes: buffer.byteLength,
        });
      } catch (error) {
        await Promise.allSettled(storedKeys.map(k => storage.delete(k)));
        throw error;
      }
      const warnings = inspectDeck(deck);
      if (themeNote.trim()) warnings.push({ code: "template", message: themeNote.trim() });
      const artifact = { version: 1, deck, warnings, previewUrls, previewStatus: previewUrls.length ? "ready" : "unavailable" };

      return {
        content:
          `已生成演示文稿「${title || key}」（${slides!.length} 页）。\n` +
          `下载链接：${url}\nasset_id: ${id}${themeNote}\n` +
          DOWNLOAD_RESULT_HINT + "\n" + PPT_ARTIFACT_PREFIX + JSON.stringify(artifact),
      };
    },
  };
}
