import { useI18n } from "../i18n/index.js";
import { useState } from "react";
import { api } from "../api/client.js";
import type { GenerationView } from "../hooks/useChat.js";
import type { GenerationSettings } from "../hooks/chat-reducer.js";
import { ImageEditDialog } from "./ImageEditDialog.js";
import { ImageViewerDialog, type ViewerImage } from "./ImageViewerDialog.js";
import {
  COMPOSE_LAYOUTS, COMPOSE_MIN_IMAGES, EXPORT_PRESETS, imageSetRole, WHITE_BACKGROUND_ISSUES,
  type ComposeLayout, type ExportPreset, type GenerationComposite, type RedoRequest, type WhiteBackgroundCheck,
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
function AssetView({ asset, mediaType, index, settings, onEdit }: {
  asset: Asset;
  mediaType: "image" | "video";
  index: number;
  settings?: GenerationSettings;
  onEdit?: (imageUrl: string, prompt: string, settings?: GenerationSettings) => string | void;
}) {
  const { t } = useI18n();
  const [errored, setErrored] = useState(false);
  const [editing, setEditing] = useState(false);
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
          <img className="gen-asset" src={asset.url} alt={name} onError={() => setErrored(true)} />
          {onEdit && (
            <button type="button" className="gen-asset-edit" onClick={() => setEditing(true)}>{t("编辑")}</button>
          )}
        </div>
      )}
      <DownloadLink href={asset.url} name={name} />
      {editing && onEdit && (
        <ImageEditDialog imageUrl={asset.url} size={settings?.size}
          onSubmit={(prompt) => onEdit(asset.url, prompt, settings)} onClose={() => setEditing(false)} />
      )}
    </div>
  );
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
function SetTile({ image, busy, onOpen, onEdit, onRedo }: {
  image: ViewerImage; busy?: boolean; onOpen: () => void; onEdit?: () => void; onRedo?: () => void;
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

type RedoHandler = (request: RedoRequest) => Promise<string | undefined>;

/** Several images from one generation in a single frame: a grid of tiles, an enlarged view, 重做 / 补齐 and 合成. */
function ImageSet({ generation, assets, onEdit, onCompose, onRedo, onExport }: {
  generation: GenerationView;
  assets: Asset[];
  onEdit?: (imageUrl: string, prompt: string, settings?: GenerationSettings) => string | void;
  onCompose?: ComposeHandler;
  onExport?: ExportHandler;
  /** Only for sets with a role per image (产品套图 / 主副图). */
  onRedo?: RedoHandler;
}) {
  const { t } = useI18n();
  const [viewing, setViewing] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmDialog, confirm] = useConfirm();
  const [composing, setComposing] = useState(false);
  const missing = generation.missing ?? 0;
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
  const start = async (request: RedoRequest, count: number) => {
    if (!onRedo || starting || running) return;
    const single = "index" in request;
    const ok = await confirm({
      title: single ? "重做这张图片" : "补齐缺少的图片",
      message: single ? "按原来的描述重新生成这一张，扣除 1 张图片的积分。" : "按原来的描述生成缺少的 {0} 张，扣除 {0} 张图片的积分。",
      values: [count],
      confirm: single ? "重做" : "补齐",
    });
    if (!ok) return;
    setStarting(true);
    setError(undefined);
    const failure = await onRedo(request);
    setStarting(false);
    if (failure) setError(failure);
  };
  const canRedo = !!onRedo && !running && !starting;
  return (
    <div className="gen-set">
      <div className="gen-set-stage" aria-busy={composing}>
        <div className="gen-set-grid">
          {images.map((image, index) => (
            <SetTile key={index} image={image} busy={running && redo.indexes.includes(index)} onOpen={() => setViewing(index)}
              onEdit={edit && (() => edit(index))} onRedo={canRedo ? () => start({ index }, 1) : undefined} />
          ))}
          {Array.from({ length: missing }, (_, i) => assets.length + i).map((index) => (
            <MissingTile key={`missing-${index}`} label={labelAt(index)} busy={running && redo.indexes.includes(index)}
              ratio={generation.settings?.ratio} />
          ))}
        </div>
        {/* While composing, the set is covered so nothing is clicked mid-way; it lifts when the picture is back. */}
        {composing && (
          <div className="gen-set-busy gen-set-busy--stage" role="status"><span className="gen-set-spinner" aria-hidden />{t("合成中…")}</div>
        )}
      </div>
      {missing > 0 && !running && (
        <div className="gen-set-fill">
          <p className="gen-card-notice" role="status">{t(generation.notice ?? "套图中有 {0} 张未生成成功", [missing])}</p>
          {canRedo && (
            <button type="button" className="gen-compose-toggle" onClick={() => start({ missing: true }, missing)}>
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
      <WhiteCheckNotes checks={generation.whiteChecks} />
      {exportAll && !running && <ExportMenu onExport={exportAll} />}
      {viewing !== null && (
        <ImageViewerDialog images={images} index={viewing} onIndexChange={setViewing} onClose={() => setViewing(null)} onEdit={edit} />
      )}
      {editing !== null && onEdit && (
        <ImageEditDialog imageUrl={assets[editing].url} size={generation.settings?.size}
          onSubmit={(prompt) => onEdit(assets[editing].url, prompt, generation.settings)} onClose={() => setEditing(null)} />
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
function WhiteCheckNotes({ checks }: { checks?: WhiteBackgroundCheck[] }) {
  const { t } = useI18n();
  if (!checks?.length) return null;
  const many = checks.length > 1;
  const issues = checks.flatMap((check, index) => check.issues.map((issue) => ({ index, issue })));
  const corrected = checks.some((check) => check.corrected);
  if (!issues.length && !corrected) return null;
  return (
    <div className="gen-white-notes" role="status">
      {corrected && <p>{t("背景已自动校正为纯白。")}</p>}
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
    url: item.url, label: labelOf(item), name: `${labelOf(item)}.${fileExtension(item.url, "jpg")}`,
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
}: {
  generation: GenerationView;
  messageId?: string;
  /** 打包下载 this generation's images; resolves to an error text. Undefined hides it. */
  onExport?: (messageId: string, preset: ExportPreset, names: string[], compositeNames: string[]) => Promise<string | undefined>;
  /** 重做 one image of a set or 补齐 its missing ones; resolves to an error text. Undefined hides both. */
  onRedo?: (messageId: string, request: RedoRequest) => Promise<string | undefined>;
  /** Join this generation's images into one picture; resolves to an error text. Undefined hides 合成. */
  onCompose?: (messageId: string, layout: ComposeLayout, gap: boolean) => Promise<string | undefined>;
  /** Edit a generated image: image-to-image with it as the reference and this
   * generation's settings. Returns an error to show in the editor; undefined hides the button. */
  onEditImage?: (imageUrl: string, prompt: string, settings?: GenerationSettings) => string | void;
  /** Retry only the download of a "下载失败" generation (vendor media already
   * succeeded). Undefined disables the re-download button. */
  onRedownload?: (messageId: string, mediaType: "image" | "video") => void;
}) {
  const { t } = useI18n();
  const { mediaType, status, assets, error, taskId } = generation;
  const [cancelRequested, setCancelRequested] = useState(false);

  if (status === "completed" && assets && assets.length > 0) {
    // Several images from one generation, or any 产品套图 / 主副图, share one frame; other single images and videos
    // keep their own card.
    const imageSet = !!imageSetRole(generation.scene, 0);
    if (mediaType === "image" && (assets.length >= COMPOSE_MIN_IMAGES || imageSet) && assets.every((a) => a.mime.startsWith("image/"))) {
      return (
        <ImageSet generation={generation} assets={assets} onEdit={onEditImage}
          onCompose={messageId && onCompose ? (layout, gap) => onCompose(messageId, layout, gap) : undefined}
          onRedo={messageId && onRedo && imageSet ? (request) => onRedo(messageId, request) : undefined}
          onExport={messageId && onExport ? (preset, names, compositeNames) => onExport(messageId, preset, names, compositeNames) : undefined} />
      );
    }
    const singleImage = mediaType === "image" && assets.length === 1 && assets[0].mime.startsWith("image/");
    return (
      <>
        <div className="gen-card-assets">
          {assets.map((a, i) => (
            <AssetView key={i} asset={a} mediaType={mediaType} index={i} settings={generation.settings}
              onEdit={mediaType === "image" && a.mime.startsWith("image/") ? onEditImage : undefined} />
          ))}
        </div>
        {generation.notice && <p className="gen-card-notice" role="status">{t(generation.notice)}</p>}
        {singleImage && <WhiteCheckNotes checks={generation.whiteChecks} />}
        {singleImage && messageId && onExport && (
          <ExportMenu onExport={(preset) => onExport(messageId, preset, [`${SINGLE_EXPORT_NAMES[generation.scene ?? ""] ?? "生成结果"}_01`], [])} />
        )}
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
  const resultUnknown = error === "生成状态获取失败" || status === "completed";
  const videoFailed = mediaType === "video" && failed;
  // The server classifies the vendor rejection; raw patterns cover older messages.
  const realPersonRejected = /REAL_PERSON_REJECTED|\.PrivacyInformation\b|may contain (?:a )?real person/i.test(error ?? "");
  const contentBlocked = /CONTENT_BLOCKED/.test(error ?? "");
  const showFailureHint = videoFailed || (failed && (realPersonRejected || contentBlocked));
  const failureHint = realPersonRejected
    ? "上传的参考图包含真人，需要先完成真人认证后再使用。"
    : contentBlocked
      ? "出图模型的安全审核拒绝了这次请求，常见原因是知名动漫或影视角色、品牌标志、真人或敏感内容。请换成自有产品的图片和描述后重试，这次不扣积分。"
    : resultUnknown
      ? "暂时无法确认视频生成结果，请刷新会话查看，或联系客服。"
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

  // Fire the cancel request; the ongoing task poll observes the terminal
  // 'cancelled' status and finalizes the card, so no local state juggling.
  const onCancel = () => {
    if (!taskId || cancelRequested) return;
    setCancelRequested(true);
    api.cancelTask(taskId).catch(() => setCancelRequested(false));
  };

  return (
    <div className={`gen-card ${mediaType} ${generating ? "gen-card--loading" : "gen-card--failed"}`} title={t(error) ?? undefined}>
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
      {generating && taskId && (
        <button type="button" className="gen-card-cancel" onClick={onCancel} disabled={cancelRequested}>
          {cancelRequested ? t("取消中…") : t("取消")}
        </button>
      )}
      {downloadFailed && messageId && onRedownload && (
        <button type="button" className="gen-card-retry" onClick={() => onRedownload(messageId, mediaType)}>
          {t("重新下载")}</button>
      )}
    </div>
  );
}
