import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client.js";
import { formatPoints, yuanToPoints } from "../lib/points.js";
import { RechargeModal } from "./RechargeModal.js";

interface BalanceSummary {
  balance: number;
  totalUsed: number;
  totalRecharged: number;
  usedRatio: number;
  allowBalanceFallback?: boolean;
}

export function PointsBalance() {
  const [summary, setSummary] = useState<BalanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [fallbackSaving, setFallbackSaving] = useState(false);
  const [fallbackError, setFallbackError] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    void api.getManagedBalance()
      .then(setSummary)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const updateBalanceFallback = useCallback((enabled: boolean) => {
    if (!summary || fallbackSaving) return;
    setFallbackSaving(true);
    setFallbackError(false);
    void api.setManagedBalanceFallback(enabled)
      .then((result) => {
        setSummary((current) => current ? { ...current, allowBalanceFallback: result.enabled } : current);
      })
      .catch(() => setFallbackError(true))
      .finally(() => setFallbackSaving(false));
  }, [fallbackSaving, summary]);

  return (
    <>
      <div className="brand-points-action">
        <button
          type="button"
          className="brand-points-main"
          onClick={() => {
            setDetailsOpen(true);
            load();
          }}
          title="查看我的积分"
        >
          <span className="brand-action-icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M9 9.5h6M9 14.5h6M12 8v8" />
            </svg>
          </span>
          <span className="brand-points-label">剩余积分</span>
          <strong className="brand-points-value">{loading && !summary ? "加载中" : error && !summary ? "--" : formatPoints(yuanToPoints(summary?.balance ?? 0))}</strong>
        </button>
        {summary?.allowBalanceFallback !== undefined && (
          <label className="brand-balance-fallback" title="订阅 Key 额度不足时，继续使用当前 Key，并从灵渠 AI 余额扣费">
            <span>积分不足时使用灵渠 AI 余额</span>
            <input
              type="checkbox"
              checked={summary.allowBalanceFallback}
              disabled={fallbackSaving}
              onChange={(event) => updateBalanceFallback(event.target.checked)}
            />
            <i aria-hidden />
          </label>
        )}
        {fallbackError && <small className="brand-balance-fallback-error">设置保存失败，请重试</small>}
      </div>

      {detailsOpen && createPortal(
        <div className="account-dialog-overlay" onClick={() => setDetailsOpen(false)}>
          <section className="account-dialog points-dialog" role="dialog" aria-modal="true" aria-labelledby="points-title" onClick={(event) => event.stopPropagation()}>
            <header className="account-dialog-head">
              <span>
                <h2 id="points-title">我的积分</h2>
                <p>积分仅用于 lot-agent 服务消费，{formatPoints(100)} 积分 = 1 元。</p>
              </span>
              <button type="button" onClick={() => setDetailsOpen(false)} aria-label="关闭">×</button>
            </header>

            <div className="points-dialog-body">
              {loading && !summary && <div className="account-dialog-state">正在加载积分…</div>}
              {error && !summary && (
                <div className="account-dialog-state error">
                  积分加载失败
                  <button type="button" onClick={load}>重试</button>
                </div>
              )}
              {summary && (
                <>
                  <div className="points-remaining-card">
                    <small>我的剩余积分</small>
                    <strong>{formatPoints(yuanToPoints(summary.balance))}</strong>
                  </div>

                  <div className="points-history-row">
                    <div>
                      <small>历史累计使用积分</small>
                      <strong>{formatPoints(yuanToPoints(summary.totalUsed))}</strong>
                    </div>
                    <div>
                      <small>历史充值积分</small>
                      <strong>{formatPoints(yuanToPoints(summary.totalRecharged))}</strong>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="recharge-submit points-recharge-button"
                    onClick={() => {
                      setDetailsOpen(false);
                      setRechargeOpen(true);
                    }}
                  >
                    充值积分
                  </button>
                </>
              )}
            </div>
          </section>
        </div>,
        document.body
      )}

      {rechargeOpen && createPortal(
        <RechargeModal
          onClose={() => setRechargeOpen(false)}
          onBalanceChange={() => load()}
        />,
        document.body
      )}
    </>
  );
}
