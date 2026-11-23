import { useEffect, useRef, useState } from "react";
import {
  COMIC_SPEECH_PRESET_CATALOG, comicSpeechPresets, type ComicSpeechTake, type ComicVoiceAudition, type ComicVoiceBind, type ComicVoiceSettings,
} from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { comicEditApi, editError } from "./edit-api.js";
import { DictionaryOptions, LibraryDialog, MediaPreview, useComicChoices } from "./LibraryParts.js";

export function presetVoiceLabel(id: string, locale: "zh" | "en" | "id") {
  const entry = COMIC_SPEECH_PRESET_CATALOG.find(item => item.id === id);
  return entry ? entry.labels[locale] : id;
}

export function ComicCharacterVoice({ id, close }: { id: string; close: () => void }) {
  const { t, locale } = useI18n();
  const emotions = useComicChoices("emotion");
  const [settings, setSettings] = useState<ComicVoiceSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<ComicVoiceBind["kind"]>("none");
  const [preset, setPreset] = useState("");
  const [cloneId, setCloneId] = useState("");
  const [sampleText, setSampleText] = useState("");
  const [speed, setSpeed] = useState(1);
  const [emotionKey, setEmotionKey] = useState("");
  const [auditioning, setAuditioning] = useState(false);
  const [auditionError, setAuditionError] = useState("");
  const [auditionUnknown, setAuditionUnknown] = useState(false);
  const [auditionTake, setAuditionTake] = useState<ComicSpeechTake | null>(null);
  const activeAudition = useRef<AbortController | null>(null);

  useEffect(() => () => activeAudition.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    void comicEditApi.voice(id, controller.signal).then(data => {
      if (!controller.signal.aborted) {
        setKind(data.binding.kind);
        setPreset(data.binding.kind === "preset" ? data.binding.preset : data.presets[0] ?? "");
        setCloneId(data.binding.kind === "clone" ? data.binding.itemId : data.clones[0]?.id ?? "");
        setSettings(data);
      }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [id]);

  const catalog = settings?.presetCatalog ?? COMIC_SPEECH_PRESET_CATALOG.filter(item => settings?.presets.includes(item.id));
  const selectedPreset = catalog.find(item => item.id === preset);
  const bound = settings?.binding.kind === "clone" ? settings.binding.itemId : "";
  const defaultSample = t("雨停之前，我们把剩下的故事说完吧。");

  const currentAuditionPayload = (): ComicVoiceAudition | null => {
    if (kind === "none") return null;
    let voice: ComicVoiceAudition["voice"] | null = null;
    if (kind === "preset") {
      const matched = comicSpeechPresets.find(key => key === preset);
      if (matched) voice = { kind: "preset", preset: matched };
    } else if (kind === "clone" && cloneId) {
      voice = { kind: "clone", itemId: cloneId };
    }
    if (!voice) return null;
    return { text: sampleText.trim() || defaultSample, speed, emotionKey: emotionKey || null, voice };
  };

  const runAudition = async () => {
    if (activeAudition.current) return;
    const payload = currentAuditionPayload();
    if (!payload) return;
    const controller = new AbortController();
    activeAudition.current = controller;
    setAuditioning(true);
    setAuditionError("");
    setAuditionUnknown(false);
    try {
      const take = await comicEditApi.auditionVoice(payload, controller.signal);
      if (!controller.signal.aborted) setAuditionTake(take);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setAuditionError(editError(reason));
        setAuditionUnknown(reason instanceof ApiClientError && reason.code === "EDIT_SPEECH_UNKNOWN");
      }
    } finally {
      activeAudition.current = null;
      if (!controller.signal.aborted) setAuditioning(false);
    }
  };

  const releaseAudition = async () => {
    if (activeAudition.current) return;
    const payload = currentAuditionPayload();
    if (!payload) return;
    if (!window.confirm(t("原配音请求可能已扣费。释放后可重新合成，新请求可能再次扣费。确认释放？"))) return;
    const controller = new AbortController();
    activeAudition.current = controller;
    setAuditioning(true);
    setAuditionError("");
    try {
      await comicEditApi.releaseAuditionVoice({ ...payload, acknowledgePossibleCharge: true }, controller.signal);
      if (!controller.signal.aborted) setAuditionUnknown(false);
    } catch (reason) {
      if (!controller.signal.aborted) setAuditionError(editError(reason));
    } finally {
      activeAudition.current = null;
      if (!controller.signal.aborted) setAuditioning(false);
    }
  };

  return <LibraryDialog title={t("绑定角色音色")} submitLabel={t("保存")} close={close} describeError={editError} save={async (form, signal) => {
    if (!settings) throw new Error("Voice settings unavailable");
    let binding: ComicVoiceBind = { kind: "none" };
    if (kind === "preset") {
      const chosen = comicSpeechPresets.find(key => key === form.get("preset"));
      if (!chosen) throw new Error("Missing preset voice");
      binding = { kind, preset: chosen };
    } else if (kind === "clone") {
      if (form.get("authorized") !== "on") throw new Error("Missing authorization");
      binding = { kind, itemId: String(form.get("itemId") ?? ""), authorized: true };
    }
    await comicEditApi.bindVoice(id, binding, signal);
  }}>
    {settings ? <>
      <label>{t("音色来源")}<select value={kind} onChange={event => {
        if (event.target.value === "preset" || event.target.value === "clone" || event.target.value === "none") {
          setKind(event.target.value);
          setAuditionTake(null);
          setAuditionError("");
        }
      }}>
        <option value="none">{t("不绑定音色")}</option>
        <option value="preset" disabled={!settings.presets.length}>{t("预置音色")}</option>
        <option value="clone" disabled={!settings.clonesEnabled}>{t("已有复刻音色")}</option>
      </select></label>
      {kind === "preset" && <>
        <label>{t("配音音色")}<select name="preset" required value={preset} onChange={event => { setPreset(event.target.value); setAuditionTake(null); }}>
          <option value="">{t("请选择")}</option>
          {catalog.map(item => <option key={item.id} value={item.id}>{item.labels[locale]}</option>)}
        </select></label>
        {selectedPreset && <small className="comic-generation-note">{selectedPreset.summary[locale]}</small>}
      </>}
      {kind === "clone" && <>
        <label>{t("已有复刻音色")}<select name="itemId" required value={cloneId} onChange={event => { setCloneId(event.target.value); setAuditionTake(null); }}>
          <option value="">{t("请选择")}</option>
          {bound && !settings.clones.some(voice => voice.id === bound) && <option value={bound}>{t("当前绑定音色")}</option>}
          {settings.clones.map(voice => <option key={voice.id} value={voice.id}>{voice.title}</option>)}
        </select></label>
        <label className="comic-video-replace"><input name="authorized" type="checkbox" required />
          {t("我已获得此音色在漫剧中使用的授权")}
        </label>
      </>}
      {kind !== "none" && (
        <section className="comic-subcard comic-voice-audition">
          <strong>{t("音色试听")}</strong>
          <label>{t("试听台词")}<input maxLength={300} value={sampleText} placeholder={defaultSample}
            onChange={event => setSampleText(event.target.value)} /></label>
          <div className="comic-fields">
            <label>{t("情绪")}<DictionaryOptions choices={emotions} value={emotionKey} existing={emotionKey} empty="—"
              onChange={event => setEmotionKey(event.target.value)} /></label>
            <label>{t("语速")}<select value={speed} onChange={event => setSpeed(Number(event.target.value))}>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map(val => <option key={val} value={val}>{val}×</option>)}
            </select></label>
          </div>
          <div className="comic-actions">
            <button type="button" disabled={auditioning || (kind === "preset" ? !preset : !cloneId)} onClick={() => void runAudition()}>
              {t(auditioning ? "正在合成…" : "试听音色")}
            </button>
            {auditionUnknown && (
              <button type="button" disabled={auditioning} onClick={() => void releaseAudition()}>
                {t("释放旧提交")}
              </button>
            )}
            {auditionTake?.cached && <small>{t("已复用缓存")}</small>}
          </div>
          {auditionError && <p className="comic-error" role="alert">{t(auditionError)}</p>}
          {auditionTake && <MediaPreview key={auditionTake.mediaId}
            media={{ id: auditionTake.mediaId, hasThumbnail: false, durationMs: auditionTake.durationMs }} title={t("配音试听")} />}
        </section>
      )}
    </> : <p role={failed ? "alert" : "status"}>{t(failed ? "操作失败，请重试" : "加载中…")}</p>}
  </LibraryDialog>;
}
