import { useEffect, useState } from "react";
import { comicSpeechPresets, type ComicVoiceBind, type ComicVoiceSettings } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicEditApi, editError } from "./edit-api.js";
import { LibraryDialog } from "./LibraryParts.js";

export function ComicCharacterVoice({ id, close }: { id: string; close: () => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<ComicVoiceSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<ComicVoiceBind["kind"]>("none");
  useEffect(() => {
    const controller = new AbortController();
    void comicEditApi.voice(id, controller.signal).then(data => {
      if (!controller.signal.aborted) { setKind(data.binding.kind); setSettings(data); }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [id]);
  const bound = settings?.binding.kind === "clone" ? settings.binding.itemId : "";
  return <LibraryDialog title={t("绑定角色音色")} submitLabel={t("保存")} close={close} describeError={editError} save={async (form, signal) => {
    if (!settings) throw new Error("Voice settings unavailable");
    let binding: ComicVoiceBind = { kind: "none" };
    if (kind === "preset") {
      const preset = comicSpeechPresets.find(key => key === form.get("preset"));
      if (!preset) throw new Error("Missing preset voice");
      binding = { kind, preset };
    } else if (kind === "clone") {
      if (form.get("authorized") !== "on") throw new Error("Missing authorization");
      binding = { kind, itemId: String(form.get("itemId") ?? ""), authorized: true };
    }
    await comicEditApi.bindVoice(id, binding, signal);
  }}>
    {settings ? <>
      <label>{t("音色来源")}<select value={kind} onChange={event => {
        if (event.target.value === "preset" || event.target.value === "clone" || event.target.value === "none") setKind(event.target.value);
      }}>
        <option value="none">{t("不绑定音色")}</option>
        <option value="preset" disabled={!settings.presets.length}>{t("预置音色")}</option>
        <option value="clone" disabled={!settings.clonesEnabled}>{t("已有复刻音色")}</option>
      </select></label>
      {kind === "preset" && <label>{t("配音音色")}<select name="preset" required
        defaultValue={settings.binding.kind === "preset" ? settings.binding.preset : ""}>
        <option value="">{t("请选择")}</option>{settings.presets.map(preset => <option key={preset} value={preset}>{preset}</option>)}
      </select></label>}
      {kind === "clone" && <>
        <label>{t("已有复刻音色")}<select name="itemId" required defaultValue={bound}>
          <option value="">{t("请选择")}</option>
          {bound && !settings.clones.some(voice => voice.id === bound) && <option value={bound}>{t("当前绑定音色")}</option>}
          {settings.clones.map(voice => <option key={voice.id} value={voice.id}>{voice.title}</option>)}
        </select></label>
        <label className="comic-video-replace"><input name="authorized" type="checkbox" required />
          {t("我已获得此音色在漫剧中使用的授权")}
        </label>
      </>}
    </> : <p role={failed ? "alert" : "status"}>{t(failed ? "操作失败，请重试" : "加载中…")}</p>}
  </LibraryDialog>;
}
