import { useEffect, useState } from "react";
import type {
  ComicGenerationQuote, ComicImageRequest, ComicMaterial, ComicMaterialImageKind, ComicNewMaterialGenerateRequest,
} from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicGenerationApi } from "./generation-api.js";
import { comicGenerationError, GenerationQuoteDialog } from "./GenerationQuoteDialog.js";
import { comicLibraryApi } from "./library-api.js";
import { ChoiceSelect, LibraryDialog, LibraryPagination, MediaPreview } from "./LibraryParts.js";

export function MaterialImageGeneration({ kind, material, styleKey, initialDescription, close, submitted }: {
  kind: ComicMaterialImageKind; material?: ComicMaterial; styleKey?: string; initialDescription?: string;
  close: () => void; submitted: (result: ComicImageRequest, name: string) => void;
}) {
  const { t } = useI18n();
  const [fee, setFee] = useState<{ quote: ComicGenerationQuote; name: string } | null>(null);
  const [references, setReferences] = useState<ComicMaterial[]>([]);
  if (fee) return <GenerationQuoteDialog quote={fee.quote} label={() => fee.name} close={close}
    confirm={id => comicGenerationApi.confirm({ resource: "materials", id: fee.quote.items[0]!.clipId }, id)}
    submitted={result => submitted(result, fee.name)} />;

  return <LibraryDialog title={t("生成素材图片")} submitLabel={t("预览费用")} close={close} closeOnSave={false}
    describeError={comicGenerationError} save={async (form, signal) => {
      const name = material?.name ?? String(form.get("name") ?? "").trim();
      const request: ComicNewMaterialGenerateRequest = {
        kind, name, prompt: String(form.get("prompt") ?? "").trim(), styleKey: String(form.get("style") ?? "") || undefined,
        referenceMediaIds: references.map(item => item.media.id),
      };
      const quote = material ? await comicGenerationApi.materialPreview(material.id, {
        kind, materialId: material.id, prompt: request.prompt, styleKey: request.styleKey, referenceMediaIds: request.referenceMediaIds,
      }, signal) : await comicGenerationApi.newMaterialPreview(request, signal);
      if (!signal.aborted) setFee({ quote, name });
    }}>
    {material ? <strong>{material.name}</strong> : <label>{t("素材名称")}<input name="name" required maxLength={120} autoFocus /></label>}
    <label>{t("画面描述")}<textarea name="prompt" required maxLength={4000} rows={5} defaultValue={initialDescription}
      placeholder={t("描述场景、背景或道具的构图、光线和细节")} /></label>
    <label>{t("画风")}
      <ChoiceSelect name="style" domain="style" existing={styleKey} defaultValue={styleKey ?? ""} empty={t("不指定画风")} />
    </label>
    <MaterialImageReferences chosen={references} change={setReferences} />
  </LibraryDialog>;
}

function MaterialImageReferences({ chosen, change }: { chosen: ComicMaterial[]; change: (items: ComicMaterial[]) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<Awaited<ReturnType<typeof comicLibraryApi.materials>> | "error" | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setResults(null);
    void comicLibraryApi.materials({ mime: "image", query, page: String(page) }, controller.signal)
      .then(data => { if (!controller.signal.aborted) setResults(data); })
      .catch(() => { if (!controller.signal.aborted) setResults("error"); });
    return () => controller.abort();
  }, [open, query, page]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("参考图（最多选 4 张）")} · {chosen.length}/4</summary>
    {chosen.length > 0 && <div className="comic-actions">{chosen.map(item => <button key={item.media.id} type="button"
      onClick={() => change(chosen.filter(other => other.media.id !== item.media.id))}>{item.name} · {t("移除")}</button>)}</div>}
    <label>{t("搜索素材")}<input value={query} maxLength={120} onChange={event => { setQuery(event.target.value); setPage(1); }}
      onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} /></label>
    {results === "error" ? <p role="alert">{t("素材读取失败")}</p> : !results ? <p role="status">{t("加载中…")}</p> : <>
      {results.entries.length === 0 && <p>{t("暂无匹配的素材")}</p>}
      <div className="comic-library-grid">{results.entries.map(item => {
        const selected = chosen.some(other => other.media.id === item.media.id);
        return <article className="comic-library-card" key={item.media.id}>
          <MediaPreview media={item.media} title={item.name} thumbOnly />
          <label className="comic-video-replace"><input type="checkbox" checked={selected} disabled={!selected && chosen.length >= 4}
            onChange={() => change(selected ? chosen.filter(other => other.media.id !== item.media.id) : [...chosen, item])} />
          {item.name} · {t("版本 {0}", [item.version])}</label>
        </article>;
      })}</div>
      <LibraryPagination page={page} more={results.more} change={setPage} />
    </>}
  </details>;
}
