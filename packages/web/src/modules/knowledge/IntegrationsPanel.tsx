import { useEffect, useState } from "react";
import { knowledgeApi, type Collection, type AccessKey } from "./api.js";
const permissions = { "retrieval:read": "检索资料", "profile:read": "读取已允许共享的个人信息", "assets:read": "下载原件" };
export function IntegrationsPanel({ collections }: { collections: Collection[] }) {
  const [keys, setKeys] = useState<AccessKey[]>([]); const [editing, setEditing] = useState<AccessKey>();
  const [name, setName] = useState(""); const [ids, setIds] = useState<string[]>([]);
  const [scopes, setScopes] = useState<string[]>(["retrieval:read"]); const [expires, setExpires] = useState("");
  const [secret, setSecret] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""); const [enabled, setEnabled] = useState(false);
  const load = async () => setKeys((await knowledgeApi.keys()).data);
  useEffect(() => { void load().catch((e) => setError(e.message)); void knowledgeApi.status().then((s) => setEnabled(s.externalEnabled)).catch((e) => setError(e.message)); }, []);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(""); setNotice(""); setSecret(""); try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败，请重试"); } finally { setBusy(false); } };
  const base = `${window.location.origin}/api/rag/v1`;
  const curl = `curl "$KNOWLEDGE_BASE_URL/retrieval" -H "Authorization: Bearer $KNOWLEDGE_KEY" -H 'Content-Type: application/json' --data '${JSON.stringify({ query: "查询内容", collection_ids: ids.length ? ids : ["COLLECTION_UUID"], mode: "hybrid", top_k: 5 })}'`;
  return <section aria-label="外部接入"><h3>外部接入</h3><p>仅允许读取所选知识库。模型费用记入你的账号；个人信息还需逐条开启共享。</p>
    {!enabled && <p role="status">外部接口尚未启用。可以配置授权，启用后再连接客户端。</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {secret && <section aria-label="新密钥"><p>密钥仅显示这一次，关闭后无法再次查看。</p><input aria-label="新密钥" readOnly value={secret} /><button onClick={() => void navigator.clipboard.writeText(secret).then(() => setNotice("已复制密钥")).catch(() => setError("复制失败，请手动复制"))}>复制密钥</button><button onClick={() => setSecret("")}>已保存，关闭</button></section>}
    <form onSubmit={(e) => { e.preventDefault(); void act(async () => { const input = { name, collectionIds: ids, scopes, expiresAt: expires ? new Date(expires).toISOString() : null }; if (editing) await knowledgeApi.updateKey(editing, input); else setSecret((await knowledgeApi.createKey(input)).token); setEditing(undefined); setName(""); }); }}>
      <label>应用名称<input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <fieldset disabled={busy}><legend>授权知识库（1–10 个）</legend>{!collections.length && <p>请先创建知识库。</p>}{collections.map((c) => <label key={c.id} className="knowledge-checkbox"><input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds((old) => e.target.checked ? [...old, c.id] : old.filter((id) => id !== c.id))} />{c.name}</label>)}</fieldset>
      <fieldset disabled={busy}><legend>读取权限</legend>{Object.entries(permissions).map(([scope, label]) => <label key={scope} className="knowledge-checkbox"><input type="checkbox" checked={scopes.includes(scope)} onChange={(e) => setScopes((old) => e.target.checked ? [...old, scope] : old.filter((s) => s !== scope))} />{label}</label>)}</fieldset>
      <label>到期时间（可选）<input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
      <button disabled={busy || !name.trim() || !ids.length || ids.length > 10 || !scopes.length}>{editing ? "保存授权" : "创建密钥"}</button>
      {editing && <button type="button" onClick={() => { setEditing(undefined); setName(""); setIds([]); setScopes(["retrieval:read"]); setExpires(""); }}>取消编辑</button>}
    </form>
    {!keys.length && <p>尚未创建访问密钥。</p>}{keys.map((k) => <article className="knowledge-item" key={k.id}><div><strong>{k.name}</strong><p>{k.prefix}… · {k.revoked_at ? "已撤销" : k.expires_at && Date.parse(k.expires_at) <= Date.now() ? "已过期" : "有效"}</p><p>最近使用：{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "尚未使用"} · 到期：{k.expires_at ? new Date(k.expires_at).toLocaleString() : "长期"}</p><p>{k.collection_ids.map((id) => collections.find((c) => c.id === id)?.name ?? id).join("、")} · {k.scopes.map((s) => permissions[s as keyof typeof permissions]).join("、")}</p></div>
      {!k.revoked_at && <div className="knowledge-actions"><button disabled={busy} onClick={() => { setSecret(""); setEditing(k); setName(k.name); setIds(k.collection_ids); setScopes(k.scopes); setExpires(k.expires_at ? new Date(Date.parse(k.expires_at) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""); }}>编辑授权</button><button disabled={busy} onClick={() => { if (window.confirm("轮换后旧密钥立即失效，继续？")) void act(async () => setSecret((await knowledgeApi.rotateKey(k)).token)); }}>轮换</button><button disabled={busy} onClick={() => { if (window.confirm("撤销会阻止后续读取，无法收回已取得的资料。继续？")) void act(() => knowledgeApi.revokeKey(k)); }}>撤销</button></div>}
    </article>)}
    <h4>客户端配置</h4><p>KNOWLEDGE_BASE_URL：<code>{base}</code></p><p>KNOWLEDGE_KEY：保存在客户端服务端的环境变量中。</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{curl}</pre><button onClick={() => void navigator.clipboard.writeText(curl).then(() => setNotice("已复制示例（不含密钥）")).catch(() => setError("复制失败"))}>复制调用示例</button>
  </section>;
}
