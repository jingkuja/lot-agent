import { useI18n } from "../../i18n/index.js";
import { useEffect, useState } from "react";
import { knowledgeApi, type Candidate, type Collection, type Fact } from "./api.js";
const empty = () => ({ key: "", value: "", type: "text", category: "个人信息", active: true, shareWithApi: false, validFrom: "", validUntil: "", version: 0, collectionIds: [] as string[] });
const localDate = (value: string | null) => value ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
export function ProfilePanel({ collections }: { collections: Collection[] }) {
  const { t } = useI18n();
  const [facts, setFacts] = useState<Fact[]>([]); const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [form, setForm] = useState(empty); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [history, setHistory] = useState<Array<{ version: number; snapshot: Fact; created_at: string }> | null>(null);
  const reload = async () => { const [a, b] = await Promise.all([knowledgeApi.facts(), knowledgeApi.candidates()]); setFacts(a.data); setCandidates(b.data); };
  const act = async (work: () => Promise<unknown>) => { setBusy(true); setError(""); try { await work(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(false); } };
  useEffect(() => { void act(reload); }, []);
  const edit = (f: Fact) => { setHistory(null); setForm({ key: f.key, value: Array.isArray(f.value) ? f.value.join("\n") : String(f.value), type: f.value_type, category: f.category, active: f.active, shareWithApi: f.share_with_api, validFrom: localDate(f.valid_from), validUntil: localDate(f.valid_until), version: f.version, collectionIds: f.collection_ids }); };
  return <section className="knowledge-profile" aria-label={t("个人信息")}><h3>{t("已确认的个人信息")}</h3><p>{t("手动确认的信息优先用于聊天。自动提取仅生成候选，未经确认不会覆盖这里的内容。")}</p>
    {error && <p role="alert">{t(error)}</p>}
    <form className="knowledge-collect knowledge-profile-form" onSubmit={(e) => { e.preventDefault(); void act(async () => {
      const value = form.type === "number" ? Number(form.value) : form.type === "boolean" ? form.value === "true" : form.type === "list" ? form.value.split("\n").filter(Boolean) : form.value;
      await knowledgeApi.saveFact({ ...form, value, validFrom: form.validFrom ? new Date(form.validFrom).toISOString() : null, validUntil: form.validUntil ? new Date(form.validUntil).toISOString() : null }); setForm(empty());
    }); }}>
      <label>{t("字段名称")}<input required pattern="[a-zA-Z][a-zA-Z0-9_]*" placeholder={t("例如 display_name、preferred_language")} value={form.key} disabled={form.version > 0} onChange={(e) => setForm({ ...form, key: e.target.value })} /></label>
      <label>{t("类型")}<select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, value: e.target.value === "boolean" ? "true" : "" })}><option value="text">{t("文字")}</option><option value="number">{t("数字")}</option><option value="boolean">{t("是 / 否")}</option><option value="list">{t("列表（每行一项）")}</option></select></label>
      <label>{t("内容")}{form.type === "boolean" ? <select aria-label={t("内容")} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })}><option value="true">{t("是")}</option><option value="false">{t("否")}</option></select> : <textarea aria-label={t("内容")} required maxLength={5000} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />}</label>
      <label>{t("分类")}<input required maxLength={100} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></label>
      <label>{t("生效时间（留空立即生效）")}<input type="datetime-local" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} /></label>
      <label>{t("失效时间（留空长期有效）")}<input type="datetime-local" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} /></label>
      <label className="knowledge-checkbox"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />{t("启用")}</label>
      <fieldset><legend>{t("加入知识库（用于语义检索）")}</legend>{collections.map((c) => <label key={c.id} className="knowledge-checkbox"><input type="checkbox" checked={form.collectionIds.includes(c.id)} onChange={(e) => setForm({ ...form, collectionIds: e.target.checked ? [...form.collectionIds, c.id].slice(0, 10) : form.collectionIds.filter((id) => id !== c.id) })} />{c.name}</label>)}</fieldset>
      <div className="knowledge-actions"><button className="knowledge-primary" disabled={busy}>{t("确认保存")}</button><button type="button" disabled={busy} onClick={() => setForm(empty())}>{t("新建字段")}</button></div>
    </form>
    {facts.map((f) => <article className="knowledge-item" key={f.id}><div><strong>{f.key}</strong><p>{JSON.stringify(f.value)} · {f.category} · {f.current ? t("生效中") : t("未生效")} {t("· 第")}{f.version} {t("版")}</p><small>{t("来源：")}{f.source === "manual" ? t("手动确认") : t("候选确认")}</small></div><div className="knowledge-actions"><button disabled={busy} onClick={() => edit(f)}>{t("编辑 / 停用")}</button><button disabled={busy} onClick={() => void act(async () => setHistory((await knowledgeApi.history(f.id)).data))}>{t("历史")}</button></div></article>)}
    {history && <details open><summary>{t("修改历史")}</summary>{history.map((row) => <p key={row.version}>{t("第")}{row.version} {t("版 ·")}{new Date(row.created_at).toLocaleString()} · {JSON.stringify(row.snapshot.value)} · {row.snapshot.active ? t("启用") : t("停用")}</p>)}</details>}
    <h3>{t("待确认候选")}</h3>{!candidates.length && <p>{t("暂无待确认信息。")}</p>}{candidates.map((c) => <article className="knowledge-item" key={c.id}><div><strong>{c.key}</strong><p>{c.operation === "delete" ? t("建议停用") : c.value}</p>{facts.find((f) => f.key === c.key) && <small>{t("当前：")}{JSON.stringify(facts.find((f) => f.key === c.key)?.value)}</small>}</div><div className="knowledge-actions"><button disabled={busy} onClick={() => void act(() => knowledgeApi.resolveCandidate(c.id, true, facts.find((f) => f.key === c.key)?.version ?? 0))}>{t("确认")}{c.operation === "delete" ? t("停用") : t("更新")}</button><button disabled={busy} onClick={() => void act(() => knowledgeApi.resolveCandidate(c.id, false, 0))}>{t("忽略")}</button></div></article>)}
  </section>;
}
