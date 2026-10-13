import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { ApiClientError, request } from "../api/client.js";
import { useI18n } from "../i18n/index.js";
import "./feishu.css";

interface Setup {
  id: string; phase: "registration" | "authorization" | "verification" | "complete" | "failed" | "expired";
  url?: string; expiresAt: number; pollAfter: number; deliveryUnknown?: boolean;
}
interface Status {
  setup?: Setup | null;
  configured: boolean; connected: boolean; canSendAsUser: boolean;
  needsReauthorization?: boolean; messageConnection?: string;
  account: { name: string; openId: string } | null;
  contacts: Array<{ alias: string; open_id: string }>;
  recent: Array<{ message_id: string; status: string; created_at: string }>;
}

export function FeishuSettings({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [status,setStatus] = useState<Status | null>(null);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const [qr,setQr] = useState("");
  const [code,setCode] = useState("");
  const [alias,setAlias] = useState("");
  const [openId,setOpenId] = useState("");
  const [recipient,setRecipient] = useState("");
  const [text,setText] = useState("");
  const [reply,setReply] = useState(false);
  const [requestId,setRequestId] = useState(() => crypto.randomUUID());
  const load = useCallback(async (signal?: AbortSignal, quiet = false) => {
    if (!quiet) { setLoading(true); setError(""); }
    const timeout = AbortSignal.timeout(15_000);
    try {
      const next = await request<Status>("/feishu/status",{ signal: signal ? AbortSignal.any([signal,timeout]) : timeout });
      if (!signal?.aborted) {
        setStatus(next);
        if (quiet) setError(current => ["读取飞书连接状态超时，请检查网络后重试。","无法读取飞书连接状态，请稍后重试。"].includes(current) ? "" : current);
      }
    } catch (e) {
      if (signal?.aborted) return;
      if (!quiet) setStatus(null);
      setError(e instanceof ApiClientError && e.status === 404
        ? "当前服务器尚未提供飞书接入，请更新并重启服务端，或检查服务器地址。"
        : timeout.aborted ? "读取飞书连接状态超时，请检查网络后重试。"
        : "无法读取飞书连接状态，请稍后重试。");
    } finally {
      if (!signal?.aborted && !quiet) setLoading(false);
    }
  },[]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  },[load]);
  const setup = status?.setup;
  const waitingForScan = setup?.phase === "registration" || setup?.phase === "authorization";
  useEffect(() => {
    // Binding completes before the server's socket sync. Keep its live state
    // current without resetting an in-flight device authorization request.
    if (busy || !status?.configured || waitingForScan || (!status.connected && setup?.phase !== "verification")) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try { await load(controller.signal, true); }
      finally { pending = false; }
    };
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  },[load,busy,status?.configured,status?.connected,setup?.phase,waitingForScan]);
  useEffect(() => {
    if (!setup || ["complete","failed","expired"].includes(setup.phase)) return;
    const timer = window.setTimeout(() => setStatus(prev => prev?.setup?.id === setup.id
      ? { ...prev,setup:{ ...prev.setup,phase:"expired",url:undefined } } : prev),Math.max(0,setup.expiresAt-Date.now()));
    return () => window.clearTimeout(timer);
  },[setup]);
  useEffect(() => {
    setQr("");
    if (!setup?.url) return;
    let cancelled = false;
    void QRCode.toDataURL(setup.url,{ width:240,margin:2,errorCorrectionLevel:"M" })
      .then(value => { if (!cancelled) setQr(value); }).catch(() => {});
    return () => { cancelled = true; };
  },[setup?.url]);
  useEffect(() => {
    if (!setup || !["registration","authorization"].includes(setup.phase)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const next = await request<Setup>(`/feishu/setup/${setup.id}/poll`,{ method:"POST",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(25_000)]) });
        if (!controller.signal.aborted) {
          setError("");
          setStatus(prev => prev?.setup?.id === setup.id ? { ...prev,setup:next } : prev);
        }
      } catch {
        if (controller.signal.aborted) return;
        setError("接入状态查询失败，正在重试。也可刷新连接状态。");
        setStatus(prev => prev?.setup?.id === setup.id ? { ...prev,setup:{ ...prev.setup,pollAfter:Date.now()+10_000 } } : prev);
      }
    },Math.max(1000,setup.pollAfter-Date.now()));
    return () => { controller.abort(); window.clearTimeout(timer); };
  },[setup]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await work(); } catch(e) { setError(e instanceof Error ? e.message : "飞书请求失败，请稍后查看连接状态"); }
    finally { setBusy(false); }
  };
  const authorize = () => act(async () => {
    const result = await request<Setup>("/feishu/authorize",{ method: "POST" });
    setCode(""); setStatus(prev => prev ? { ...prev,setup:result } : prev);
  });
  const send = () => act(async () => {
    const result = await request<{ messageId: string }>("/feishu/messages",{ method: "POST",body: JSON.stringify({ recipient,text,reply,requestId }) });
    setNotice(`${t("已以本人身份发送")} · ${result.messageId}`);
    setText(""); setRequestId(crypto.randomUUID());
  });
  return <div className="account-dialog-overlay" onClick={onClose}>
    <section className="account-dialog feishu-dialog" role="dialog" aria-modal="true" aria-labelledby="feishu-title" onClick={e => e.stopPropagation()}>
      <header className="account-dialog-head"><span><h2 id="feishu-title">{t("飞书接入")}</h2>
        <p>{t("扫码创建专属机器人，飞书任务自动汇总到通用 Agent 的置顶会话。")}</p></span>
        <button type="button" onClick={onClose} aria-label={t("关闭")}>×</button></header>
      <div className="feishu-body">
        {error && <p role="alert" className="phone-binding-message error">{t(error)}</p>}
        {notice && <p role="status" className="phone-binding-message success">{notice}</p>}
        {loading && <p role="status">{t("加载中…")}</p>}
        {status && !status.configured && <p>{t("服务端尚未配置飞书接入")}</p>}
        <div className="feishu-actions">
          <button type="button" disabled={busy || loading} onClick={() => void act(load)}>{t("刷新连接状态")}</button>
        </div>
        {status?.configured && <>
          <p>{status.connected ? `${t("已绑定飞书账号")}：${status.account?.name}` : t("尚未绑定飞书账号")}</p>
          {status.connected && status.messageConnection && <p className="feishu-hint">{t("飞书消息通道")}：{t(({ connected:"已连接",connecting:"连接中",reconnecting:"重新连接中",failed:"连接失败",idle:"尚未连接",disabled:"未启用" } as Record<string,string>)[status.messageConnection] ?? status.messageConnection)}</p>}
          {status.needsReauthorization && <p role="status">{t("飞书授权已失效，请重新连接")}</p>}
          {status.connected && !status.canSendAsUser && <p role="status">{t("飞书权限不足，请重新授权；若仍失败请联系企业管理员")}</p>}
          <div className="feishu-actions">
            <button type="button" disabled={busy || (!!setup && ["registration","authorization","verification"].includes(setup.phase) && setup.expiresAt > Date.now())} onClick={() => void authorize()}>{t(status.connected ? "重新授权" : "连接飞书")}</button>
            {(status.connected || setup) && <button type="button" disabled={busy} onClick={() => void act(async () => {
              await request("/feishu/connection",{ method:"DELETE" }); setCode(""); await load();
            })}>{t(status.connected ? "断开连接" : "取消接入")}</button>}
          </div>
          {setup && ["registration","authorization"].includes(setup.phase) && <div className="feishu-setup">
            <strong>{t(setup.phase === "registration" ? "1. 扫码创建机器人" : "2. 扫码授权飞书账号")}</strong>
            <p className="feishu-hint">{t(setup.phase === "registration" ? "使用飞书扫描二维码，按官方页面提示确认，无需手动创建应用或配置权限。" : "使用同一个飞书账号确认授权，完成后将自动进入绑定验证。")}</p>
            {qr && <img className="feishu-qr" src={qr} width={240} height={240} alt={t("飞书官方接入二维码")} />}
            {setup.url && <a href={setup.url} target="_blank" rel="noopener noreferrer">{t("打开飞书官方页面")}</a>}
            <p className="feishu-hint" role="status">{t("等待飞书确认，页面会自动更新。")}</p>
            <p className="feishu-hint">{t("请保持此窗口打开以完成接入；关闭后可重新打开继续。")}</p>
          </div>}
          {setup?.phase === "verification" && <form className="feishu-form feishu-setup" onSubmit={e => { e.preventDefault(); void act(async () => {
            try { await request(`/feishu/setup/${setup.id}/confirm`,{ method:"POST",body:JSON.stringify({ code }) }); }
            catch (error) { await load(); throw error; }
            setCode(""); await load(); window.dispatchEvent(new Event("lot:feishu-connected"));
            setNotice(t("飞书已连接，任务将汇总到通用 Agent 顶部的飞书会话。"));
          }); }}>
            <strong>{t("3. 验证机器人私聊中的验证码")}</strong>
            <p className="feishu-hint">{t("机器人已向你的飞书私聊发送六位验证码，请在 10 分钟内输入。请勿向他人提供验证码。")}</p>
            {setup.deliveryUnknown && <p role="status">{t("验证码投递结果待确认，请先查看飞书私聊；如未收到，可取消接入后重试。")}</p>}
            <label htmlFor="feishu-code">{t("绑定验证码")}</label>
            <input id="feishu-code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g,""))} required disabled={busy} />
            <button type="submit" disabled={busy || !/^\d{6}$/.test(code)}>{t("确认绑定")}</button>
          </form>}
          {setup && ["failed","expired"].includes(setup.phase) && <p role="status">{t("接入未完成或已过期，请重新连接飞书。企业限制可能需要管理员确认。")}</p>}
          {status.connected && <>
            <form onSubmit={e => { e.preventDefault(); void send(); }} className="feishu-form">
              <h3>{t("以本人身份发送")}</h3>
              <label className="feishu-checkbox"><input type="checkbox" checked={reply} disabled={busy} onChange={e => {
                setReply(e.target.checked); setRecipient(""); setRequestId(crypto.randomUUID());
              }} />{t("回复指定消息")}</label>
              <label htmlFor="feishu-recipient">{t(reply ? "消息 ID（om_ 开头）" : "联系人别名或飞书用户 ID（ou_ 开头）")}</label>
              <input id="feishu-recipient" list={reply ? undefined : "feishu-contacts"} required maxLength={120} value={recipient} disabled={busy}
                onChange={e => { setRecipient(e.target.value); setRequestId(crypto.randomUUID()); }} />
              <datalist id="feishu-contacts">{status.contacts.map(c => <option key={c.alias} value={c.alias}>{c.open_id}</option>)}</datalist>
              <label htmlFor="feishu-text">{t("消息原文")}</label>
              <textarea id="feishu-text" required rows={4} maxLength={3000} value={text} disabled={busy}
                onChange={e => { setText(e.target.value); setRequestId(crypto.randomUUID()); }} />
              <button type="submit" disabled={busy || !status.canSendAsUser || status.needsReauthorization || !recipient.trim() || !text.trim()}>{t(busy ? "处理中…" : "以本人身份发送")}</button>
            </form>
            <form className="feishu-form" onSubmit={e => { e.preventDefault(); void act(async () => {
              await request("/feishu/contacts",{ method: "POST",body: JSON.stringify({ alias,openId }) });
              setAlias(""); setOpenId(""); await load();
            }); }}>
              <h3>{t("常用联系人")}</h3>
              <label htmlFor="feishu-alias">{t("联系人别名")}</label><input id="feishu-alias" value={alias} onChange={e => setAlias(e.target.value)} required maxLength={40} disabled={busy} />
              <label htmlFor="feishu-open-id">{t("飞书用户 ID（ou_ 开头）")}</label><input id="feishu-open-id" value={openId} onChange={e => setOpenId(e.target.value)} required disabled={busy} />
              <p className="feishu-hint">{t("用户 ID 需来自当前飞书应用，可先由应用管理员提供。保存别名后即可按姓名发送。")}</p>
              <button type="submit" disabled={busy}>{t("保存联系人")}</button>
            </form>
            <ul className="feishu-contacts">{status.contacts.map(c => <li key={c.alias}><span>{c.alias} <small>{c.open_id}</small></span>
              <button type="button" disabled={busy} onClick={() => void act(async () => {
                await request(`/feishu/contacts/${encodeURIComponent(c.alias)}`,{ method: "DELETE" }); await load();
              })}>{t("删除")}</button></li>)}</ul>
            <p className="feishu-hint">{t("在飞书私聊机器人：/send 联系人别名 消息原文；/help 查看帮助；/cancel 取消任务。")}</p>
            <p className="feishu-hint">{t("图片、视频生成请求统一回复：")}{"后续支持，持续开发中..."}</p>
            {status.recent.length > 0 && <details><summary>{t("最近飞书任务")}</summary><ul className="feishu-contacts">
              {status.recent.map(j => <li key={j.message_id}><small>{j.message_id}</small><span>{t({ pending:"待处理",running:"运行中",completed:"已完成",failed:"失败",cancelled:"已取消",unknown:"结果待核实",reply_unknown:"结果已处理，回传待核实" }[j.status] ?? j.status)}</span></li>)}
            </ul></details>}
          </>}
        </>}
      </div>
    </section>
  </div>;
}
