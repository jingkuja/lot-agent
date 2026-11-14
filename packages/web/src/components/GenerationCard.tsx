import { useI18n } from "../i18n/index.js";
import { useRef, useState } from "react";
import { randomId } from "../lib/uuid.js";
import type { GenerationView } from "../hooks/useChat.js";
import type { GenerationSettings } from "../hooks/chat-reducer.js";
import type { PosterFields, PosterLayout, PosterStyle, PosterTemplate } from "@lot-agent/core/poster";
import type {
  ExportPosterHandler, ExportPosterOptions, PosterPreviewEdit, PosterPreviewResult, PreviewPosterHandler, RestorePosterHandler,
} from "../api/client.js";
import { ImageEditDialog } from "./ImageEditDialog.js";
import { POSTER_FIELD_LABELS, PosterTextDialog } from "./PosterTextDialog.js";
import { ImageViewerDialog, type ViewerImage } from "./ImageViewerDialog.js";
import {
  COMPOSE_LAYOUTS, COMPOSE_MIN_IMAGES, EXPORT_PRESETS, imageSetRole, WHITE_BACKGROUND_ISSUES,
  type ComposeLayout, type ExportPreset, type GenerationComposite, type PosterRedoOverride, type RedoRequest,
  type SetRedoRequest, type WhiteBackgroundCheck,
} from "../lib/image-settings.js";
import { useConfirm } from "../modules/marketing-video/ConfirmDialog.js";

const LABELS = {
  image: { loading: "图片生成中……", fail: "图片生成失败", cancelled: "图片生成已取消", downloadFail: "图片下载失败" },
  video: { loading: "视频生成中……", fail: "视频生成失败", cancelled: "视频生成已取消", downloadFail: "视频下载失败" },
};

type Asset = { url: string; mime: string; durationSec?: number };

function DownloadLink({ href, name }: { href: string; name: string }) {
  const { t } = useI18n();
  return (
    <a className="gen-asset-download" href={href} download={name} target="_blank" rel="noreferrer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v12" />
        <path d="m7 11 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
      {t("下载")}</a>
  );
}

/** One generated asset: preview (img/video) + download link, with a graceful
    fallback so a load error never looks like a bare broken-image icon. */
function AssetView({
  asset, mediaType, index, settings, onEdit, poster, onRetext, onPreviewPoster,
  onRestorePoster, onExportPoster, onRegeneratePoster, long,
}: {
  /** 真实字体: the wording typeset on this image, and how to change it. Both are needed for 改字. */
  poster?: PosterLayout | null;
  onRetext?: RetextHandler;
  onPreviewPoster?: ImagePosterPreview;
  onRestorePoster?: ImagePosterRestore;
  onExportPoster?: ImagePosterExport;
  onRegeneratePoster?: (override: PosterRedoOverride) => Promise<string | undefined>;
  asset: Asset;
  long?: boolean;
  mediaType: "image" | "video";
  index: number;
  settings?: GenerationSettings;
  onEdit?: (imageUrl: string, prompt: string, settings?: GenerationSettings) => string | void | Promise<string | void>;
}) {
  const { t } = useI18n();
  const [viewing, setViewing] = useState(false);
  const [errored, setErrored] = useState(false);
  const [editing, setEditing] = useState(false);
  const [retexting, setRetexting] = useState(false);
  const ext = (asset.url.split("?")[0].split(".").pop() || "bin").toLowerCase();
  const name = `生成结果${index + 1}.${ext}`;
  const isVideo = mediaType === "video" && asset.mime.startsWith("video/");

  return (
    <div className="gen-asset-item">
      {isVideo ? (
        <video className="gen-asset" src={asset.url} controls />
      ) : errored ? (
        <div className="gen-asset-fallback" title={asset.url}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2.5" />
            <circle cx="8.5" cy="8.5" r="1.6" />
            <path d="m21 15-4.5-4.5L5 21" />
          </svg>
          <span>{t("结果文件（无法预览）")}</span>
        </div>
      ) : (
        <div className="gen-asset-frame">
          {mediaType === "image" && asset.mime.startsWith("image/") ? (
            <button type="button" className="gen-set-open" aria-label={t("放大查看")} onClick={() => setViewing(true)}>
              <img className="gen-asset" src={asset.url} alt={name} onError={() => setErrored(true)} />
            </button>
          ) : <img className="gen-asset" src={asset.url} alt={name} onError={() => setErrored(true)} />}
          {(onEdit || (poster && onRetext)) && (
            <div className="gen-asset-actions">
              {onEdit && <button type="button" className="gen-asset-edit" onClick={() => setEditing(true)}>{t("编辑")}</button>}
              {poster && onRetext && <button type="button" className="gen-asset-edit" onClick={() => setRetexting(true)}>{t("改字")}</button>}
            </div>
          )}
        </div>
      )}
      <DownloadLink href={asset.url} name={name} />
      {viewing && <ImageViewerDialog images={[{ url: asset.url, name, long }]} index={0} onIndexChange={() => {}}
        onClose={() => setViewing(false)}
        onEdit={onEdit ? () => { setViewing(false); setEditing(true); } : undefined}
        onRetext={poster && onRetext ? () => { setViewing(false); setRetexting(true); } : undefined} />}
      {editing && onEdit && (
        <ImageEditDialog imageUrl={asset.url} size={settings?.size}
          onSubmit={(prompt) => onEdit(asset.url, prompt, settings)} onClose={() => setEditing(false)} />
      )}
      {retexting && poster && onRetext && (
        <PosterTextDialog imageUrl={asset.url} poster={poster} onClose={() => setRetexting(false)}
          onSubmit={(fields, template, style, titleOptions) => onRetext(index, fields, template, style, titleOptions)}
          onPreview={onPreviewPoster && ((edit, signal) => onPreviewPoster(index, edit, signal))}
          onRestore={onRestorePoster && ((versionIndex) => onRestorePoster(index, versionIndex))}
          onExport={onExportPoster && ((options) => onExportPoster(index, options))}
          onRegenerateTemplate={onRegeneratePoster} />
      )}
    </div>
  );
}

type RetextHandler = (
  index: number, fields: PosterFields, template: PosterTemplate, style?: PosterStyle,
  titleOptions?: { titleLines?: string[]; manualTitleLines?: boolean },
) => Promise<string | undefined>;
type ImagePosterPreview = (index: number, edit: PosterPreviewEdit, signal: AbortSignal) => Promise<PosterPreviewResult>;
type ImagePosterRestore = (index: number, versionIndex: number) => Promise<string | undefined>;
type ImagePosterExport = (index: number, options: ExportPosterOptions) => Promise<string | undefined>;

/** 真实字体: what the user should know about the typeset wording — fields left empty, or text that did not fit. */
function PosterNotes({ posters }: { posters?: (PosterLayout | null)[] }) {
  const { t } = useI18n();
  if (!posters?.some((poster) => poster?.overflow || poster?.cleared?.length || poster?.backgroundSuspect)) return null;
  return (
    <div className="gen-white-notes" role="status">
      {posters.map((poster, index) => {
        if (!poster?.overflow && !poster?.cleared?.length && !poster?.backgroundSuspect) return null;
        const names = (poster.cleared ?? []).map((name) => t(POSTER_FIELD_LABELS[name])).join(t("、"));
        const label = posters.length > 1 ? <strong>{t("第 {0} 张", [index + 1])} </strong> : null;
        return <div key={index} className="gen-white-issue">
          {label}
          {names && <p>{t("这些内容没在你的描述里找到，没有写到图上：{0}。点图上的「改字」可以补上，不扣积分。", [names])}</p>}
          {poster.overflow && <p>{t("文字太多，缩到最小字号仍放不下，建议点「改字」删减。")}</p>}
          {poster.backgroundSuspect && <p>{t("文字区域底图纹理较复杂（可能影响文字清晰度），可点「改字」开启背景遮罩或调高对比度，也可「重新生成」底图。")}</p>}
        </div>;
      })}
    </div>
  );
}

function PosterBusyMask() {
  const { t } = useI18n();
  return <div className="gen-set-busy gen-poster-busy" role="status" aria-live="polite">
    <span className="gen-set-spinner" aria-hidden />{t("正在重新排版")}
  </div>;
}

function fileExtension(url: string, fallback: string): string {
  return (url.split("?")[0].split(".").pop() || fallback).toLowerCase();
}

const DOWNLOAD_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
);

/** One image inside a set frame: click to enlarge, its own download, 编辑 and 重做. While it is being redone the
 * old image stays visible under a 重做中 cover. */
function SetTile({ image, busy, onOpen, onEdit, onRedo, onRetext }: {
  image: ViewerImage; busy?: boolean; onOpen: () => void; onEdit?: () => void; onRedo?: () => void; onRetext?: () => void;
}) {
  const { t } = useI18n();
  const [errored, setErrored] = useState(false);
  return (
    <div className="gen-set-tile">
      {errored ? (
        <div className="gen-asset-fallback" title={image.url}><span>{t("结果文件（无法预览）")}</span></div>
      ) : (
        <button type="button" className="gen-set-open" onClick={onOpen} aria-label={`${t("放大查看")} ${image.label ?? image.name}`}>
          <img src={image.url} alt={image.name} loading="lazy" onError={() => setErrored(true)} />
        </button>
      )}
      {image.label && <span className="gen-asset-role">{image.label}</span>}
      <a className="gen-set-download" href={image.url} download={image.name} target="_blank" rel="noreferrer"
        aria-label={`${t("下载")} ${image.label ?? image.name}`} title={t("下载")}>
        {DOWNLOAD_ICON}
      </a>
      {busy ? (
        <div className="gen-set-busy" role="status"><span className="gen-set-spinner" aria-hidden />{t("重做中…")}</div>
      ) : (
        <div className="gen-set-tile-actions">
          {onEdit && !errored && <button type="button" className="gen-set-action" onClick={onEdit}>{t("编辑")}</button>}
          {onRetext && !errored && <button type="button" className="gen-set-action" onClick={onRetext}>{t("改字")}</button>}
          {onRedo && <button type="button" className="gen-set-action" onClick={onRedo}>{t("重做")}</button>}
        </div>
      )}
    </div>
  );
}

/** A position of the set that has no image: waiting for 补齐, or being made now. */
function MissingTile({ label, busy, ratio }: { label?: string; busy: boolean; ratio?: string }) {
  const { t } = useI18n();
  const [w, h] = (ratio ?? "1:1").split(":").map(Number);
  return (
    <div className="gen-set-tile gen-set-tile--missing" style={{ aspectRatio: w > 0 && h > 0 ? `${w} / ${h}` : "1 / 1" }}>
      {label && <span className="gen-asset-role">{label}</span>}
      {busy
        ? <div className="gen-set-busy" role="status"><span className="gen-set-spinner" aria-hidden />{t("生成中…")}</div>
        : <span className="gen-set-missing-text">{t("未生成")}</span>}
    </div>
  );
}

type RedoHandler = (request: SetRedoRequest) => Promise<string | undefined>;

/** Several images from one generation in a single frame: a grid of tiles, an enlarged view, 重做 / 补齐 and 合成. */
function ImageSet({
  generation, assets, onEdit, onCompose, onRedo, onExport, onRetext,
  onPreviewPoster, onRestorePoster, onExportPoster, onWhite, posterBusy,
}: {
  onWhite?: (index: number, restore: boolean) => Promise<string | undefined>;
  onRetext?: RetextHandler;
  onPreviewPoster?: ImagePosterPreview;
  onRestorePoster?: ImagePosterRestore;
  onExportPoster?: ImagePosterExport;
  posterBusy?: boolean;
  generation: GenerationView;
  assets: Asset[];
  onEdit?: (imageUrl: string, prompt: string, settings?: GenerationSettings) => string | void | Promise<string | void>;
  onCompose?: ComposeHandler;
  onExport?: ExportHandler;
  /** Only for sets with a role per image (产品套图 / 主副图). */
  onRedo?: RedoHandler;
}) {
  const { t } = useI18n();
  const [viewing, setViewing] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [retexting, setRetexting] = useState<number | null>(null);
  const [redoing, setRedoing] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmDialog, confirm] = useConfirm();
  const [composing, setComposing] = useState(false);
  const missing = generation.missing ?? (imageSetRole(generation.scene, 0)
    ? Math.max(0, (generation.settings?.n ?? assets.length) - assets.length) : 0);
  const redo = generation.redo;
  const running = redo?.status === "running";
  const labelAt = (index: number) => {
    const role = imageSetRole(generation.scene, index);
    return role ? t(role) : undefined;
  };
  const images: ViewerImage[] = assets.map((asset, index) => {
    const label = labelAt(index);
    const number = String(index + 1).padStart(2, "0");
    return { url: asset.url, label, name: `${label ?? "生成结果"}_${number}.${fileExtension(asset.url, "png")}` };
  });
  const edit = onEdit ? (index: number) => { setViewing(null); setEditing(index); } : undefined;
  const exportAll = onExport && ((preset: ExportPreset) => onExport(
    preset,
    images.map((image) => image.name.replace(/\.[^.]+$/, "")),
    (generation.composites ?? []).map((item) => compositeLabel(t, item)),
  ));
  const fill = async () => {
    if (!onRedo || starting || running) return;
    const ok = await confirm({
      title: "补齐缺少的图片", message: "按原来的描述生成缺少的 {0} 张，扣除 {0} 张图片的积分。",
      values: [missing], confirm: "补齐",
    });
    if (!ok) return;
    setStarting(true);
    setError(undefined);
    const failure = await onRedo({ missing: true });
    setStarting(false);
    if (failure) setError(failure);
  };
  const canRedo = !!onRedo && !running && !starting;
  return (
    <div className="gen-set">
      {generation.unknownResult && <p className="gen-card-notice" role="status">{t("图片结果待核实，请联系客服")}</p>}
      <div className="gen-set-stage" aria-busy={composing || posterBusy}>
        <div className="gen-set-grid">
          {images.map((image, index) => (
            <SetTile key={index} image={image} busy={running && redo.indexes.includes(index)} onOpen={() => setViewing(index)}
              onEdit={edit && (() => edit(index))} onRedo={canRedo ? () => setRedoing(index) : undefined}
              onRetext={onRetext && generation.posters?.[index] ? () => setRetexting(index) : undefined} />
          ))}
          {Array.from({ length: missing }, (_, i) => assets.length + i).map((index) => (
            <MissingTile key={`missing-${index}`} label={labelAt(index)} busy={running && redo.indexes.includes(index)}
              ratio={generation.settings?.ratio} />
          ))}
        </div>
        {/* While composing, the set is covered so nothing is clicked mid-way; it lifts when the picture is back. */}
        {posterBusy ? <PosterBusyMask /> : composing && (
          <div className="gen-set-busy gen-set-busy--stage" role="status"><span className="gen-set-spinner" aria-hidden />{t("合成中…")}</div>
        )}
      </div>
      {missing > 0 && !running && (
        <div className="gen-set-fill">
          <p className="gen-card-notice" role="status">{t(generation.notice ?? "套图中有 {0} 张未生成成功", [missing])}</p>
          {canRedo && (
            <button type="button" className="gen-compose-toggle" onClick={() => void fill()}>
              {t("补齐 {0} 张", [missing])}
            </button>
          )}
        </div>
      )}
      {redo?.status === "failed" && !error && (
        <p className="gen-compose-error" role="alert" title={redo.error}>{t("上次重做没有生成图片，可以再试一次。")}</p>
      )}
      {error && <p className="gen-compose-error" role="alert">{t(error)}</p>}
      {onCompose && assets.length >= COMPOSE_MIN_IMAGES && (
        <ComposePanel count={assets.length} composites={generation.composites ?? []} onCompose={onCompose} disabled={running}
          onComposingChange={setComposing} />
      )}
      <WhiteCheckNotes checks={generation.whiteChecks} onWhite={onWhite} />
      <PosterNotes posters={generation.posters} />
      {exportAll && !running && <ExportMenu onExport={exportAll} />}
      {viewing !== null && (
        <ImageViewerDialog images={images} index={viewing} onIndexChange={setViewing} onClose={() => setViewing(null)} onEdit={edit}
          onRetext={onRetext && generation.posters?.[viewing] ? (index) => { setViewing(null); setRetexting(index); } : undefined}
          onRedo={canRedo ? (index) => { setViewing(null); setRedoing(index); } : undefined} />
      )}
      {editing !== null && onEdit && (
        <ImageEditDialog imageUrl={assets[editing].url} size={generation.settings?.size}
          onSubmit={(prompt) => onEdit(assets[editing].url, prompt, generation.settings)} onClose={() => setEditing(null)} />
      )}
      {retexting !== null && onRetext && generation.posters?.[retexting] && assets[retexting] && (
        <PosterTextDialog imageUrl={assets[retexting].url} poster={generation.posters[retexting]!} onClose={() => setRetexting(null)}
          onSubmit={(fields, template, style, titleOptions) => onRetext(retexting, fields, template, style, titleOptions)}
          onPreview={onPreviewPoster && ((edit, signal) => onPreviewPoster(retexting, edit, signal))}
          onRestore={onRestorePoster && ((versionIndex) => onRestorePoster(retexting, versionIndex))}
          onExport={onExportPoster && ((options) => onExportPoster(retexting, options))} />
      )}
      {redoing !== null && onRedo && assets[redoing] && (
        <ImageEditDialog redo imageUrl={assets[redoing].url} onClose={() => setRedoing(null)}
          onSubmit={(instruction) => onRedo({ index: redoing, instruction })} />
      )}
      {confirmDialog}
    </div>
  );
}

/** File name of a single exported image, by image type. */
const SINGLE_EXPORT_NAMES: Record<string, string> = { white_background: "白底图", product_scene: "场景图" };

type ExportHandler = (preset: ExportPreset, names: string[], compositeNames: string[]) => Promise<string | undefined>;

/** The name a composite shows and downloads under: its layout, plus 留白 when it has gaps. */
function compositeLabel(t: (key: string) => string, item: GenerationComposite): string {
  const name = t(COMPOSE_LAYOUTS.find((option) => option.value === item.layout)?.label ?? "合成");
  return item.gap ? `${name} · ${t("留白")}` : name;
}

/** 打包下载: every image (and composite) in one zip, as made or sized for a selling platform. Free; done on the server. */
function ExportMenu({ onExport }: { onExport: (preset: ExportPreset) => Promise<string | undefined> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportPreset | null>(null);
  const [error, setError] = useState<string>();
  const run = async (preset: ExportPreset) => {
    if (busy) return;
    setBusy(preset);
    setError(undefined);
    let failure: string | undefined;
    try {
      failure = await onExport(preset);
    } catch {
      failure = "打包失败，请稍后重试";
    } finally {
      setBusy(null);
    }
    if (failure) setError(failure);
  };
  return (
    <div className="gen-compose gen-export">
      <button type="button" className="gen-compose-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {DOWNLOAD_ICON}
        {t("打包下载")}
      </button>
      {open && (
        <div className="gen-compose-panel">
          <div className="gen-compose-layouts" role="group" aria-label={t("打包下载")}>
            {EXPORT_PRESETS.map((preset) => (
              <button key={preset.value} type="button" className={`gen-compose-layout${busy === preset.value ? " active" : ""}`}
                disabled={!!busy} onClick={() => run(preset.value)}>
                {busy === preset.value ? t("打包中…") : t(preset.label)}
              </button>
            ))}
          </div>
          <p className="gen-compose-hint">{t("选平台后按该平台的主图尺寸放进白色方图并压到大小限制以内，长图按详情页宽度缩放；不扣积分。")}</p>
          {error && <p className="gen-compose-error" role="alert">{t(error)}</p>}
        </div>
      )}
    </div>
  );
}

/** 白底图: what the automatic check found, per image. Nothing is shown for an image that passed as it was. */
function WhiteCheckNotes({ checks, onWhite }: {
  checks?: WhiteBackgroundCheck[];
  onWhite?: (index: number, restore: boolean) => Promise<string | undefined>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!checks?.length) return null;
  const many = checks.length > 1;
  const issues = checks.flatMap((check, index) => check.issues.map((issue) => ({ index, issue })));
  const corrected = checks.some((check) => check.corrected);
  return (
    <div className="gen-white-notes" role="status">
      <p>{t(corrected ? "白底校正已应用，原图已保留" : "已保留原图；白底校正可能影响浅色商品，请对照检查")}</p>
      {checks.some(check => check.unknown) && <p>{t("白底检测未完成，请人工检查")}</p>}
      {onWhite && checks.map((check, index) => <button key={index} type="button" className="gen-compose-toggle" disabled={busy}
        onClick={async () => {
          setBusy(true); setError(undefined);
          try { setError(await onWhite(index, check.corrected)); }
          catch { setError("白底处理失败，原图已保留"); }
          finally { setBusy(false); }
        }}>{many ? `${t("第 {0} 张", [index + 1])}：` : ""}{t(check.corrected ? "恢复原图" : "应用白底校正")}</button>)}
      {error && <p role="alert">{t(error)}</p>}
      {issues.map(({ index, issue }) => (
        <p key={`${index}-${issue}`} className="gen-white-issue">
          {many ? `${t("第 {0} 张", [index + 1])}：` : ""}{t(WHITE_BACKGROUND_ISSUES[issue])}
        </p>
      ))}
    </div>
  );
}

type ComposeHandler = (layout: ComposeLayout, gap: boolean) => Promise<string | undefined>;

/** 合成：join the images of one generation into a single picture. Done on the server without a model request. */
function ComposePanel({ count, composites, onCompose, disabled, onComposingChange }: {
  count: number; composites: GenerationComposite[]; onCompose: ComposeHandler; disabled?: boolean;
  /** Told when a composite request starts and ends, so the set can be covered meanwhile. */
  onComposingChange?: (composing: boolean) => void;
}) {
  const { t } = useI18n();
  const layouts = COMPOSE_LAYOUTS.filter((item) => count >= item.min);
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<ComposeLayout>(layouts[0].value);
  const [gap, setGap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const active = layouts.find((item) => item.value === layout) ?? layouts[0];
  const labelOf = (item: GenerationComposite) => compositeLabel(t, item);
  const [viewing, setViewing] = useState<number | null>(null);
  const composed: ViewerImage[] = composites.map((item) => ({
    url: item.url, label: labelOf(item), long: item.layout === "vertical", name: `${labelOf(item)}.${fileExtension(item.url, "jpg")}`,
  }));
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    onComposingChange?.(true);
    setError(undefined);
    let failure: string | undefined;
    try {
      failure = await onCompose(active.value, gap);
    } catch {
      failure = "合成失败，请稍后重试";
    } finally {
      setBusy(false);
      onComposingChange?.(false);
    }
    if (failure) setError(failure);
    else setOpen(false);
  };

  return (
    <div className="gen-compose">
      <button type="button" className="gen-compose-toggle" aria-expanded={open} disabled={disabled} onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="3" width="8" height="8" rx="1.5" />
          <rect x="13" y="3" width="8" height="8" rx="1.5" />
          <rect x="3" y="13" width="18" height="8" rx="1.5" />
        </svg>
        {t("合成")}
      </button>
      {open && !disabled && (
        <div className="gen-compose-panel">
          <div className="gen-compose-layouts" role="radiogroup" aria-label={t("合成版式")}>
            {layouts.map((item) => (
              <button key={item.value} type="button" role="radio" aria-checked={item.value === active.value}
                className={`gen-compose-layout${item.value === active.value ? " active" : ""}`} onClick={() => setLayout(item.value)}>
                {t(item.label)}
              </button>
            ))}
          </div>
          <p className="gen-compose-hint">{t(active.hint)}</p>
          <label className="gen-compose-gap">
            <input type="checkbox" checked={gap} onChange={(event) => setGap(event.target.checked)} />
            {t("图片之间留白")}
          </label>
          <div className="gen-compose-actions">
            <button type="button" className="gen-compose-submit" onClick={submit} disabled={busy}>
              {busy ? t("合成中…") : t("生成合成图")}
            </button>
            <span className="gen-compose-free">{t("合成不扣积分")}</span>
          </div>
          {error && <p className="gen-compose-error" role="alert">{t(error)}</p>}
        </div>
      )}
      {composed.length > 0 && (
        <div className="gen-set-grid gen-compose-results">
          {composed.map((item, index) => (
            <SetTile key={item.url} image={item} onOpen={() => setViewing(index)} />
          ))}
        </div>
      )}
      {viewing !== null && composed[viewing] && (
        <ImageViewerDialog images={composed} index={viewing} onIndexChange={setViewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

function MediaIcon({ mediaType }: { mediaType: "image" | "video" }) {
  if (mediaType === "video") {
    return (
      <svg viewBox="0 0 24 24" className="gen-card-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
        <path d="M10 9.5v5l4-2.5z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="gen-card-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8.5" cy="8.5" r="1.6" />
      <path d="m21 15-4.5-4.5L5 21" />
    </svg>
  );
}

export function GenerationCard({
  generation,
  messageId,
  onRedownload,
  onEditImage,
  onCompose,
  onRedo,
  onExport,
  onEditPoster,
  onPreviewPoster,
  onRestorePoster,
  onExportPoster,
  onCancelGeneration,
  onWhiteBackground,
}: {
  generation: GenerationView;
  onCancelGeneration?: (taskId?: string) => void;
  onWhiteBackground?: (messageId: string, index: number, restore: boolean) => Promise<string | undefined>;
  messageId?: string;
  /** 真实字体: change the wording of one typeset image; resolves to an error text. Undefined hides 改字. */
  onEditPoster?: (
    messageId: string, index: number, fields: PosterFields, template: PosterTemplate, style?: PosterStyle,
    titleOptions?: { titleLines?: string[]; manualTitleLines?: boolean },
  ) => Promise<string | undefined>;
  /** 改字预览: render a draft for editing without saving it. */
  onPreviewPoster?: PreviewPosterHandler;
  /** 真实字体版本回退: restore a saved snapshot on the server without billing. */
  onRestorePoster?: RestorePosterHandler;
  /** 真实字体高清/换比例导出: renders PNG bytes at the requested resolution and aspect ratio. */
  onExportPoster?: ExportPosterHandler;
  /** 打包下载 this generation's images; resolves to an error text. Undefined hides it. */
  onExport?: (messageId: string, preset: ExportPreset, names: string[], compositeNames: string[]) => Promise<string | undefined>;
  /** 重做 one image of a set or 补齐 its missing ones; resolves to an error text. Undefined hides both. */
  onRedo?: (messageId: string, request: RedoRequest) => Promise<string | undefined>;
  /** Join this generation's images into one picture; resolves to an error text. Undefined hides 合成. */
  onCompose?: (messageId: string, layout: ComposeLayout, gap: boolean) => Promise<string | undefined>;
  /** Edit a generated image: image-to-image with it as the reference and this
   * generation's settings. Returns an error to show in the editor; undefined hides the button. */
  onEditImage?: (imageUrl: string, prompt: string, settings?: GenerationSettings) => string | void | Promise<string | void>;
  /** Retry only the download of a "下载失败" generation (vendor media already
   * succeeded). Undefined disables the re-download button. */
  onRedownload?: (messageId: string, mediaType: "image" | "video") => void;
}) {
  const { t } = useI18n();
  const { mediaType, status, assets, error, taskId } = generation;
  const [regenerateDialog, confirmRegenerate] = useConfirm();
  const [regenerateBusy, setRegenerateBusy] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string>();
  const [posterBusy, setPosterBusy] = useState(false);
  const [posterError, setPosterError] = useState<string>();
  const regenerateRequest = useRef<string | undefined>(undefined);
  const regenerate = async () => {
    if (!messageId || !onRedo || regenerateBusy) return;
    if (!regenerateRequest.current) {
      const confirmed = await confirmRegenerate({
        title: "重新生成图片", message: "沿用原图要求生成一张新图，按 1 张图片计费。", confirm: "重新生成",
      });
      if (!confirmed) return;
      regenerateRequest.current = randomId();
    }
    setRegenerateBusy(true);
    setRegenerateError(undefined);
    try {
      const failure = await onRedo(messageId, { regenerate: true, requestId: regenerateRequest.current });
      if (!failure || failure === "重新生成失败，请查看对话中的提示") regenerateRequest.current = undefined;
      setRegenerateError(failure);
    } finally {
      setRegenerateBusy(false);
    }
  };

  const retext: RetextHandler | undefined = messageId && onEditPoster
    ? async (index, fields, template, style, titleOptions) => {
      setPosterBusy(true);
      setPosterError(undefined);
      try {
        const failure = await onEditPoster(messageId, index, fields, template, style, titleOptions);
        if (failure) setPosterError(failure);
        return failure;
      } catch {
        const failure = "改字失败，请稍后重试";
        setPosterError(failure);
        return failure;
      } finally {
        setPosterBusy(false);
      }
    } : undefined;
  const previewPoster: ImagePosterPreview | undefined = messageId && onPreviewPoster
    ? (index, edit, signal) => onPreviewPoster(messageId, index, edit, signal) : undefined;
  const restorePoster: ImagePosterRestore | undefined = messageId && onRestorePoster
    ? (index, versionIndex) => onRestorePoster(messageId, index, versionIndex) : undefined;
  const exportPoster: ImagePosterExport | undefined = messageId && onExportPoster
    ? (index, options) => onExportPoster(messageId, index, options) : undefined;
  const regenerateForPoster = messageId && onRedo && taskId && assets?.length === 1 && !imageSetRole(generation.scene, 0)
    ? async (override: PosterRedoOverride): Promise<string | undefined> => {
      if (regenerateBusy) return "正在提交…";
      setRegenerateBusy(true);
      try {
        return await onRedo(messageId, { regenerate: true, requestId: randomId(), poster: override });
      } finally {
        setRegenerateBusy(false);
      }
    }
    : undefined;
  const onWhite = messageId && onWhiteBackground ? (index: number, restore: boolean) => onWhiteBackground(messageId, index, restore) : undefined;
  if (status === "completed" && assets && assets.length > 0) {
    // Several images from one generation, or any 产品套图 / 主副图, share one frame; other single images and videos
    // keep their own card.
      const imageSet = !!imageSetRole(generation.scene, 0);
      if (mediaType === "image" && (assets.length >= COMPOSE_MIN_IMAGES || imageSet) && assets.every((a) => a.mime.startsWith("image/"))) {
        return (
          <>
            <ImageSet generation={generation} assets={assets} onEdit={onEditImage} onRetext={retext} onPreviewPoster={previewPoster}
              onRestorePoster={restorePoster} onExportPoster={exportPoster} onWhite={onWhite}
              posterBusy={posterBusy}
              onCompose={messageId && onCompose ? (layout, gap) => onCompose(messageId, layout, gap) : undefined}
              onRedo={messageId && onRedo && imageSet && !generation.unknownResult ? (request) => onRedo(messageId, request) : undefined}
              onExport={messageId && onExport ? (preset, names, compositeNames) => onExport(messageId, preset, names, compositeNames) : undefined} />
            {posterError && <p className="gen-compose-error" role="alert">{t(posterError)}</p>}
          </>
        );
      }
    const singleImage = mediaType === "image" && assets.length === 1 && assets[0].mime.startsWith("image/");
    return (
      <>
        <div className="gen-poster-stage" aria-busy={posterBusy}>
          <div className="gen-card-assets">
            {assets.map((a, i) => (
              <AssetView key={i} asset={a} mediaType={mediaType} index={i} settings={generation.settings}
                onEdit={mediaType === "image" && a.mime.startsWith("image/") ? onEditImage : undefined}
                poster={generation.posters?.[i]} onRetext={retext} onPreviewPoster={previewPoster}
                onRestorePoster={restorePoster} onExportPoster={exportPoster}
                onRegeneratePoster={singleImage ? regenerateForPoster : undefined} long={generation.longImage} />
            ))}
          </div>
          {posterBusy && <PosterBusyMask />}
        </div>
        {posterError && <p className="gen-compose-error" role="alert">{t(posterError)}</p>}
        {generation.notice && <p className="gen-card-notice" role="status">{t(generation.notice)}</p>}
        {singleImage && <WhiteCheckNotes checks={generation.whiteChecks} onWhite={onWhite} />}
        {singleImage && <PosterNotes posters={generation.posters} />}
        {singleImage && messageId && (
          <div className="gen-single-actions">
            {onRedo && taskId && <button type="button" className="gen-compose-toggle" disabled={regenerateBusy}
              onClick={() => void regenerate()}>
              {t(regenerateBusy ? "正在提交…" : regenerateRequest.current ? "核对提交" : "重新生成")}
            </button>}
            {onExport && <ExportMenu onExport={(preset) => onExport(
              messageId, preset, [`${SINGLE_EXPORT_NAMES[generation.scene ?? ""] ?? "生成结果"}_01`], [],
            )} />}
          </div>
        )}
        {regenerateError && <p className="gen-compose-error" role="alert">{t(regenerateError)}</p>}
        {regenerateDialog}
      </>
    );
  }

  const cancelled = status === "cancelled";
  // The vendor produced the media but our download of it failed — recoverable,
  // shown distinctly from a real generation failure and offering a retry.
  const downloadFailed = status === "download_failed";
  const failed = status === "failed" || status === "completed";
  const generating = !failed && !cancelled && !downloadFailed;
  // Local polling/submission failures do not establish the vendor's outcome.
  const resultUnknown = generation.unknownResult || error === "IMAGE_RESULT_UNKNOWN" || error === "生成状态获取失败" || status === "completed";
  const videoFailed = mediaType === "video" && failed;
  // The server classifies the vendor rejection; raw patterns cover older messages.
  const realPersonRejected = /REAL_PERSON_REJECTED|\.PrivacyInformation\b|may contain (?:a )?real person/i.test(error ?? "");
  const contentBlocked = /CONTENT_BLOCKED/.test(error ?? "");
  const showFailureHint = failed || cancelled || downloadFailed;
  const failureHint = realPersonRejected
    ? "上传的参考图包含真人，需要先完成真人认证后再使用。"
    : contentBlocked
      ? "出图模型的安全审核拒绝了这次请求，请调整参考图和描述后重试。"
    : resultUnknown
       ? mediaType === "image" ? "图片结果待核实，请联系客服" : "暂时无法确认视频生成结果，请刷新会话查看，或联系客服。"
       : cancelled ? "已停止后续处理，上游已受理请求的费用以网关为准"
       : downloadFailed ? "图片已生成，可重新下载，无需再次生成"
       : "请稍后再试，或联系客服。";
  const showNoCharge = videoFailed && status === "failed" && !!taskId && !resultUnknown;
  const label = cancelled
    ? LABELS[mediaType].cancelled
    : downloadFailed
      ? LABELS[mediaType].downloadFail
      : failed
        ? LABELS[mediaType].fail
        : generation.supportsProgress
          ? `${mediaType === "video" ? "视频" : "图片"}生成中 ${generation.progress ?? 0}%`
          : LABELS[mediaType].loading;

  return (
    <div className={`gen-card ${mediaType} ${generating ? "gen-card--loading" : "gen-card--failed"}`}>
      <MediaIcon mediaType={mediaType} />
      <div className="gen-card-label">{t(label)}</div>
      {failed && generation.notice && (
        <div className="gen-card-error" role="status"><p>{t(generation.notice)}</p></div>
      )}
      {showFailureHint && (
        <div className="gen-card-error" role="status">
          <p>{t(failureHint)}</p>
          {showNoCharge && <p>{t("温馨提示：视频未成功生成，不会扣除积分。")}</p>}
        </div>
      )}
      {generating && onCancelGeneration && (
        <button type="button" className="gen-card-cancel" onClick={() => onCancelGeneration(taskId)}>
          {t("取消")}
        </button>
      )}
      {downloadFailed && messageId && onRedownload && (
        <button type="button" className="gen-card-retry" onClick={() => onRedownload(messageId, mediaType)}>
          {t("重新下载")}</button>
      )}
    </div>
  );
}
