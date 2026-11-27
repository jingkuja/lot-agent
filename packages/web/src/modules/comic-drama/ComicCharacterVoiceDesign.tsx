import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  comicCharacterVoiceDesignInput, type ComicCharacterDesignVoice, type ComicCharacterVoiceDesignInput,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicVoiceStatusLabels } from "./ComicVoiceLibrary.js";
import { libraryError, MediaPreview } from "./LibraryParts.js";
import { comicLibraryApi } from "./library-api.js";

export const comicCharacterVoicePending = (voice: ComicCharacterDesignVoice | null) =>
  voice?.status === "DEPLOYING" || voice?.status === "unknown";

export function ComicCharacterVoiceDesign({ character, existing, candidate, select, generating, setGenerating, onReady }: {
  character: ComicCharacterVoiceDesignInput["character"];
  existing?: ComicCharacterDesignVoice | null;
  candidate: ComicCharacterDesignVoice | null;
  select: Dispatch<SetStateAction<ComicCharacterDesignVoice | null>>;
  generating: boolean;
  setGenerating: (generating: boolean) => void;
  onReady: (voice: ComicCharacterDesignVoice) => void;
}) {
  const { t, locale } = useI18n();
  const [error, setError] = useState("");
  const [recheck, setRecheck] = useState(0);
  const generation = useRef<AbortController | null>(null);
  const retryId = useRef<string | null>(null);
  const pendingId = comicCharacterVoicePending(candidate) ? candidate?.id : undefined;

  useEffect(() => () => generation.current?.abort(), []);
  useEffect(() => {
    if (!pendingId) return;
    const controller = new AbortController();
    let checks = 0;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await comicLibraryApi.refreshCharacterVoice(pendingId, controller.signal);
        if (controller.signal.aborted) return;
        setError("");
        select(current => current?.id === result.id ? result : current);
        if (result.status === "OK") onReady(result);
        if (comicCharacterVoicePending(result) && ++checks < 6) timer = setTimeout(refresh, 3000);
      } catch (error) {
        if (!controller.signal.aborted) setError(libraryError(error));
      }
    };
    timer = setTimeout(refresh, recheck ? 0 : 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pendingId, recheck, select, onReady]);

  const generate = async () => {
    if (generation.current) return;
    const { name, gender, age, personality, appearance, roleKey, tags } = character;
    const input = comicCharacterVoiceDesignInput.safeParse({
      id: retryId.current ?? crypto.randomUUID(), language: locale === "zh" ? "zh" : "en",
      character: { name, gender, age, personality, appearance, roleKey, tags },
    });
    if (!input.success) { setError("请检查字段内容及长度"); return; }
    const controller = new AbortController();
    generation.current = controller;
    retryId.current = input.data.id;
    setGenerating(true);
    setError("");
    setRecheck(0);
    try {
      const result = await comicLibraryApi.designCharacterVoice(input.data, controller.signal);
      if (!controller.signal.aborted) {
        retryId.current = null;
        select(result);
        if (result.status === "OK") onReady(result);
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(libraryError(error));
    } finally {
      generation.current = null;
      if (!controller.signal.aborted) setGenerating(false);
    }
  };

  const voice = candidate ?? existing;
  return <section className="comic-subcard comic-character-voice-design" aria-label={t("AI 配音")}>
    <strong>{t("AI 配音")}</strong>
    <small>{t("根据已保存的角色资料生成音色。音色就绪后，点击保存即可绑定。")}</small>
    <div className="comic-actions">
      <button type="button" disabled={generating || !!pendingId} onClick={() => void generate()}>
        {t(generating ? "生成中…" : voice ? "重新生成音色" : "AI 生成配音音色")}
      </button>
      {pendingId && <button type="button" onClick={() => setRecheck(value => value + 1)}>{t("刷新音色状态")}</button>}
      {pendingId && <button type="button" onClick={() => { select(null); setError(""); }}>
        {t("暂不绑定此音色")}
      </button>}
    </div>
    {error && <small className="comic-error" role="alert">{t(error)}</small>}
    {voice && <>
      <small role="status">{voice.name} · {t(comicVoiceStatusLabels[voice.status])}</small>
      {voice.voiceId && <small>{t("音色 ID")} <code>{voice.voiceId}</code></small>}
      {voice.previewMediaId && voice.status !== "UNDEPLOYED" && <MediaPreview
        media={{ id: voice.previewMediaId, hasThumbnail: false, durationMs: null }} title={t("配音试听")} />}
    </>}
  </section>;
}
