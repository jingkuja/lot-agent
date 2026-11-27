import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  COMIC_VOICE_PROMPT_MAX, COMIC_VOICE_SAMPLE_BYTES, comicLibraryVoiceCreateSchema, type ComicLibraryVoice, type ComicLibraryVoiceList,
} from "@lot-agent/core/comic-drama";
import { ApiClientError, request } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { ComicVoiceAuditionPanel } from "./ComicVoiceAudition.js";
import { ComicVoiceDesignFields, voiceDesignPrompt } from "./ComicVoiceDesignFields.js";
import { LibraryDialog, LibraryPagination, LibrarySearch, MediaPreview } from "./LibraryParts.js";
import { editError } from "./edit-api.js";
import { comicLibraryApi } from "./library-api.js";

const root = "/comic-drama/voices";
const endpoint = (id: string) => root + "/" + encodeURIComponent(id);
export const comicVoiceStatusLabels: Record<ComicLibraryVoice["status"], string> = {
  OK: "可用于配音",
  DEPLOYING: "音色审核中",
  UNDEPLOYED: "音色审核未通过",
  unknown: "音色创建结果待核实",
  failed: "音色创建失败",
};

export function voiceError(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.code === "COMIC_VOICE_SAMPLE_INVALID") return "请使用 5–60 秒、采样率至少 16 kHz 的 MP3 或 16 位 WAV";
    if (error.code === "COMIC_VOICE_UNCONFIGURED") return "漫剧音色服务尚未配置";
  }
  return editError(error);
}

export function ComicVoiceLibrary({ tabs }: { tabs: ReactNode }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ComicLibraryVoiceList | null>(null);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [audition, setAudition] = useState<ComicLibraryVoice | null>(null);
  const [description, setDescription] = useState<ComicLibraryVoice | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const reload = () => setRefresh(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    setRows(null);
    const params = new URLSearchParams({ query, page: String(page), archived: String(archived) });
    void request<ComicLibraryVoiceList>(root + "?" + params, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setRows(data);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [query, page, archived, refresh]);

  const update = async (voice: ComicLibraryVoice, action: "refresh" | "archive") => {
    setBusyId(voice.id);
    setError("");
    try {
      if (action === "refresh") {
        const updated = await comicLibraryApi.refreshVoice(voice.id);
        setRows(current => current && { ...current, entries: current.entries.map(row => row.id === updated.id ? updated : row) });
      } else {
        await request(endpoint(voice.id), { method: "PATCH", body: JSON.stringify({ archived: !voice.archived }) });
        if (rows?.entries.length === 1 && page > 1) setPage(page - 1);
        reload();
      }
    } catch (reason) {
      setError(voiceError(reason));
    } finally {
      setBusyId(null);
    }
  };

  return <>
    <header className="comic-heading comic-material-heading"><h1>{t("素材库")}</h1>
      <button type="button" className="primary" disabled={!rows?.enabled} onClick={() => setCreating(true)}>＋ {t("创建音色")}</button>
    </header>
    {tabs}
    <LibrarySearch query={query} search={value => { setQuery(value); setPage(1); }} archived={archived}
      onArchived={value => { setArchived(value); setPage(1); }} placeholder={t("搜索音色名称或描述")} />
    {rows && !rows.enabled && <p role="status">{t("漫剧音色服务尚未配置")}</p>}
    {error && <p className="comic-error" role="alert">{t(error)}</p>}
    {failed ? <button type="button" onClick={reload}>{t("重新读取")}</button> : rows ? <>
      {rows.entries.length === 0 && <div className="comic-empty">{t("暂无匹配的音色")}</div>}
      <div className="comic-library-grid">{rows.entries.map(voice => <article className="comic-library-card comic-voice-card" key={voice.id}>
        <strong>{voice.name}</strong>
        <small role="status">{t(voice.kind === "design" ? "音色设计" : "本人语音复刻")} · {t(comicVoiceStatusLabels[voice.status])}</small>
        {voice.voicePrompt && <div className="comic-voice-card-description">
          <small>{voice.voicePrompt}</small>
          <button type="button" aria-haspopup="dialog" aria-label={t("更多") + " · " + voice.name} onClick={() => setDescription(voice)}>
            {t("更多")}
          </button>
        </div>}
        {voice.previewMediaId && voice.status !== "UNDEPLOYED" && <div className="comic-voice-card-preview">
          <MediaPreview media={{ id: voice.previewMediaId, hasThumbnail: false, durationMs: null }} title={voice.name} />
        </div>}
        <div className="comic-actions">
          {voice.status === "OK" && <button type="button" onClick={() => setAudition(voice)}>{t("试听音色")}</button>}
          {(voice.status === "DEPLOYING" || voice.status === "unknown") && <button type="button" disabled={!!busyId}
            onClick={() => void update(voice, "refresh")}>{t("刷新音色状态")}</button>}
          <button type="button" disabled={!!busyId} onClick={() => void update(voice, "archive")}>
            {t(voice.archived ? "取消归档" : "归档")}
          </button>
        </div>
      </article>)}</div>
      <LibraryPagination page={page} more={rows.more} change={setPage} />
    </> : <p role="status">{t("加载中…")}</p>}
    {creating && <CreateVoiceDialog close={() => { setCreating(false); reload(); }} created={() => {
      setArchived(false);
      setQuery("");
      setPage(1);
    }} />}
    {audition && <VoiceAuditionDialog voice={audition} close={() => setAudition(null)} />}
    {description && <VoiceDescriptionDialog voice={description} close={() => setDescription(null)} />}
  </>;
}

export function CreateVoiceDialog({ close, created, designOnly = false }: {
  close: () => void; created: (voice: ComicLibraryVoice) => void; designOnly?: boolean;
}) {
  const { t, locale } = useI18n();
  const [kind, setKind] = useState<ComicLibraryVoice["kind"]>("design");
  const [language, setLanguage] = useState<"zh" | "en">(locale === "zh" ? "zh" : "en");
  const [id] = useState(() => crypto.randomUUID());
  const name = (form: FormData, key: string) => String(form.get(key) ?? "");
  const label = t(designOnly ? "AI 生成配音音色" : "创建音色");
  return <LibraryDialog title={label} submitLabel={designOnly ? t("生成") : t("创建")} close={close} wide={kind === "design"} describeError={error =>
    error instanceof ApiClientError ? voiceError(error) : error instanceof Error ? error.message : t("操作失败，请重试")} save={async (form, signal) => {
    const fields = { id, kind, name: name(form, "name") };
    const voicePrompt = kind === "design" ? voiceDesignPrompt(form, language) : "";
    if (kind === "design" && !voicePrompt) throw new Error(t("请选择音色特征或填写补充描述"));
    if (voicePrompt.length > COMIC_VOICE_PROMPT_MAX) throw new Error(t("音色描述超过 {0} 字符，请精简补充描述", [COMIC_VOICE_PROMPT_MAX]));
    const input = comicLibraryVoiceCreateSchema.safeParse(kind === "design" ? {
      ...fields, language, voicePrompt, previewText: name(form, "text"),
      sampleRate: Number(form.get("sampleRate")), previewFormat: form.get("previewFormat"),
    } : { ...fields, ownVoice: form.get("ownVoice") === "on" });
    if (!input.success) {
      throw new Error(t(kind === "design" ? "请检查音色名称、中英文描述及与试听语言一致的 15–200 字台词" : "请填写音色名称并确认使用本人声音"));
    }
    const body = new FormData();
    body.set("fields", JSON.stringify(input.data));
    if (kind === "clone") {
      const sample = form.get("sample");
      if (!(sample instanceof File) || !sample.size || sample.size > COMIC_VOICE_SAMPLE_BYTES) {
        throw new Error(t("请选择 10 MB 以内的 MP3 或 WAV"));
      }
      body.set("sample", sample);
    }
    const voice = await comicLibraryApi.createVoice(body, signal).catch(reason => {
      if (reason instanceof ApiClientError) throw reason;
      throw new Error(t("提交结果待核实，请返回素材库查看音色状态"));
    });
    if (!signal.aborted) created(voice);
  }}>
    {!designOnly && <label className="comic-video-replace">
      <input type="checkbox" name="useOwnVoice" checked={kind === "clone"}
        onChange={event => setKind(event.target.checked ? "clone" : "design")} />
      {t("使用参考音效")}
    </label>}
    <label>{t("音色名称")}<input name="name" autoFocus required maxLength={120} /></label>
    {kind === "design" ? <ComicVoiceDesignFields language={language} setLanguage={setLanguage} /> : <>
      <label>{t("上传本人录音")}<input type="file" name="sample" required accept=".mp3,.wav,audio/mpeg,audio/wav" /></label>
      <small>{t("MP3 或 16 位 WAV，5–60 秒，最多 10 MB。建议录制 10–20 秒清晰人声。")}</small>
      <label className="comic-video-replace"><input type="checkbox" name="ownVoice" required />
        {t("这是我的声音，我同意将录音发送给阿里云百炼，用于复刻漫剧配音。")}
      </label>
    </>}
  </LibraryDialog>;
}

function VoiceDescriptionDialog({ voice, close }: { voice: ComicLibraryVoice; close: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  const dismiss = () => {
    dialog.current?.close();
    close();
  };
  return <dialog className="comic-dialog" ref={dialog} aria-labelledby={title} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <h2 id={title}>{voice.name}</h2>
    <p className="comic-voice-description">{voice.voicePrompt}</p>
    <div className="comic-actions comic-dialog-actions"><button type="button" onClick={dismiss}>{t("关闭")}</button></div>
  </dialog>;
}

function VoiceAuditionDialog({ voice, close }: { voice: ComicLibraryVoice; close: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="comic-dialog" ref={dialog} aria-label={t("配音试听")} onCancel={event => { event.preventDefault(); close(); }}>
    <h2>{voice.name}</h2>
    <ComicVoiceAuditionPanel voice={{ kind: "library", voiceId: voice.id }} initialText={voice.previewText ?? undefined} />
    <div className="comic-actions comic-dialog-actions"><button type="button" onClick={close}>{t("关闭")}</button></div>
  </dialog>;
}
