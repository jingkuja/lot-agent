import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n/index.js";
import { employeeApi } from "../modules/digital-employee/api.js";
import type { MarketingProduct } from "../modules/digital-employee/types.js";

interface Props {
  /** At most this many product images are taken (the room left for reference images). */
  room: number;
  onPick: (product: MarketingProduct, images: File[], failedImages: number) => void;
  onClose: () => void;
}

/** Load a product image (a same-site upload) as a file, so it goes out like any reference image the user picked. */
async function imageFile(url: string, name: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image ${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("not an image");
  const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return new File([blob], /\.[a-z0-9]+$/i.test(name) ? name : `${name || "product"}.${ext}`, { type: blob.type });
}

/** 选产品: pick a product from 获客宝's product library; its images become reference images and its details the description. */
export function ProductPickerDialog({ room, onPick, onClose }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<MarketingProduct[] | null>(null);
  const [error, setError] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      employeeApi.listMarketingProducts({ q: query.trim() || undefined, limit: 50 })
        .then((result) => { if (live) { setProducts(result.items); setError(false); } })
        .catch(() => { if (live) setError(true); });
    }, query ? 250 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);

  const pick = async (product: MarketingProduct) => {
    if (picking) return;
    setPicking(product.id);
    const wanted = (product.images ?? []).slice(0, Math.max(0, room));
    const loaded = await Promise.allSettled(wanted.map((image) => imageFile(image.url, image.name)));
    const files = loaded.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    setPicking(null);
    onPick(product, files, wanted.length - files.length);
  };

  return (
    <dialog ref={dialog} className="image-edit-dialog product-picker" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <header className="image-edit-head">
        <h2 id={titleId}>{t("选择产品")}</h2>
        <button type="button" className="image-edit-close" onClick={onClose} aria-label={t("关闭")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <p className="product-picker-hint">{t("来自「获客宝」的产品资料：产品图作为参考图，名称、定位和卖点填进描述。")}</p>
      <input className="product-picker-search" type="search" value={query} placeholder={t("搜索产品名称或定位")}
        aria-label={t("搜索产品名称或定位")} onChange={(event) => setQuery(event.target.value)} />
      <div className="product-picker-list" role="list">
        {error && <p className="product-picker-empty">{t("产品资料暂时读取不到，请稍后重试")}</p>}
        {!error && products === null && <p className="product-picker-empty">{t("读取中…")}</p>}
        {!error && products?.length === 0 && (
          <p className="product-picker-empty">{query ? t("没有找到这个产品") : t("还没有产品资料，可以先在「获客宝」的资料页添加")}</p>
        )}
        {products?.map((product) => (
          <button key={product.id} type="button" role="listitem" className="product-picker-item" disabled={!!picking}
            onClick={() => pick(product)}>
            <span className="product-picker-thumbs">
              {(product.images ?? []).slice(0, 3).map((image) => <img key={image.url} src={image.url} alt="" loading="lazy" />)}
              {!(product.images ?? []).length && <span className="product-picker-noimage">{t("无图")}</span>}
            </span>
            <span className="product-picker-text">
              <strong>{product.name}</strong>
              {product.positioning && <span>{product.positioning}</span>}
            </span>
            {picking === product.id && <span className="product-picker-loading">{t("读取中…")}</span>}
          </button>
        ))}
      </div>
    </dialog>
  );
}
