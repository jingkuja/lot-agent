import { useEffect, useState } from "react";
import type { ComicCharacter, ComicCharacterDetail, ComicFrameSaveRequest } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicGenerationApi } from "./generation-api.js";
import { comicLibraryApi } from "./library-api.js";
import { ChoiceSelect, LibraryDialog } from "./LibraryParts.js";

export function SaveComicFrame({ take, initialTime, close, saved }: {
  take: { id: string; durationMs: number }; initialTime: number; close: () => void; saved: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"material" | "expression" | "slot">("material");
  const [query, setQuery] = useState("");
  const [roles, setRoles] = useState<ComicCharacter[]>([]);
  const [roleId, setRoleId] = useState("");
  const [character, setCharacter] = useState<ComicCharacterDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (mode === "material") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void comicLibraryApi.characters({ query }, controller.signal).then(page => {
        if (!controller.signal.aborted) { setRoles(page.entries); setFailed(false); }
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, query]);
  useEffect(() => {
    if (mode !== "slot" || !roleId) return;
    const controller = new AbortController();
    void comicLibraryApi.character(roleId, controller.signal).then(row => {
      if (!controller.signal.aborted) setCharacter(row);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [mode, roleId]);
  const outfits = character?.id === roleId ? character.outfits : [];
  return <LibraryDialog title={t("截帧另存")} submitLabel={t("保存")} close={close} save={async (data, signal) => {
    const value = (key: string) => String(data.get(key) ?? "").trim();
    const timeMs = Math.round(Number(value("time")) * 1000);
    const kind = value("materialKind");
    let destination: ComicFrameSaveRequest["destination"];
    if (mode === "material") {
      destination = { kind: mode, material: { kind: kind === "scene" || kind === "prop" ? kind : "other", name: value("name"),
        categoryKey: null, tags: [] } };
    } else {
      const key = value("key");
      destination = { kind: "character", characterId: roleId, target: mode === "slot" ?
        { kind: "slot", key, outfitId: value("outfit") } : { kind: "expression", key } };
    }
    await comicGenerationApi.saveFrame(take.id, { timeMs, destination }, signal);
    if (!signal.aborted) saved();
  }}>
    <label>{t("截帧时间（秒）")}<input name="time" type="number" min={0} max={(take.durationMs - 1) / 1000}
      step={0.001} defaultValue={(initialTime / 1000).toFixed(3)} required /></label>
    <label>{t("保存位置")}<select value={mode} onChange={event => {
      const next = event.target.value;
      if (next === "material" || next === "expression" || next === "slot") setMode(next);
    }}>
      <option value="material">{t("素材库")}</option><option value="expression">{t("角色表情")}</option><option value="slot">{t("角色造型")}</option>
    </select></label>
    {mode === "material" ? <>
      <label>{t("素材名称")}<input name="name" maxLength={120} required /></label>
      <label>{t("素材类型")}<select name="materialKind">
        <option value="scene">{t("场景")}</option><option value="prop">{t("道具")}</option><option value="other">{t("其他")}</option>
      </select></label>
    </> : <>
      <label>{t("搜索名称或标签")}<input value={query} maxLength={120} onChange={event => {
        setRoleId(""); setQuery(event.target.value);
      }} /></label>
      <label>{t("角色名称")}<select value={roleId} onChange={event => setRoleId(event.target.value)} required>
        <option value="">{t("请选择")}</option>{roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
      </select></label>
      {mode === "slot" && <label>{t("造型套装")}<select name="outfit" required defaultValue="">
        <option value="">{t("请选择")}</option>{outfits.map(outfit => <option key={outfit.id} value={outfit.id}>{outfit.name}</option>)}
      </select></label>}
      <label>{t(mode === "slot" ? "造型槽位" : "表情")}<ChoiceSelect key={mode} name="key" domain={mode} required empty={t("请选择")} /></label>
      {failed && <p role="alert">{t("读取角色失败，请重试")}</p>}
    </>}
  </LibraryDialog>;
}
