import { useI18n } from "../i18n/index.js";
import { useCallback, useEffect, useState } from "react";
import { api, type RechargeRecord } from "../api/client.js";

interface RechargeHistoryModalProps {
  onClose: () => void;
}

const dateOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

function formatRechargeTime(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(locale, dateOptions).format(date);
}

function paymentMethodLabel(value: string) {
  if (value === "alipay") return "支付宝";
  if (value === "wxpay") return "微信支付";
  return value || "—";
}

function formatAmount(record: RechargeRecord, locale = "zh-CN") {
  if (!Number.isFinite(record.amount)) return "—";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: record.currency || "CNY",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(record.amount);
  } catch {
    return `¥${record.amount.toFixed(2)}`;
  }
}

export function RechargeHistoryModal({ onClose }: RechargeHistoryModalProps) {
  const { t, locale } = useI18n();
  const [records, setRecords] = useState<RechargeRecord[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const load = useCallback(async (requestedPage: number) => {
    if (requestedPage === 1) {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
      setLoadMoreError(null);
    }
    try {
      const result = await api.getRechargeHistory(requestedPage);
      setRecords((current) => requestedPage === 1 ? result.records : [...current, ...result.records]);
      setPage(result.page);
      setTotal(result.total);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "充值明细加载失败";
      if (requestedPage === 1) setError(message);
      else setLoadMoreError(message);
    } finally {
      if (requestedPage === 1) setLoading(false);
      else setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load(1);
  }, [load]);

  return (
    <div className="account-dialog-overlay" onClick={onClose}>
      <section className="account-dialog recharge-history-dialog" role="dialog" aria-modal="true" aria-labelledby="recharge-history-title" onClick={(event) => event.stopPropagation()}>
        <header className="account-dialog-head">
          <div>
            <h2 id="recharge-history-title">{t("充值明细")}</h2>
            <p>{t("仅显示当前账号充值成功的记录")}</p>
          </div>
          <button type="button" aria-label={t("关闭")} onClick={onClose}>×</button>
        </header>
        <div className="recharge-history-body">
          {loading && <div className="account-dialog-state">{t("正在加载充值明细…")}</div>}
          {!loading && error && (
            <div className="account-dialog-state error">
              <span>{t(error)}</span>
              <button type="button" onClick={() => void load(1)}>{t("重新加载")}</button>
            </div>
          )}
          {!loading && !error && records.length === 0 && (
            <div className="account-dialog-state">
              <span className="recharge-history-empty-icon" aria-hidden>≡</span>
              <strong>{t("暂无充值明细")}</strong>
              <small>{t("充值成功后的记录会显示在这里")}</small>
            </div>
          )}
          {!loading && !error && records.length > 0 && (
            <div className="recharge-history-table-wrap">
              <table className="recharge-history-table">
                <thead>
                  <tr>
                    <th scope="col">{t("充值时间")}</th>
                    <th scope="col">{t("充值渠道")}</th>
                    <th scope="col">{t("充值金额")}</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record.transactionId}>
                      <td data-label={t("充值时间")}>{formatRechargeTime(record.rechargedAt, locale)}</td>
                      <td data-label={t("充值渠道")}>{t(paymentMethodLabel(record.paymentMethod))}</td>
                      <td data-label={t("充值金额")} className="recharge-history-amount">{formatAmount(record, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {records.length < total && (
                <button type="button" className="recharge-history-more" disabled={loadingMore} onClick={() => void load(page + 1)}>
                  {loadingMore ? t("正在加载…") : t("加载更多")}
                </button>
              )}
              {loadMoreError && <div className="recharge-history-more-error">{t("加载失败，请重试")}</div>}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
