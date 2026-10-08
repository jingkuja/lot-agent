import { useEffect, useRef, useState } from "react";
import { encodePptApproval, inspectDeck, validateDeck, type PptDeck, type PptSlide } from "@lot-agent/core/presentation";
import { useI18n } from "../i18n/index.js";
import { layoutMeta } from "../lib/layout-icons.js";

interface OutlineCardProps {
  input: unknown;
  interactive: boolean;
  answer?: string;
  onReply?: (text: string) => void;
  exportAgain?: boolean;
  previewUrls?: string[];
}
const THEMES = [["business", "商务蓝"], ["tech-dark", "科技深色"], ["warm", "暖橙创意"], ["mono", "极简黑白"], ["academic", "学术绿"]] as const;
const MODES = { generate: "基于素材创作", condense: "提炼重点", preserve: "保留原文" };

function summary(s: PptSlide): string {
  if (s.chart) return `${s.chart.series.map(series => series.name).join(" / ")} · ${s.chart.unit}`;
  if (s.bullets?.length) return s.bullets.join(" · ");
  if (s.items?.length) return s.items.map(it => it.value ? `${it.label} ${it.value}` : it.label).join(" · ");
  if (s.left && s.right) return `${s.left.title} ↔ ${s.right.title}`;
  if (s.quote) return `${s.quote.text}${s.quote.author ? ` — ${s.quote.author}` : ""}`;
  return s.subtitle ?? "";
}

/** One draft object is the source of truth for the editor and the export action. */
export function OutlineCard({ input, interactive, answer, onReply, exportAgain, previewUrls }: OutlineCardProps) {
  const { t } = useI18n();
  const [deck, setDeck] = useState<PptDeck | null>(() => validateDeck(input) ? null : structuredClone(input as PptDeck));
  const [rowKeys, setRowKeys] = useState(() => deck?.slides.map((_, i) => i) ?? []);
  const [changed, setChanged] = useState(false);
  const [sending, setSending] = useState(false);
  const lock = useRef(false);
  useEffect(() => { if (!interactive) { lock.current = false; setSending(false); } }, [interactive]);
  if (!deck) return <div className="outline-card" role="status">{t("大纲数据不完整，请让助手重新整理。")}</div>;
  const error = validateDeck(deck);
  const warnings = inspectDeck(deck);
  const editable = interactive && !!onReply && !sending;
  const update = (next: PptDeck) => { setDeck(next); setChanged(true); };
  const patchSlide = (index: number, patch: Partial<PptSlide>) => update({ ...deck, slides: deck.slides.map((s, i) => i === index ? { ...s, ...patch } : s) });
  const reorder = (index: number, delta: number) => {
    const slides = [...deck.slides];
    [slides[index], slides[index + delta]] = [slides[index + delta], slides[index]];
    const keys = [...rowKeys];
    [keys[index], keys[index + delta]] = [keys[index + delta], keys[index]];
    setRowKeys(keys);
    update({ ...deck, slides });
  };
  const remove = (index: number) => {
    const slides = deck.slides.filter((_, i) => i !== index);
    setRowKeys(rowKeys.filter((_, i) => i !== index));
    update({ ...deck, slides, brief: deck.brief ? { ...deck.brief, targetSlides: slides.length } : undefined });
  };
  const confirm = () => {
    if (lock.current || error || !editable) return;
    lock.current = true;
    setSending(true);
    onReply!(encodePptApproval(deck));
  };
  return <div className={`outline-card ppt-editor${interactive ? "" : " answered"}`}>
    <div className="outline-head">
      <span className="outline-title">{deck.title}</span>
      <span className="outline-count">{t("共")}{deck.slides.length} {t("页")}</span>
    </div>
    {deck.brief && <dl className="ppt-brief">
      {deck.brief.audience && <div><dt>{t("受众")}</dt><dd>{deck.brief.audience}</dd></div>}
      {deck.brief.objective && <div><dt>{t("表达目标")}</dt><dd>{deck.brief.objective}</dd></div>}
      {deck.brief.durationMinutes && <div><dt>{t("演讲时长")}</dt><dd>{deck.brief.durationMinutes} {t("分钟")}</dd></div>}
      {deck.brief.contentMode && <div><dt>{t("素材处理")}</dt><dd>{t(MODES[deck.brief.contentMode])}</dd></div>}
    </dl>}
    {!!deck.brief?.assumptions?.length && <p className="ppt-assumptions">{t("当前假设：")}{deck.brief.assumptions.join("；")}</p>}
    <div className="ppt-design-settings">
      <label>{t("视觉主题")}<select value={deck.themePreset ?? "business"} disabled={!editable || !!deck.templateAssetId || !!deck.backgrounds?.length}
        onChange={event => update({ ...deck, themePreset: event.target.value as PptDeck["themePreset"] })}>
        {THEMES.map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
      </select></label>
      {(deck.templateAssetId || !!deck.backgrounds?.length) && <span>{t("已保留上传的模板或背景")}</span>}
      {editable && (deck.templateAssetId || !!deck.backgrounds?.length) && <button type="button" onClick={() => update({ ...deck, templateAssetId: undefined, backgrounds: undefined })}>{t("改用内置主题")}</button>}
    </div>
    {editable && <label className="ppt-field">{t("演示标题")}<input value={deck.title} onChange={event => update({ ...deck, title: event.target.value })} /></label>}
    {previewUrls?.length ? <p className="outline-hint">{t(changed ? "内容已修改，缩略图将在重新导出后更新。" : "缩略图来自导出的 PPT，点击页面可修改内容。")}</p> : null}
    <ol className="outline-list ppt-slide-list">
      {deck.slides.map((slide, i) => <li key={rowKeys[i]} className="ppt-slide-row">
        <details>
          <summary className="outline-row">
            <span className="outline-index">{i + 1}</span>
            <span className="outline-layout" title={t(layoutMeta(slide.layout).label)}>{layoutMeta(slide.layout).icon}</span>
            <span className="outline-body"><span className="outline-slide-title">{slide.title || t(layoutMeta(slide.layout).label)}</span><span className="outline-slide-sum">{summary(slide)}</span></span>
            <span className="ppt-expand">{t(editable ? "编辑" : "查看")}</span>
          </summary>
          {!!previewUrls?.[i] && !changed && <a href={previewUrls[i]} target="_blank" rel="noreferrer"><img className="ppt-slide-preview" loading="lazy" src={previewUrls[i]} alt={`${i + 1}. ${slide.title}`} /></a>}
          <fieldset className="ppt-slide-fields" disabled={!editable}>
            <SlideFields slide={slide} onChange={patch => patchSlide(i, patch)} />
          </fieldset>
          {editable && <div className="ppt-page-actions">
            <button type="button" disabled={i === 0} onClick={() => reorder(i, -1)}>{t("上移")}</button>
            <button type="button" disabled={i === deck.slides.length - 1} onClick={() => reorder(i, 1)}>{t("下移")}</button>
            <button type="button" disabled={deck.slides.length <= 1} onClick={() => remove(i)}>{t("删除此页")}</button>
          </div>}
        </details>
      </li>)}
    </ol>
    {warnings.length > 0 && <ul className="ppt-warnings">{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>}
    {error && <p className="ppt-validation" role="alert">{error}</p>}
    {interactive ? <div className="outline-actions">
      <button type="button" className="outline-confirm" disabled={!editable || !!error} onClick={confirm}>{t(sending ? "正在导出…" : exportAgain ? "按修改内容重新导出" : "✓ 确认生成")}</button>
      <span className="outline-hint">{t("将按当前内容直接生成；需要调整叙事或版式，可在下方告诉助手。")}</span>
    </div> : answer ? <div className="outline-answered-note">{t("已确认或回复")}</div> : null}
  </div>;
}

function SlideFields({ slide: s, onChange }: { slide: PptSlide; onChange: (patch: Partial<PptSlide>) => void }) {
  const { t } = useI18n();
  const field = (label: string, value: string, change: (value: string) => void, multiline = false) => <label className="ppt-field">{t(label)}{multiline
    ? <textarea value={value} rows={3} onChange={e => change(e.target.value)} />
    : <input value={value} onChange={e => change(e.target.value)} />}</label>;
  return <>
    {field("本页标题 / 结论", s.title, title => onChange({ title }))}
    {(["cover", "section", "closing"].includes(s.layout) || s.subtitle !== undefined) && field("副标题", s.subtitle ?? "", subtitle => onChange({ subtitle }))}
    {s.bullets && field("要点（每行一条）", s.bullets.join("\n"), bullets => onChange({ bullets: bullets.split("\n") }), true)}
    {s.items?.map((item, i) => <div className="ppt-item-fields" key={i}>
      {field("标签", item.label, label => onChange({ items: s.items!.map((it, j) => j === i ? { ...it, label } : it) }))}
      {(s.layout === "stats" || item.value !== undefined) && field("数值", item.value ?? "", value => onChange({ items: s.items!.map((it, j) => j === i ? { ...it, value } : it) }))}
      {s.layout !== "agenda" && field("说明", item.desc ?? "", desc => onChange({ items: s.items!.map((it, j) => j === i ? { ...it, desc } : it) }))}
    </div>)}
    {(["left", "right"] as const).map(key => s[key] ? <div key={key} className="ppt-item-fields">
      {field(key === "left" ? "左栏标题" : "右栏标题", s[key]!.title, title => onChange({ [key]: { ...s[key]!, title } }))}
      {field("要点（每行一条）", s[key]!.bullets.join("\n"), text => onChange({ [key]: { ...s[key]!, bullets: text.split("\n") } }), true)}
    </div> : null)}
    {s.quote && <>
      {field("引言", s.quote.text, text => onChange({ quote: { ...s.quote!, text } }), true)}
      {field("出处 / 作者", s.quote.author ?? "", author => onChange({ quote: { ...s.quote!, author } }))}
    </>}
    {s.chart && <div className="ppt-chart-editor">
      <label className="ppt-field">{t("图表类型")}<select value={s.chart.type} onChange={event => onChange({ chart: { ...s.chart!, type: event.target.value as "bar" | "line" | "pie" } })}>
        <option value="bar">{t("柱状图")}</option><option value="line">{t("折线图")}</option><option value="pie">{t("饼图")}</option>
      </select></label>
      {field("单位", s.chart.unit, unit => onChange({ chart: { ...s.chart!, unit } }))}
      <div className="ppt-data-scroll"><table><thead><tr><th>{t("类别")}</th>{s.chart.series.map((series, j) => <th key={j}><input aria-label={t("系列名称")} value={series.name} onChange={event => onChange({ chart: { ...s.chart!, series: s.chart!.series.map((v, k) => k === j ? { ...v, name: event.target.value } : v) } })} /></th>)}</tr></thead>
        <tbody>{s.chart.categories.map((category, i) => <tr key={i}>
          <td><input aria-label={t("类别")} value={category} onChange={event => onChange({ chart: { ...s.chart!, categories: s.chart!.categories.map((v, k) => k === i ? event.target.value : v) } })} /></td>
          {s.chart!.series.map((series, j) => <td key={j}><input aria-label={`${series.name} ${category}`} type="number" step="any" value={Number.isFinite(series.values[i]) ? series.values[i] : ""}
            onChange={event => onChange({ chart: { ...s.chart!, series: s.chart!.series.map((v, k) => k === j ? { ...v, values: v.values.map((n, x) => x === i ? event.target.value === "" ? NaN : Number(event.target.value) : n) } : v) } })} /></td>)}
        </tr>)}</tbody></table></div>
      {field("数据来源", s.chart.source, source => onChange({ chart: { ...s.chart!, source } }))}
    </div>}
    {s.layout !== "chart" && field("数据 / 内容来源", s.source ?? "", source => onChange({ source }))}
    {field("演讲备注（不放入正文）", s.notes ?? "", notes => onChange({ notes }), true)}
  </>;
}
