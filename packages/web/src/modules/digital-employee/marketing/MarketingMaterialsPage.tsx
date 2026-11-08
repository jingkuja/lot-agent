import { useI18n } from "../../../i18n/index.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { employeeApi } from "../api.js";
import type {
  MarketingBrandAssets,
  MarketingProduct,
  MarketingProductInput,
  ProductImportResult,
  ProductImportStatus,
} from "../types.js";
import { MAX_PRODUCT_IMAGES, splitBusinessImages } from "./business-images.js";
import { BusinessProfileEditor } from "./BusinessProfileEditor.js";
import { lines, splitLines, TextRows } from "./form-fields.js";
import { ImagePicker, ImageTile, keepDrop, useImageUpload } from "./ImageUpload.js";
import {
  DOCUMENT_ACCEPT, DOCUMENT_ERROR_TEXT, DOCUMENT_NO_RETRY, UNSUPPORTED_FILE_TEXT, supportedFile, uploadable, uploadErrorText,
} from "./product-files.js";
import { ProductDocumentsDialog } from "./ProductDocumentsDialog.js";
import { ProductImportDialog } from "./ProductImportDialog.js";
import { usePolling } from "../usePolling.js";

const IMPORT_POLL_MS = 3000;

interface Props {
  onSelect?: (product: MarketingProduct) => void;
  /** The review named by the address, from the today page or a chat link. */
  importId?: string | null;
  onImportClosed?: () => void;
}

export function MarketingMaterialsPage({ onSelect, importId = null, onImportClosed }: Props) {
  const { t } = useI18n();
  const [products, setProducts] = useState<MarketingProduct[]>([]);
  const [brand, setBrand] = useState<MarketingBrandAssets | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingProduct, setEditingProduct] = useState<MarketingProduct | "new" | null>(null);
  const [editingBrand, setEditingBrand] = useState(false);
  const [documentsOf, setDocumentsOf] = useState<MarketingProduct | null>(null);
  const [imports, setImports] = useState<ProductImportStatus[]>([]);
  const [reviewing, setReviewing] = useState<string | null>(importId);
  const [uploading, setUploading] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [productResult, brandResult] = await Promise.all([
        employeeApi.listMarketingProducts({ q: debouncedQuery || undefined, limit: 100 }),
        employeeApi.getMarketingBrandAssets(),
      ]);
      setProducts(productResult.items);
      setBrand(brandResult);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "营销资料加载失败");
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery]);

  useEffect(() => { void load(); }, [load]);

  const loadImports = useCallback(async () => {
    try {
      setImports((await employeeApi.listProductImports()).items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入进度加载失败");
    }
  }, []);

  useEffect(() => { void loadImports(); }, [loadImports]);
  useEffect(() => { setReviewing(importId); }, [importId]);
  const importing = imports.some((item) => item.status === "working");
  usePolling(loadImports, IMPORT_POLL_MS, importing);

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setNotice(null);
    for (const file of Array.from(files)) {
      if (!supportedFile(file)) {
        setError(UNSUPPORTED_FILE_TEXT);
        continue;
      }
      setUploading((current) => [...current, file.name]);
      try {
        const asset = await api.uploadFile(uploadable(file));
        await employeeApi.startProductImport(asset.assetId);
        await loadImports();
      } catch (reason) {
        setError(uploadErrorText(reason, "上传失败"));
      } finally {
        setUploading((current) => current.filter((name) => name !== file.name));
      }
    }
  };

  const closeReview = () => {
    setReviewing(null);
    if (importId) onImportClosed?.();
  };

  const importSaved = (result: ProductImportResult) => {
    closeReview();
    setNotice(result.alreadyApplied ? "这份文件之前已经保存过了" : t("已保存到：{0}", [result.saved.map((item) => item.name).join("、")]));
    void load();
    void loadImports();
  };

  const retryImport = async (id: string) => {
    try {
      await employeeApi.retryProductImport(id);
      await loadImports();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重试失败");
    }
  };

  const removeImport = async (id: string) => {
    try {
      await employeeApi.discardProductImport(id);
      await loadImports();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    }
  };

  const saveProduct = async (input: MarketingProductInput) => {
    if (editingProduct === "new") await employeeApi.createMarketingProduct(input);
    else if (editingProduct) await employeeApi.updateMarketingProduct(editingProduct.id, { ...input, version: editingProduct.version });
    setEditingProduct(null);
    await load();
  };

  const archiveProduct = async (product: MarketingProduct) => {
    if (!window.confirm(t(`确认归档“${product.name}”？归档后不会再作为有效营销事实被查询。`))) return;
    try {
      await employeeApi.archiveMarketingProduct(product.id, product.version);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "归档失败");
    }
  };

  return (
    <div
      className={`de-page marketing-materials-page${dropping ? " is-dropping" : ""}`}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDropping(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDropping(false);
        void importFiles(event.dataTransfer.files);
      }}
    >
      <header className="de-page-header">
        <div>
          <p className="de-eyebrow">{t("数字员工 / 营销资料")}</p>
          <h1>{t("公司与产品资料")}</h1>
          <p>{t("把公司或店铺、产品的情况放在这里，写文案、做海报和跟进客户时都会用上。")}</p>
        </div>
        <div className="de-header-actions">
          <button className="de-secondary-button" onClick={() => setEditingProduct("new")}>{t("＋ 新建产品")}</button>
          <button className="de-primary-button" onClick={() => fileInput.current?.click()}>{t("从文件导入")}</button>
          <input
            ref={fileInput} type="file" hidden multiple accept={DOCUMENT_ACCEPT}
            onChange={(event) => { void importFiles(event.target.files); event.target.value = ""; }}
          />
        </div>
      </header>

      {error && (
        <div className="de-inline-error">
          {t(error)}
          <button onClick={() => void load()}>{t("重试")}</button>
        </div>
      )}

      {notice && (
        <div className="de-inline-notice" role="status">
          <span>{t(notice)}</span>
          <button onClick={() => setNotice(null)}>{t("关闭")}</button>
        </div>
      )}

      {(uploading.length > 0 || imports.length > 0) && (
        <ul className="product-import-strip" aria-label={t("正在导入的文件")}>
          {uploading.map((name) => <li key={name}><div><strong>{name}</strong><small>{t("上传中…")}</small></div></li>)}
          {imports.map((item) => <ImportRow
            key={item.id}
            item={item}
            onReview={() => setReviewing(item.id)}
            onRetry={() => void retryImport(item.id)}
            onRemove={() => void removeImport(item.id)}
          />)}
        </ul>
      )}

      <BusinessProfileCard brand={brand} onEdit={() => setEditingBrand(true)} />

      <section className="marketing-products-section">
        <div className="de-section-heading">
          <div>
            <h2>{t("产品目录")}</h2>
            <p>{t("卖点、事实、FAQ、补充说明、异议、权益、禁用表达与案例素材集中管理。")}</p>
          </div>
          <div className="marketing-product-search">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索产品名称或定位")} />
          </div>
        </div>
        {loading && products.length === 0 && <div className="de-state">{t("正在读取营销资料…")}</div>}
        {!loading && products.length === 0 && (
          <div className="de-state de-empty-state">
            <span className="de-empty-icon">◇</span>
            <strong>{debouncedQuery ? t("没有匹配的产品") : t("还没有产品资料")}</strong>
            <p>{t("把手册、价目表或想法文件拖进来，也可以直接告诉数字员工。")}</p>
            {!debouncedQuery && (
              <button className="de-primary-button" onClick={() => setEditingProduct("new")}>
                {t("新建第一条产品资料")}
              </button>
            )}
          </div>
        )}
        {products.length > 0 && (
          <div className="marketing-product-grid">
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                onEdit={() => {
                  setEditingProduct(product);
                  onSelect?.(product);
                }}
                onDocuments={() => setDocumentsOf(product)}
                onArchive={() => void archiveProduct(product)}
              />
            ))}
          </div>
        )}
      </section>

      {editingProduct && (
        <ProductEditor product={editingProduct === "new" ? undefined : editingProduct} onClose={() => setEditingProduct(null)} onSave={saveProduct} />
      )}
      {documentsOf && (
        <ProductDocumentsDialog
          product={documentsOf}
          onClose={() => setDocumentsOf(null)}
          onChanged={() => void load()}
          onImporting={() => { setDocumentsOf(null); void loadImports(); }}
        />
      )}
      {reviewing && (
        <ProductImportDialog
          importId={reviewing}
          products={products}
          onClose={closeReview}
          onSaved={importSaved}
          onDiscarded={() => { closeReview(); void loadImports(); }}
        />
      )}
      {editingBrand && (
        <BusinessProfileEditor
          brand={brand}
          onClose={() => setEditingBrand(false)}
          onSave={async (input) => {
            await employeeApi.saveMarketingBrandAssets({ ...input, ...(brand ? { version: brand.version } : {}) });
            setEditingBrand(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function ImportRow({ item, onReview, onRetry, onRemove }: {
  item: ProductImportStatus; onReview: () => void; onRetry: () => void; onRemove: () => void;
}) {
  const { t } = useI18n();
  const found = item.preview?.products.reduce((sum, product) => sum + product.items, 0) ?? 0;
  const count = item.preview?.products.length ?? 0;
  const status = item.status === "ready" ? t("整理好了：{0} 个产品，{1} 条内容", [count, found])
    : item.status === "failed" ? t(DOCUMENT_ERROR_TEXT[item.errorCode ?? ""] ?? "这份文件没读出来，可以重试")
      : item.pagesRead > 0 ? t("已读完 {0} 张图片，继续整理…", [item.pagesRead]) : t("正在读取和整理…");
  return <li>
    <div>
      <strong>{item.title}</strong>
      <small className={item.status === "failed" ? "is-error" : undefined}>{status}</small>
    </div>
    <div className="product-documents-actions">
      {item.status === "ready" && <button className="de-primary-button" onClick={onReview}>{t("看一下")}</button>}
      {item.status === "failed" && !DOCUMENT_NO_RETRY.has(item.errorCode ?? "") && <button className="de-row-action" onClick={onRetry}>{t("重试")}</button>}
      {item.status === "failed" && <button className="de-row-action" onClick={onRemove}>{t("移除")}</button>}
    </div>
  </li>;
}

function ProductCard({ product, onEdit, onDocuments, onArchive }: {
  product: MarketingProduct; onEdit: () => void; onDocuments: () => void; onArchive: () => void;
}) {
  const { t, locale } = useI18n();
  const images = product.images ?? [];
  const activeBenefits = product.currentBenefits.filter((benefit) => {
    const now = Date.now();
    return (!benefit.validFrom || new Date(benefit.validFrom).getTime() <= now)
      && (!benefit.validUntil || new Date(benefit.validUntil).getTime() >= now);
  });
  return <article className="marketing-product-card">
    <header>
      <div><h3>{product.name}</h3><p>{product.positioning || t("待补充产品定位")}</p></div>
      <div>
        <button className="de-row-action" onClick={onDocuments}>
          {t("补充资料")}{product.documentCount ? ` ${product.documentCount}` : ""}
        </button>
        <button className="de-row-action" onClick={onEdit}>{t("编辑")}</button>
        <button className="de-quiet-button" onClick={onArchive}>{t("归档")}</button>
      </div>
    </header>
    {images.length > 0 && (
      <div className="marketing-product-images">
        {images.map((image) => (
          <a key={image.url} href={image.url} target="_blank" rel="noreferrer"><img src={image.url} alt={image.name} loading="lazy" /></a>
        ))}
      </div>
    )}
    <div className="marketing-product-stats">
      <span><strong>{product.coreValues.length}</strong>{t("客户最在意")}</span>
      <span><strong>{product.verifiableFacts.length}</strong>{t("能说出口的证据")}</span>
      <span><strong>{activeBenefits.length}</strong>{t("当前权益")}</span>
      <span><strong>{product.caseMaterials.length}</strong>{t("案例素材")}</span>
      <span><strong>{product.faqs?.length ?? 0}</strong>FAQ</span>
    </div>
    {(product.faqs?.length ?? 0) > 0 && <div className="marketing-benefit-strip"><strong>FAQ</strong>{product.faqs.slice(0, 2).map((item) => <span key={item.question}>{item.question}</span>)}</div>}
    {product.productNotes?.trim() && <div className="marketing-prohibited"><strong>{t("补充说明")}</strong><span>{product.productNotes.trim().slice(0, 80)}{product.productNotes.trim().length > 80 ? "…" : ""}</span></div>}
    {product.coreValues.length > 0 && <div className="de-tag-list">{product.coreValues.slice(0, 4).map((item) => <span key={item}>{item}</span>)}</div>}
    {activeBenefits.length > 0 && <div className="marketing-benefit-strip"><strong>{t("当前权益")}</strong>{activeBenefits.slice(0, 2).map((benefit) => <span key={benefit.title}>{benefit.title}{benefit.validUntil ? t(" · 至 {0}", [shortDate(benefit.validUntil, locale)]) : ""}</span>)}</div>}
    {product.prohibitedExpressions.length > 0 && <div className="marketing-prohibited"><strong>{t("禁用")}</strong><span>{product.prohibitedExpressions.slice(0, 3).join("、")}</span></div>}
  </article>;
}

function BusinessProfileCard({ brand, onEdit }: { brand: MarketingBrandAssets | null; onEdit: () => void }) {
  const { t } = useI18n();
  const { logo, photos, others } = splitBusinessImages(brand?.visualAssets);
  const name = brand?.businessName ?? "";
  const intro = brand?.businessIntro ?? "";
  const empty = !name && !intro && !logo && !photos.length && !others.length;
  return <section className="marketing-brand-card">
    <div className="de-card-heading">
      <div>
        <h2>{t("公司 / 店铺资料")}</h2>
        <p>{t("写文案、做海报、跟进客户时都会用到。")}</p>
      </div>
      <button className="de-secondary-button" onClick={onEdit}>{empty ? t("填写资料") : t("编辑")}</button>
    </div>
    {empty ? <p className="marketing-business-empty">{t("还没有填写。写几句公司或店铺的介绍，传上 Logo 和店面图片就行。")}</p> : (
      <div className="marketing-business">
        <div className="marketing-business-logo">
          {logo ? <img src={logo.url} alt={t("Logo 图片")} /> : <span>{t("暂无 Logo")}</span>}
        </div>
        <div className="marketing-business-text">
          <strong>{name || t("未填写名称")}</strong>
          <p>{intro || t("还没有基础介绍")}</p>
        </div>
        {photos.length > 0 && (
          <div className="marketing-business-photos">
            {photos.map((photo) => (
              <a key={photo.url} href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} alt={photo.name} loading="lazy" /></a>
            ))}
          </div>
        )}
        {others.length > 0 && (
          <div className="marketing-asset-list marketing-business-others">
            {others.map((asset) => (
              <a key={asset.url} href={asset.url} target="_blank" rel="noreferrer">
                <span aria-hidden>▧</span>
                <span><strong>{asset.name}</strong>{asset.type ? <small>{asset.type}</small> : null}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    )}
  </section>;
}

interface ProductForm {
  name: string; positioning: string; coreValues: string; facts: string; objections: string;
  benefits: string; prohibited: string; cases: string; faqs: string; productNotes: string;
}

function ProductEditor({ product, onClose, onSave }: { product?: MarketingProduct; onClose: () => void; onSave: (input: MarketingProductInput) => Promise<void> }) {
  const { t } = useI18n();
  const [form, setForm] = useState<ProductForm>(() => ({
    name: product?.name ?? "", positioning: product?.positioning ?? "", coreValues: lines(product?.coreValues),
    facts: rows(product?.verifiableFacts.map((item) => [item.statement, item.evidence ?? ""])),
    objections: rows(product?.commonObjections.map((item) => [item.objection, item.response])),
    benefits: rows(product?.currentBenefits.map((item) => [item.title, item.description ?? "", dateInput(item.validFrom), dateInput(item.validUntil)])),
    prohibited: lines(product?.prohibitedExpressions),
    cases: rows(product?.caseMaterials.map((item) => [item.title, item.summary, item.result ?? "", item.assetUrl ?? ""])),
    faqs: rows((product?.faqs ?? []).map((item) => [item.question, item.answer])),
    productNotes: product?.productNotes ?? "",
  }));
  const [images, setImages] = useState(product?.images ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { uploading, upload } = useImageUpload(setError);
  const addImages = async (files: File[]) => {
    setError(null);
    const room = MAX_PRODUCT_IMAGES - images.length - uploading;
    if (files.length > room) setError(t("最多放 {0} 张图片", [MAX_PRODUCT_IMAGES]));
    const uploaded = await upload(files.slice(0, Math.max(room, 0)));
    setImages((current) => [...current, ...uploaded].slice(0, MAX_PRODUCT_IMAGES));
  };
  const change = (key: keyof ProductForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return setError("请填写产品名称");
    setSaving(true); setError(null);
    try {
      await onSave({
        name: form.name.trim(), positioning: form.positioning.trim(), coreValues: splitLines(form.coreValues),
        verifiableFacts: splitRows(form.facts, 2).map(([statement, evidence]) => ({ statement, ...(evidence ? { evidence } : {}) })),
        commonObjections: splitRows(form.objections, 2).map(([objection, response]) => ({ objection, response })),
        currentBenefits: splitRows(form.benefits, 4).map(([title, description, validFrom, validUntil]) => ({ title, ...(description ? { description } : {}), ...(validFrom ? { validFrom } : {}), ...(validUntil ? { validUntil } : {}) })),
        prohibitedExpressions: splitLines(form.prohibited),
        caseMaterials: splitRows(form.cases, 4).map(([title, summary, result, assetUrl]) => ({ title, summary, ...(result ? { result } : {}), ...(assetUrl ? { assetUrl } : {}) })),
        faqs: splitRows(form.faqs, 2).map(([question, answer]) => ({ question, answer })),
        productNotes: form.productNotes.trim(),
        images,
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setSaving(false); }
  };
  return <div className="de-modal-backdrop" onMouseDown={onClose} onDragOver={keepDrop} onDrop={keepDrop}>
    <section className="de-modal marketing-editor-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
    <div className="de-modal-head"><div><h2>{product ? t("编辑产品资料") : t("新建产品资料")}</h2><p>{t("每行一项；带“｜”的字段按示例分列。")}</p></div><button className="de-icon-button" onClick={onClose}>×</button></div>
    <form className="de-form" onSubmit={submit}><div className="de-form-grid">
      <label><span>{t("产品名称 *")}</span><input autoFocus value={form.name} onChange={(e) => change("name", e.target.value)} maxLength={200} /></label>
      <label className="marketing-form-wide"><span>{t("产品定位")}</span><textarea value={form.positioning} onChange={(e) => change("positioning", e.target.value)} rows={2} /></label>
      <div className="marketing-form-wide marketing-image-field">
        <span>{t("产品图片")} <small>{t("用于后续营销宣传资料，请上传清晰的高质量图片，最多 3 张")}</small></span>
        <div className="marketing-image-row">
          {images.map((image) => (
            <ImageTile
              key={image.url} url={image.url} label={image.name}
              onRemove={() => setImages((current) => current.filter((item) => item !== image))}
            />
          ))}
          {images.length < MAX_PRODUCT_IMAGES && (
            <ImagePicker label={t("上传图片")} multiple disabled={uploading > 0} onFiles={(files) => void addImages(files)} />
          )}
        </div>
      </div>
      <TextRows label={t("客户最在意的点")} hint="每行一条，客户真正关心什么" value={form.coreValues} onChange={(value) => change("coreValues", value)} />
      <TextRows label={t("能说出口的证据")} hint="说法｜依据来源" value={form.facts} onChange={(value) => change("facts", value)} />
      <TextRows label={t("常见异议")} hint="异议｜标准回应" value={form.objections} onChange={(value) => change("objections", value)} />
      <TextRows label={t("当前权益")} hint="权益｜说明｜开始日期｜结束日期；日期可用 YYYY-MM / YYYY-MM-DD，留空表示不限" value={form.benefits} onChange={(value) => change("benefits", value)} />
      <TextRows label={t("禁用表达")} hint="每行一条" value={form.prohibited} onChange={(value) => change("prohibited", value)} />
      <TextRows label={t("案例素材")} hint="标题｜摘要｜结果｜素材链接" value={form.cases} onChange={(value) => change("cases", value)} />
      <TextRows label={t("产品 FAQ")} hint="问题｜回答；可粘贴常见问答，获客文案/海报会引用" value={form.faqs} onChange={(value) => change("faqs", value)} />
      <label className="marketing-form-wide"><span>{t("产品补充说明")}</span><textarea value={form.productNotes} onChange={(e) => change("productNotes", e.target.value)} rows={4} placeholder={t("粘贴非 PDF 的产品介绍、话术要点或自定义文本资料")} /></label>
    </div>{error && <p className="de-form-error">{t(error)}</p>}<footer className="de-modal-actions">
      <button type="button" className="de-secondary-button" onClick={onClose}>{t("取消")}</button>
      <button className="de-primary-button" disabled={saving || uploading > 0}>
        {saving ? t("保存中…") : uploading > 0 ? t("上传中…") : t("保存产品资料")}
      </button></footer></form>
  </section></div>;
}

function splitRows(value: string, width: number): string[][] { return splitLines(value).map((line) => { const parts = line.split(/[|｜]/).map((item) => item.trim()); return Array.from({ length: width }, (_, index) => parts[index] ?? ""); }).filter((parts) => parts[0]); }
function rows(value?: string[][]): string { return value?.map((parts) => parts.join("｜")).join("\n") ?? ""; }
function dateInput(value?: string | null): string { return value ? value.slice(0, 10) : ""; }
function shortDate(value: string, locale = "zh-CN"): string { return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(new Date(value)); }
