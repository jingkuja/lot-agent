import { useCallback, useEffect, useState } from "react";
import type {
  ComicCharacter, ComicCharacterAsset, ComicCharacterDetail, ComicCharacterInput, ComicCharacterUpload, ComicGenerationQuote,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicLibraryApi } from "./library-api.js";
import { comicGenerationApi } from "./generation-api.js";
import { ComicCharacterVoice } from "./ComicCharacterVoice.js";
import { GenerationQuoteDialog } from "./GenerationQuoteDialog.js";
import { ComicTakeStatus, ImageTakeActions, useGenerationHistory } from "./GenerationHistory.js";
import { ChoiceSelect, comicListWords, libraryError, LibraryDialog, LibraryPagination, LibrarySearch, MediaPreview, MediaVersions, useComicChoices } from "./LibraryParts.js";

const images = "image/jpeg,image/png,image/webp";

export function CharacterLibrary({ characterId, open }: { characterId?: string; open: (id?: string) => void }) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<Awaited<ReturnType<typeof comicLibraryApi.characters>> | "error" | null>(null);
  const [detail, setDetail] = useState<ComicCharacterDetail | "error" | null>(null);
  const [creating, setCreating] = useState(false);
  const roles = useComicChoices("role");
  const roleName = (role: string | null) => roles.find(row => row.key === role)?.labels[locale] ?? role;
  const reload = () => setRefresh(i => i + 1);
  useEffect(() => {
    const controller = new AbortController();
    if (characterId) {
      setDetail(null);
      void comicLibraryApi.character(characterId, controller.signal).then(character => {
        if (!controller.signal.aborted) setDetail(character);
      }).catch(() => { if (!controller.signal.aborted) setDetail("error"); });
    } else {
      setList(null);
      void comicLibraryApi.characters({ query, archived: String(archived), page: String(page) }, controller.signal).then(rows => {
        if (!controller.signal.aborted) setList(rows);
      }).catch(() => { if (!controller.signal.aborted) setList("error"); });
    }
    return () => controller.abort();
  }, [characterId, query, archived, page, refresh]);

  return <>
    {characterId ? <>
      <div className="comic-library-back"><button type="button" onClick={() => open()}>{t("返回角色素材库")}</button></div>
      {detail === "error" ? <button onClick={reload}>{t("重新读取")}</button> : detail?.id === characterId ?
        <CharacterAssets key={detail.id} character={detail} roleName={roleName(detail.roleKey)} changed={setDetail} onArchive={() => open()} /> :
        <p role="status">{t("加载中…")}</p>}
    </> : <>
      <header className="comic-heading"><h1>{t("角色素材库")}</h1>
        <button className="primary" onClick={() => setCreating(true)}>＋ {t("新建角色")}</button>
      </header>
      <LibrarySearch query={query} search={value => { setQuery(value); setPage(1); }} archived={archived}
        onArchived={value => { setArchived(value); setPage(1); }} />
      {list === "error" ? <button onClick={reload}>{t("重新读取")}</button> : list ? <>
        {list.entries.length === 0 && <div className="comic-empty">{t("暂无匹配的角色")}</div>}
        <div className="comic-library-grid">
          {list.entries.map(character => <article className="comic-library-card" key={character.id}>
            {character.cover ? <MediaPreview key={character.cover.id} media={character.cover} title={character.name} thumbOnly /> :
              <div className="comic-media-well comic-character-initial" aria-hidden="true">{Array.from(character.name)[0]}</div>}
            <button className="comic-library-title" onClick={() => open(character.id)}>{character.name}</button>
            <small>{[roleName(character.roleKey), ...character.aliases].filter(Boolean).join(" · ")}</small>
          </article>)}
        </div>
        <LibraryPagination page={page} more={list.more} change={setPage} />
      </> : <p role="status">{t("加载中…")}</p>}
    </>}
    {creating && <CharacterForm close={() => setCreating(false)} save={async input => {
      const { id } = await comicLibraryApi.createCharacter(input);
      open(id);
    }} />}
  </>;
}

function CharacterForm({ character, close, save }: {
  character?: ComicCharacter; close: () => void; save: (input: ComicCharacterInput) => Promise<void>;
}) {
  const { t } = useI18n();
  return <LibraryDialog title={t(character ? "编辑角色" : "新建角色")} submitLabel={t("保存")} close={close} save={form => {
    const field = (name: string) => String(form.get(name) ?? "").trim();
    return save({
      name: field("name"), aliases: comicListWords(field("aliases")), tags: comicListWords(field("tags")), roleKey: field("role") || null,
      age: field("age"), personality: field("personality"), appearance: field("appearance"),
    });
  }}>
    <label>{t("角色名称")}<input name="name" autoFocus required maxLength={120} defaultValue={character?.name} /></label>
    <div className="comic-fields">
      <label>{t("角色定位")}<ChoiceSelect domain="role" name="role" existing={character?.roleKey} defaultValue={character?.roleKey ?? ""}
        empty={t("未分类")} /></label>
      <label>{t("年龄")}<input name="age" maxLength={120} defaultValue={character?.age} /></label>
      <label>{t("别名")}<input name="aliases" maxLength={2400} defaultValue={character?.aliases.join(", ")} placeholder={t("用逗号分隔")} /></label>
      <label>{t("标签")}<input name="tags" maxLength={2400} defaultValue={character?.tags.join(", ")} placeholder={t("用逗号分隔")} /></label>
    </div>
    <label>{t("性格")}<textarea name="personality" maxLength={2000} rows={2} defaultValue={character?.personality} /></label>
    <label>{t("外貌设定")}<textarea name="appearance" maxLength={2000} rows={3} defaultValue={character?.appearance} /></label>
  </LibraryDialog>;
}

function CharacterAssets({ character, roleName, changed, onArchive }: {
  character: ComicCharacterDetail; roleName: string | null; changed: (character: ComicCharacterDetail) => void; onArchive: () => void;
}) {
  const { locale, t } = useI18n();
  const [kind, setKind] = useState<"slot" | "expression">("slot");
  const [outfitId, setOutfit] = useState("");
  const [dialog, setDialog] = useState<"edit" | "outfit" | "upload" | "generate" | "voice" | null>(null);
  const [versionTarget, setVersionTarget] = useState<ComicCharacterUpload | null>(null);
  const [fee, setFee] = useState<{ quote: ComicGenerationQuote; label: string } | null>(null);
  const [error, setError] = useState("");
  const slots = useComicChoices("slot");
  const expressions = useComicChoices("expression");
  const choices = kind === "slot" ? slots : expressions;
  const outfit = character.outfits.find(entry => entry.id === outfitId) ?? character.outfits[0];
  const rows = character.assets.filter(asset => asset.kind === kind && (kind === "expression" || asset.outfitId === outfit?.id));
  const reload = async () => changed(await comicLibraryApi.character(character.id));
  const generationScope = { resource: "characters", id: character.id } as const;
  const loadTakes = useCallback((signal: AbortSignal) => comicGenerationApi.characterTakes(character.id, signal), [character.id]);
  const generation = useGenerationHistory(loadTakes);
  const latestGenerated = generation.current?.find(take => take.state === "ready")?.id;
  useEffect(() => {
    if (!latestGenerated) return;
    const controller = new AbortController();
    void comicLibraryApi.character(character.id, controller.signal).then(result => {
      if (!controller.signal.aborted) changed(result);
    }).catch(() => { if (!controller.signal.aborted) setError("读取角色失败，请重试"); });
    return () => controller.abort();
  }, [character.id, changed, latestGenerated]);
  const needsAttention = generation.current?.filter(take => take.state !== "ready").slice(0, 8) ?? [];
  const takeLabel = (target: ComicCharacterUpload) => {
    const label = (target.kind === "slot" ? slots : expressions).find(entry => entry.key === target.key)?.labels[locale] ?? target.key;
    const outfitName = target.kind === "slot" && character.outfits.find(entry => entry.id === target.outfitId)?.name;
    return outfitName ? outfitName + " · " + label : label;
  };
  const versions = useCallback((signal: AbortSignal) => versionTarget ?
    comicLibraryApi.characterVersions(character.id, versionTarget, signal) : Promise.resolve([]), [character.id, versionTarget]);
  const showVersions = (asset: ComicCharacterAsset) => {
    setVersionTarget(asset.kind === "slot" && asset.outfitId ?
      { kind: "slot", key: asset.key, outfitId: asset.outfitId } : { kind: "expression", key: asset.key });
  };
  return <>
    <header className="comic-heading"><div>
      {roleName && <small>{roleName}</small>}
      <h1>{character.name}</h1>
      {character.aliases.length > 0 && <p>{t("别名")} · {character.aliases.join(" / ")}</p>}
    </div>
    {character.archived ? <span>{t("已归档")}</span> : <div className="comic-actions">
      <button onClick={() => setDialog("edit")}>{t("编辑角色")}</button>
      <button onClick={() => setDialog("voice")}>{t("绑定角色音色")}</button>
      <button onClick={() => {
        if (window.confirm(t("归档此角色？"))) void comicLibraryApi.archiveCharacter(character.id).then(onArchive).catch(reason => setError(libraryError(reason)));
      }}>{t("归档")}</button>
    </div>}</header>
    {(character.age || character.personality || character.appearance || character.tags.length > 0) &&
      <dl className="comic-character-profile">
        {character.age && <><dt>{t("年龄")}</dt><dd>{character.age}</dd></>}
        {character.personality && <><dt>{t("性格")}</dt><dd>{character.personality}</dd></>}
        {character.appearance && <><dt>{t("外貌设定")}</dt><dd>{character.appearance}</dd></>}
        {character.tags.length > 0 && <><dt>{t("标签")}</dt><dd>{character.tags.join(" / ")}</dd></>}
      </dl>}
    {error && <p className="comic-error" role="alert">{t(error)}</p>}
    <nav className="comic-steps" aria-label={t("角色素材")}>
      <button aria-pressed={kind === "slot"} onClick={() => setKind("slot")}>{t("造型套装")}</button>
      <button aria-pressed={kind === "expression"} onClick={() => setKind("expression")}>{t("表情")}</button>
    </nav>
    <div className="comic-library-controls">
      {kind === "slot" && <>
        {outfit && <label>{t("套装")}
          <select value={outfit.id} onChange={event => setOutfit(event.target.value)}>
            {character.outfits.map(entry => <option value={entry.id} key={entry.id}>{entry.name}</option>)}
          </select>
        </label>}
        {!character.archived && <button onClick={() => setDialog("outfit")}>＋ {t("新增套装")}</button>}
      </>}
      {!character.archived && <button className="primary" disabled={kind === "slot" && !outfit}
        onClick={() => setDialog("upload")}>＋ {t("上传角色图片")}</button>}
      {!character.archived && <button disabled={kind === "slot" && !outfit}
        onClick={() => setDialog("generate")}>{t(kind === "slot" ? "生成造型" : "生成表情")}</button>}
    </div>
    {(needsAttention.length > 0 || generation.failed) && <section className="comic-edit-card comic-character-jobs">
      <header><h2>{t("角色图片任务")}</h2>
        {generation.failed && <button type="button" onClick={generation.refresh}>{t("重新读取")}</button>}
      </header>
      <ul className="comic-generation-status-list">{needsAttention.map(take => <li key={take.id}>
        <strong>{take.characterTarget ? takeLabel(take.characterTarget) : character.name}</strong>
        <ComicTakeStatus take={take} />
        <ImageTakeActions take={take} refreshed={generation.refresh} />
      </li>)}</ul>
    </section>}
    {rows.length === 0 && <div className="comic-empty">{t(kind === "slot" && !outfit ? "先创建一套造型" : "暂无角色图片")}</div>}
    <div className="comic-library-grid">{rows.map(asset => {
      const label = choices.find(entry => entry.key === asset.key)?.labels[locale] ?? asset.key;
      return <article className="comic-library-card" key={asset.media.id}>
        <MediaPreview media={asset.media} title={label} />
        <strong>{label}</strong>
        <small>{t("版本 {0}", [asset.version])}</small>
        <button onClick={() => showVersions(asset)}>{t("版本历史")}</button>
      </article>;
    })}</div>
    {dialog === "voice" && <ComicCharacterVoice id={character.id} close={() => setDialog(null)} />}
    {dialog === "edit" && <CharacterForm character={character} close={() => setDialog(null)}
      save={async input => { await comicLibraryApi.editCharacter(character.id, input); await reload(); }} />}
    {dialog === "outfit" && <LibraryDialog title={t("新增套装")} submitLabel={t("保存")} close={() => setDialog(null)}
      save={async form => {
        const entry = await comicLibraryApi.outfit(character.id, String(form.get("name") ?? "").trim());
        setOutfit(entry.id);
        await reload();
      }}>
      <label>{t("套装名称")}<input name="name" autoFocus required maxLength={120} /></label>
    </LibraryDialog>}
    {dialog === "upload" && <LibraryDialog title={t("上传角色图片")} submitLabel={t("上传")} close={() => setDialog(null)}
      save={async (form, signal) => {
        const key = String(form.get("key") ?? "");
        const target: ComicCharacterUpload = kind === "slot" && outfit ? { kind, key, outfitId: outfit.id } : { kind: "expression", key };
        await comicLibraryApi.characterUpload(character.id, target, form.get("file") as File, signal);
        if (!signal.aborted) await reload();
      }}>
      <label>{t(kind === "slot" ? "造型槽位" : "表情")}
        <ChoiceSelect name="key" domain={kind} required empty={t("请选择")} />
      </label>
      <label>{t("选择文件")}<input name="file" type="file" accept={images} required /></label>
      <small>{t("JPG、PNG 或 WebP，最多 20 MB。同一槽位上传新版会保留历史。")}</small>
    </LibraryDialog>}
    {dialog === "generate" && <LibraryDialog title={t(kind === "slot" ? "生成造型" : "生成表情")} submitLabel={t("预览费用")}
      close={() => setDialog(null)} save={async (form, signal) => {
        const key = String(form.get("key") ?? "");
        const target: ComicCharacterUpload = kind === "slot" && outfit ? { kind, key, outfitId: outfit.id } : { kind: "expression", key };
        const quote = await comicGenerationApi.preview(generationScope, target, signal);
        if (!signal.aborted) setFee({ quote, label: takeLabel(target) });
      }}>
      <label>{t(kind === "slot" ? "造型槽位" : "表情")}
        <ChoiceSelect name="key" domain={kind} aria-label={t(kind === "slot" ? "造型槽位" : "表情")} required empty={t("请选择")} autoFocus />
      </label>
    </LibraryDialog>}
    {fee && <GenerationQuoteDialog quote={fee.quote} label={() => fee.label} close={() => setFee(null)}
      confirm={id => comicGenerationApi.confirm(generationScope, id)} submitted={generation.refresh} />}
    {versionTarget && <MediaVersions list={versions} close={() => setVersionTarget(null)} />}
  </>;
}
