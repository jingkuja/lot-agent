import { useCallback, useEffect, useState } from "react";
import {
  COMIC_SPEECH_PRESET_CATALOG,
  comicSpeechPresets,
  type ComicCharacterDesignVoice,
  type ComicCharacterDetail,
  type ComicSpeechPresetMeta,
  type ComicVoiceAudition,
  type ComicVoiceBind,
  type ComicVoiceSettings,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicEditApi, editError } from "./edit-api.js";
import { LibraryDialog } from "./LibraryParts.js";
import { ComicVoiceAuditionPanel } from "./ComicVoiceAudition.js";
import { ComicCharacterVoiceDesign, comicCharacterVoicePending } from "./ComicCharacterVoiceDesign.js";

export function presetVoiceLabel(
  id: string,
  locale: "zh" | "en" | "id",
  catalog: readonly ComicSpeechPresetMeta[] = COMIC_SPEECH_PRESET_CATALOG,
) {
  const entry = catalog.find(item => item.id === id)
    ?? COMIC_SPEECH_PRESET_CATALOG.find(item => item.id === id);
  return entry ? entry.labels[locale] : id;
}

export function ComicCharacterVoice({ character, close, onBound }: { character: ComicCharacterDetail; close: () => void; onBound: () => void }) {
  const { t, locale } = useI18n();
  const { id } = character;
  const [settings, setSettings] = useState<ComicVoiceSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<ComicVoiceBind["kind"]>("none");
  const [preset, setPreset] = useState("");
  const [cloneId, setCloneId] = useState("");
  const [libraryVoiceId, setLibraryVoiceId] = useState("");
  const [candidate, selectVoice] = useState<ComicCharacterDesignVoice | null>(null);
  const [generating, setGenerating] = useState(false);
  const onVoiceReady = useCallback(({ id, name }: ComicCharacterDesignVoice) => {
    setSettings(current => current && {
      ...current,
      libraryVoices: [...(current.libraryVoices ?? []).filter(voice => voice.id !== id), { id, name, kind: "design" }],
    });
    setKind("library");
    setLibraryVoiceId(id);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void comicEditApi.voice(id, controller.signal).then(data => {
      if (!controller.signal.aborted) {
        setKind(data.binding.kind);
        setPreset(data.binding.kind === "preset" && data.presets.includes(data.binding.preset) ? data.binding.preset : data.presets[0] ?? "");
        setCloneId(data.binding.kind === "clone" ? data.binding.itemId : data.clones[0]?.id ?? "");
        setLibraryVoiceId(data.binding.kind === "library" ? data.binding.voiceId : data.libraryVoices?.[0]?.id ?? "");
        setSettings(data);
      }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [id]);

  const catalog = settings?.presetCatalog ?? COMIC_SPEECH_PRESET_CATALOG.filter(item => settings?.presets.includes(item.id));
  const selectedPreset = catalog.find(item => item.id === preset);
  const bound = settings?.binding.kind === "clone" ? settings.binding.itemId : "";
  const voices = settings?.libraryVoices ?? [];
  const boundLibrary = settings?.binding.kind === "library" ? settings.binding.voiceId : "";
  const selectedLibrary = voices.find(voice => voice.id === libraryVoiceId);
  const selectedPresetId = comicSpeechPresets.find(id => id === preset);
  let auditionVoice: ComicVoiceAudition["voice"] | null = null;
  if (kind === "preset" && selectedPresetId) auditionVoice = { kind, preset: selectedPresetId };
  if (kind === "clone" && cloneId) auditionVoice = { kind, itemId: cloneId };
  if (kind === "library" && selectedLibrary) auditionVoice = { kind, voiceId: selectedLibrary.id };

  return <LibraryDialog title={t("绑定角色音色")} submitLabel={t("保存")} close={close} describeError={editError}
    submitDisabled={!settings || generating || comicCharacterVoicePending(candidate)} save={async (form, signal) => {
    if (!settings) throw new Error("Voice settings unavailable");
    let binding: ComicVoiceBind = { kind: "none" };
    if (kind === "preset") {
      const chosen = comicSpeechPresets.find(key => key === form.get("preset"));
      if (!chosen) throw new Error("Missing preset voice");
      binding = { kind, preset: chosen };
    } else if (kind === "clone") {
      if (form.get("authorized") !== "on") throw new Error("Missing authorization");
      binding = { kind, itemId: String(form.get("itemId") ?? ""), authorized: true };
    } else if (kind === "library") {
      binding = { kind, voiceId: libraryVoiceId };
    }
    await comicEditApi.bindVoice(id, binding, signal);
    if (!signal.aborted) onBound();
  }}>
    {settings ? <>
      <label>{t("音色来源")}<select value={kind} onChange={event => {
        const value = event.target.value;
        if (value === "preset" || value === "clone" || value === "none" || value === "library") setKind(value);
      }}>
        <option value="none">{t("不绑定音色")}</option>
        <option value="preset" disabled={!settings.presets.length}>{t("预置音色")}</option>
        <option value="clone" disabled={!settings.clonesEnabled}>{t("已有复刻音色")}</option>
        <option value="library" disabled={!voices.length && !boundLibrary}>{t("人物配音素材")}</option>
      </select></label>
      {kind === "library" && <label>{t("配音音色")}<select required value={libraryVoiceId} onChange={event => setLibraryVoiceId(event.target.value)}>
        <option value="">{t("请选择")}</option>
        {boundLibrary && !voices.some(voice => voice.id === boundLibrary) && <option value={boundLibrary}>{t("当前绑定音色")}</option>}
        {voices.map(voice => <option key={voice.id} value={voice.id}>
          {voice.name} · {t(voice.kind === "design" ? "音色设计" : "本人语音复刻")}
        </option>)}
      </select></label>}
      {kind === "preset" && <>
        <label>{t("配音音色")}<select name="preset" required value={preset} onChange={event => setPreset(event.target.value)}>
          <option value="">{t("请选择")}</option>
          {catalog.map(item => <option key={item.id} value={item.id}>{item.labels[locale]}</option>)}
        </select></label>
        {selectedPreset && <small className="comic-generation-note">{selectedPreset.summary[locale]}</small>}
      </>}
      {kind === "clone" && <>
        <label>{t("已有复刻音色")}<select name="itemId" required value={cloneId} onChange={event => setCloneId(event.target.value)}>
          <option value="">{t("请选择")}</option>
          {bound && !settings.clones.some(voice => voice.id === bound) && <option value={bound}>{t("当前绑定音色")}</option>}
          {settings.clones.map(voice => <option key={voice.id} value={voice.id}>{voice.title}</option>)}
        </select></label>
        <label className="comic-video-replace"><input name="authorized" type="checkbox" required />
          {t("我已获得此音色在漫剧中使用的授权")}
        </label>
      </>}
      <ComicCharacterVoiceDesign character={character} existing={character.designVoice} candidate={candidate} select={selectVoice}
        generating={generating} setGenerating={setGenerating} onReady={onVoiceReady} />
      <ComicVoiceAuditionPanel voice={auditionVoice} />
    </> : <p role={failed ? "alert" : "status"}>{t(failed ? "操作失败，请重试" : "加载中…")}</p>}
  </LibraryDialog>;
}
