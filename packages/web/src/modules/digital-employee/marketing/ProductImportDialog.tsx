import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n/index.js";
import { employeeApi } from "../api.js";
import type { ImportDraft, ImportItem, ImportProduct, MarketingProduct, ProductImportResult } from "../types.js";

const FIELD_LABELS: Record<ImportItem["field"], string> = {
  coreValues: "卖点", verifiableFacts: "事实和价格", currentBenefits: "优惠", faqs: "常见问题", commonObjections: "客户顾虑",
  caseMaterials: "案例", prohibitedExpressions: "不能说的话", productNotes: "其他说明",
};
const FIELD_ORDER = Object.keys(FIELD_LABELS) as ImportItem["field"][];
const FLAG_TEXT: Record<NonNullable<ImportItem["flag"]>, string> = {
  number: "文件里没找到这个数字，核对后再勾选",
  contact: "含联系方式，勾选后对外内容可以使用",
  benefit: "优惠要你确认，到期日不填就是长期有效",
  expired: "看起来已经过期",
};

interface Props {
  importId: string;
  products: MarketingProduct[];
  onClose: () => void;
  onSaved: (result: ProductImportResult) => void;
  onDiscarded: () => void;
}

export function ProductImportDialog({ importId, products: catalog, onClose, onSaved, onDiscarded }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [products, setProducts] = useState<ImportProduct[]>([]);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    employeeApi.getProductImport(importId).then((result) => {
      if (!live) return;
      if (!result.draft) { setError("这次整理已经处理过了"); return; }
      setDraft(result.draft);
      setDraftId(result.status.draftId);
      setProducts(result.draft.products);
    }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "加载失败"); });
    return () => { live = false; };
  }, [importId]);

  const change = (key: string, patch: Partial<ImportProduct>) => {
    setError(null);
    setProducts((current) => current.map((product) => product.key === key ? { ...product, ...patch } : product));
  };
  const changeItem = (key: string, id: string, patch: Partial<ImportItem>) => {
    setError(null);
    setProducts((current) => current.map((product) => product.key !== key ? product : {
      ...product, items: product.items.map((item) => item.id === id ? { ...item, ...patch } : item),
    }));
  };

  const kept = products.filter((product) => !skipped.has(product.key));
  const selectedCount = useMemo(() => kept.flatMap((product) => product.items).filter((item) => item.selected).length, [kept]);

  const save = async () => {
    if (!draftId || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await employeeApi.commitProductImport(draftId, {
        products: products.map((product) => ({
          key: product.key,
          ...(skipped.has(product.key) ? { skip: true } : {}),
          name: product.name,
          targetProductId: product.targetProductId,
          positioning: product.positioning,
          items: product.items.map(({ id, selected, text, detail, validUntil }) => ({
            id, selected, text, ...(detail !== undefined ? { detail } : {}), ...(validUntil !== undefined ? { validUntil } : {}),
          })),
        })),
        answers: Object.entries(answers).filter(([, answer]) => answer.trim()).map(([id, answer]) => ({ id, answer })),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败，可以重试");
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!draftId || busy) return;
    setBusy(true);
    try {
      await employeeApi.dismissProposal(draftId);
      onDiscarded();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
      setBusy(false);
    }
  };

  return <div className="de-modal-backdrop" onMouseDown={onClose}>
    <section
      className="de-modal product-import-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("确认产品资料")}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="de-modal-head">
        <div><h2>{t("整理好了，看一眼")}</h2><p>{draft?.title ?? ""}</p></div>
        <button className="de-icon-button" aria-label={t("关闭")} onClick={onClose}>×</button>
      </div>
      <div className="product-import-body">
        {draft?.truncated && <p className="product-import-note">{t("文件太长，只整理了前面部分，其余内容聊天里仍可查阅")}</p>}
        {(draft?.skippedPages ?? 0) > 0 && <p className="product-import-note">{t("有 {0} 页是图片，暂未读取", [draft!.skippedPages])}</p>}
        {products.map((product) => <ProductSection
          key={product.key}
          product={product}
          catalog={catalog}
          many={products.length > 1}
          skipped={skipped.has(product.key)}
          answers={answers}
          onAnswer={(id, answer) => { setError(null); setAnswers((current) => ({ ...current, [id]: answer })); }}
          onChange={(patch) => change(product.key, patch)}
          onItem={(id, patch) => changeItem(product.key, id, patch)}
          onSkip={(value) => setSkipped((current) => {
            const next = new Set(current);
            if (value) next.add(product.key); else next.delete(product.key);
            return next;
          })}
        />)}
      </div>
      <div className="product-import-footer">
        {error
          ? <span className="is-error" role="alert">{t(error)}</span>
          : <span>{draft ? t("将保存 {0} 条，空着的以后再补", [selectedCount]) : t("正在打开…")}</span>}
        <div>
          <button className="de-quiet-button" disabled={busy || !draftId} onClick={() => void discard()}>{t("不要了")}</button>
          <button className="de-primary-button" disabled={busy || !draftId || !kept.length} onClick={() => void save()}>
            {busy ? t("保存中…") : t("保存")}
          </button>
        </div>
      </div>
    </section>
  </div>;
}

function nameQuestion(product: ImportProduct) {
  return product.questions.find((question) => question.field === "name");
}

interface SectionProps {
  product: ImportProduct;
  catalog: MarketingProduct[];
  many: boolean;
  skipped: boolean;
  answers: Record<string, string>;
  onAnswer: (id: string, answer: string) => void;
  onChange: (patch: Partial<ImportProduct>) => void;
  onItem: (id: string, patch: Partial<ImportItem>) => void;
  onSkip: (skipped: boolean) => void;
}

function ProductSection({ product, catalog, many, skipped, answers, onAnswer, onChange, onItem, onSkip }: SectionProps) {
  const { t } = useI18n();
  const askName = nameQuestion(product);
  const askPositioning = product.questions.find((question) => question.field === "positioning");
  const others = product.questions.filter((question) => question.field === "notes");
  const flagged = product.items.filter((item) => item.flag);
  const plain = product.items.filter((item) => !item.flag);
  const target = catalog.find((item) => item.id === product.targetProductId);
  const canPosition = !target || !target.positioning.trim();

  if (skipped) {
    return <section className="product-import-product is-skipped">
      <span>{t("不保存：{0}", [product.name || t("这个产品")])}</span>
      <button className="de-row-action" onClick={() => onSkip(false)}>{t("恢复")}</button>
    </section>;
  }
  return <section className="product-import-product">
    <div className="product-import-identity">
      {!product.targetProductId && <label>
        <span>{t("产品名")}</span>
        {askName
          ? <input
              value={answers[askName.id] ?? product.suggestedName}
              onChange={(event) => onAnswer(askName.id, event.target.value)}
              placeholder={askName.question || t("这个产品叫什么？")}
            />
          : <input value={product.name} onChange={(event) => onChange({ name: event.target.value })} />}
      </label>}
      <label>
        <span>{t("存到")}</span>
        <select value={product.targetProductId ?? ""} onChange={(event) => onChange({ targetProductId: event.target.value || null })}>
          <option value="">{t("新产品")}</option>
          {catalog.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {many && <button className="de-row-action" onClick={() => onSkip(true)}>{t("不要这个")}</button>}
    </div>
    {canPosition && <label className="product-import-field">
      <span>{t("一句话介绍")}</span>
      {askPositioning
        ? <input
            value={answers[askPositioning.id] ?? ""}
            onChange={(event) => onAnswer(askPositioning.id, event.target.value)}
            placeholder={askPositioning.question}
          />
        : <input value={product.positioning} onChange={(event) => onChange({ positioning: event.target.value })} placeholder={t("可以留空")} />}
    </label>}
    {others.map((question) => <label className="product-import-field" key={question.id}>
      <span>{question.question}</span>
      <input value={answers[question.id] ?? ""} onChange={(event) => onAnswer(question.id, event.target.value)} placeholder={t("不知道可以留空")} />
    </label>)}
    {flagged.length > 0 && <div className="product-import-group">
      <h3>{t("这几条要你确认")}</h3>
      <ul>{flagged.map((item) => <ItemRow key={item.id} item={item} onChange={(patch) => onItem(item.id, patch)} />)}</ul>
    </div>}
    {plain.length > 0 && <details className="product-import-group">
      <summary>{t("已整理 {0} 条", [plain.length])}</summary>
      {FIELD_ORDER.map((field) => {
        const items = plain.filter((item) => item.field === field);
        if (!items.length) return null;
        return <div key={field}>
          <h4>{t(FIELD_LABELS[field])}</h4>
          <ul>{items.map((item) => <ItemRow key={item.id} item={item} onChange={(patch) => onItem(item.id, patch)} />)}</ul>
        </div>;
      })}
    </details>}
  </section>;
}

function ItemRow({ item, onChange }: { item: ImportItem; onChange: (patch: Partial<ImportItem>) => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  return <li className="product-import-item">
    <input type="checkbox" checked={item.selected} aria-label={item.text} onChange={(event) => onChange({ selected: event.target.checked })} />
    <div>
      {editing ? <>
        <textarea rows={2} value={item.text} onChange={(event) => onChange({ text: event.target.value })} aria-label={t("内容")} />
        {item.detail !== undefined && (
          <textarea rows={2} value={item.detail} onChange={(event) => onChange({ detail: event.target.value })} aria-label={t("说明")} />
        )}
      </> : <>
        <p>{item.text}</p>
        {item.detail && <small>{item.detail}</small>}
      </>}
      {item.flag && <small className="product-import-hint">{t(FLAG_TEXT[item.flag])}</small>}
      {item.field === "currentBenefits" && item.selected && <label className="product-import-date">
        <span>{t("到期日")}</span>
        <input type="date" value={item.validUntil?.slice(0, 10) ?? ""} onChange={(event) => onChange({ validUntil: event.target.value || null })} />
      </label>}
      {item.source && <small className="product-import-source">{t("来自：{0}", [item.source])}</small>}
    </div>
    <button className="de-row-action" onClick={() => setEditing((value) => !value)}>{editing ? t("完成") : t("修改")}</button>
  </li>;
}
