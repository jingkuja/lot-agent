import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import type {
  MarketingBrandAssets,
  MarketingProduct,
  MarketingProductInput,
  MarketingVisualAsset,
} from "../types.js";

interface Props {
  onBackToConversation: () => void;
}

export function MarketingMaterialsPage({ onBackToConversation }: Props) {
  const [products, setProducts] = useState<MarketingProduct[]>([]);
  const [brand, setBrand] = useState<MarketingBrandAssets | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingProduct, setEditingProduct] = useState<MarketingProduct | "new" | null>(null);
  const [editingBrand, setEditingBrand] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [productResult, brandResult] = await Promise.all([
        api.listMarketingProducts({ q: debouncedQuery || undefined, limit: 100 }),
        api.getMarketingBrandAssets(),
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

  const saveProduct = async (input: MarketingProductInput) => {
    if (editingProduct === "new") await api.createMarketingProduct(input);
    else if (editingProduct) await api.updateMarketingProduct(editingProduct.id, { ...input, version: editingProduct.version });
    setEditingProduct(null);
    await load();
  };

  const archiveProduct = async (product: MarketingProduct) => {
    if (!window.confirm(`确认归档“${product.name}”？归档后不会再作为有效营销事实被查询。`)) return;
    try {
      await api.archiveMarketingProduct(product.id, product.version);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "归档失败");
    }
  };

  return (
    <div className="de-page marketing-materials-page">
      <button className="de-back-button" onClick={onBackToConversation}>‹ 返回对话管理</button>
      <header className="de-page-header">
        <div>
          <p className="de-eyebrow">数字员工 / 营销资料</p>
          <h1>产品与品牌事实库</h1>
          <p>统一维护产品能说什么、品牌怎么说；商机雷达的单客跟进与获客宝的客群营销共同引用这份事实。</p>
        </div>
        <button className="de-primary-button" onClick={() => setEditingProduct("new")}>＋ 新建产品</button>
      </header>

      {error && <div className="de-inline-error">{error}<button onClick={() => void load()}>重试</button></div>}

      <section className="marketing-brand-card">
        <div className="de-card-heading">
          <div><p className="de-eyebrow">品牌资料</p><h2>品牌口径与视觉资产</h2></div>
          <button className="de-secondary-button" onClick={() => setEditingBrand(true)}>{brand ? "编辑品牌资料" : "建立品牌资料"}</button>
        </div>
        <div className="marketing-brand-grid">
          <FactBlock title="品牌语气" items={brand?.tone ?? []} empty="尚未设置品牌语气" />
          <FactBlock title="标准行动号召" items={brand?.standardCallsToAction ?? []} empty="尚未设置行动号召" />
          <div className="marketing-fact-block">
            <h3>视觉资产</h3>
            {brand?.visualAssets.length ? <div className="marketing-asset-list">{brand.visualAssets.map((asset, index) => (
              <a key={`${asset.url}-${index}`} href={asset.url} target="_blank" rel="noreferrer">
                <span aria-hidden>▧</span><span><strong>{asset.name}</strong><small>{asset.type || "品牌素材"}</small></span>
              </a>
            ))}</div> : <p>尚未添加视觉资产</p>}
          </div>
        </div>
      </section>

      <section className="marketing-products-section">
        <div className="de-section-heading">
          <div><h2>产品目录</h2><p>卖点、事实、异议、权益、禁用表达与案例素材集中管理。</p></div>
          <div className="marketing-product-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索产品名称或定位" /></div>
        </div>
        {loading && products.length === 0 && <div className="de-state">正在读取营销资料…</div>}
        {!loading && products.length === 0 && (
          <div className="de-state de-empty-state"><span className="de-empty-icon">◇</span><strong>{debouncedQuery ? "没有匹配的产品" : "还没有产品资料"}</strong><p>可以在此结构化维护，也可以回到对话直接告诉数字员工。</p>{!debouncedQuery && <button className="de-primary-button" onClick={() => setEditingProduct("new")}>新建第一条产品资料</button>}</div>
        )}
        {products.length > 0 && <div className="marketing-product-grid">{products.map((product) => (
          <ProductCard key={product.id} product={product} onEdit={() => setEditingProduct(product)} onArchive={() => void archiveProduct(product)} />
        ))}</div>}
      </section>

      {editingProduct && <ProductEditor product={editingProduct === "new" ? undefined : editingProduct} onClose={() => setEditingProduct(null)} onSave={saveProduct} />}
      {editingBrand && <BrandEditor brand={brand} onClose={() => setEditingBrand(false)} onSave={async (input) => {
        await api.saveMarketingBrandAssets({ ...input, ...(brand ? { version: brand.version } : {}) });
        setEditingBrand(false);
        await load();
      }} />}
    </div>
  );
}

function ProductCard({ product, onEdit, onArchive }: { product: MarketingProduct; onEdit: () => void; onArchive: () => void }) {
  const activeBenefits = product.currentBenefits.filter((benefit) => {
    const now = Date.now();
    return (!benefit.validFrom || new Date(benefit.validFrom).getTime() <= now)
      && (!benefit.validUntil || new Date(benefit.validUntil).getTime() >= now);
  });
  return <article className="marketing-product-card">
    <header><div><h3>{product.name}</h3><p>{product.positioning || "待补充产品定位"}</p></div><div><button className="de-row-action" onClick={onEdit}>编辑</button><button className="de-quiet-button" onClick={onArchive}>归档</button></div></header>
    <div className="marketing-product-stats">
      <span><strong>{product.coreValues.length}</strong>核心价值</span>
      <span><strong>{product.verifiableFacts.length}</strong>可验证事实</span>
      <span><strong>{activeBenefits.length}</strong>当前权益</span>
      <span><strong>{product.caseMaterials.length}</strong>案例素材</span>
    </div>
    {product.coreValues.length > 0 && <div className="de-tag-list">{product.coreValues.slice(0, 4).map((item) => <span key={item}>{item}</span>)}</div>}
    {activeBenefits.length > 0 && <div className="marketing-benefit-strip"><strong>当前权益</strong>{activeBenefits.slice(0, 2).map((benefit) => <span key={benefit.title}>{benefit.title}{benefit.validUntil ? ` · 至 ${shortDate(benefit.validUntil)}` : ""}</span>)}</div>}
    {product.prohibitedExpressions.length > 0 && <div className="marketing-prohibited"><strong>禁用</strong><span>{product.prohibitedExpressions.slice(0, 3).join("、")}</span></div>}
  </article>;
}

function FactBlock({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return <div className="marketing-fact-block"><h3>{title}</h3>{items.length ? <div className="de-tag-list">{items.map((item) => <span key={item}>{item}</span>)}</div> : <p>{empty}</p>}</div>;
}

interface ProductForm {
  name: string; positioning: string; coreValues: string; facts: string; objections: string;
  benefits: string; prohibited: string; cases: string;
}

function ProductEditor({ product, onClose, onSave }: { product?: MarketingProduct; onClose: () => void; onSave: (input: MarketingProductInput) => Promise<void> }) {
  const [form, setForm] = useState<ProductForm>(() => ({
    name: product?.name ?? "", positioning: product?.positioning ?? "", coreValues: lines(product?.coreValues),
    facts: rows(product?.verifiableFacts.map((item) => [item.statement, item.evidence ?? ""])),
    objections: rows(product?.commonObjections.map((item) => [item.objection, item.response])),
    benefits: rows(product?.currentBenefits.map((item) => [item.title, item.description ?? "", dateInput(item.validFrom), dateInput(item.validUntil)])),
    prohibited: lines(product?.prohibitedExpressions),
    cases: rows(product?.caseMaterials.map((item) => [item.title, item.summary, item.result ?? "", item.assetUrl ?? ""])),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setSaving(false); }
  };
  return <div className="de-modal-backdrop" onMouseDown={onClose}><section className="de-modal marketing-editor-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
    <div className="de-modal-head"><div><h2>{product ? "编辑产品资料" : "新建产品资料"}</h2><p>每行一项；带“｜”的字段按示例分列。</p></div><button className="de-icon-button" onClick={onClose}>×</button></div>
    <form className="de-form" onSubmit={submit}><div className="de-form-grid">
      <label><span>产品名称 *</span><input autoFocus value={form.name} onChange={(e) => change("name", e.target.value)} maxLength={200} /></label>
      <label className="marketing-form-wide"><span>产品定位</span><textarea value={form.positioning} onChange={(e) => change("positioning", e.target.value)} rows={2} /></label>
      <TextRows label="核心价值" hint="每行一条" value={form.coreValues} onChange={(value) => change("coreValues", value)} />
      <TextRows label="可验证事实" hint="事实｜依据" value={form.facts} onChange={(value) => change("facts", value)} />
      <TextRows label="常见异议" hint="异议｜标准回应" value={form.objections} onChange={(value) => change("objections", value)} />
      <TextRows label="当前权益" hint="权益｜说明｜开始日期｜结束日期" value={form.benefits} onChange={(value) => change("benefits", value)} />
      <TextRows label="禁用表达" hint="每行一条" value={form.prohibited} onChange={(value) => change("prohibited", value)} />
      <TextRows label="案例素材" hint="标题｜摘要｜结果｜素材链接" value={form.cases} onChange={(value) => change("cases", value)} />
    </div>{error && <p className="de-form-error">{error}</p>}<footer className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>取消</button><button className="de-primary-button" disabled={saving}>{saving ? "保存中…" : "保存产品资料"}</button></footer></form>
  </section></div>;
}

function BrandEditor({ brand, onClose, onSave }: { brand: MarketingBrandAssets | null; onClose: () => void; onSave: (input: { tone: string[]; visualAssets: MarketingVisualAsset[]; standardCallsToAction: string[] }) => Promise<void> }) {
  const [tone, setTone] = useState(lines(brand?.tone));
  const [ctas, setCtas] = useState(lines(brand?.standardCallsToAction));
  const [visuals, setVisuals] = useState(rows(brand?.visualAssets.map((item) => [item.name, item.url, item.type ?? ""])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="de-modal-backdrop" onMouseDown={onClose}><section className="de-modal marketing-editor-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
    <div className="de-modal-head"><div><h2>品牌资料</h2><p>这些口径会作为营销内容的品牌约束。</p></div><button className="de-icon-button" onClick={onClose}>×</button></div>
    <form className="de-form" onSubmit={async (event) => { event.preventDefault(); setSaving(true); setError(null); try { await onSave({ tone: splitLines(tone), standardCallsToAction: splitLines(ctas), visualAssets: splitRows(visuals, 3).map(([name, url, type]) => ({ name, url, ...(type ? { type } : {}) })) }); } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); } finally { setSaving(false); } }}>
      <div className="de-form-grid"><TextRows label="品牌语气" hint="每行一条，如：专业克制" value={tone} onChange={setTone} /><TextRows label="标准行动号召" hint="每行一条" value={ctas} onChange={setCtas} /><TextRows label="视觉资产" hint="名称｜链接｜类型" value={visuals} onChange={setVisuals} /></div>
      {error && <p className="de-form-error">{error}</p>}<footer className="de-modal-actions"><button type="button" className="de-secondary-button" onClick={onClose}>取消</button><button className="de-primary-button" disabled={saving}>{saving ? "保存中…" : "保存品牌资料"}</button></footer>
    </form>
  </section></div>;
}

function TextRows({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (value: string) => void }) {
  return <label className="marketing-form-wide"><span>{label} <small>{hint}</small></span><textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} /></label>;
}

function splitLines(value: string): string[] { return value.split(/\n/).map((item) => item.trim()).filter(Boolean); }
function splitRows(value: string, width: number): string[][] { return splitLines(value).map((line) => { const parts = line.split(/[|｜]/).map((item) => item.trim()); return Array.from({ length: width }, (_, index) => parts[index] ?? ""); }).filter((parts) => parts[0]); }
function lines(value?: string[]): string { return value?.join("\n") ?? ""; }
function rows(value?: string[][]): string { return value?.map((parts) => parts.join("｜")).join("\n") ?? ""; }
function dateInput(value?: string | null): string { return value ? value.slice(0, 10) : ""; }
function shortDate(value: string): string { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value)); }
