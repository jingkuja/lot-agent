import { useEffect, useMemo, useState } from "react";
import { api, type RechargeInfo, type RechargeOrder } from "../api/client.js";
import {
  MIN_RECHARGE_POINTS,
  POINTS_PER_YUAN,
  RECHARGE_POINTS_STEP,
  formatPoints,
  isValidRechargePoints,
  pointsToYuan,
  rechargeDiscountForPoints,
  rechargeDiscountTiers,
  rechargePayableYuan,
  yuanToPoints,
} from "../lib/points.js";

interface RechargeModalProps {
  onClose: () => void;
  onBalanceChange?: (balanceYuan: number) => void;
}

function statusText(status: RechargeOrder["status"]): string {
  if (status === "credited") return "充值成功，积分已到账";
  if (status === "crediting" || status === "paid") return "支付成功，积分入账中…";
  if (status === "payment_failed") return "支付订单创建失败";
  if (status === "credit_failed") return "积分入账暂时失败，请联系管理员处理";
  return "等待完成支付";
}

function safePaymentUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function openPaymentPage(raw: string | undefined, pendingWindow?: Window | null): boolean {
  const url = safePaymentUrl(raw);
  if (!url) {
    pendingWindow?.close();
    return false;
  }
  if (pendingWindow && !pendingWindow.closed) {
    try {
      pendingWindow.location.href = url;
      return true;
    } catch {
      pendingWindow.close();
    }
  }
  const popup = window.open(url, "_blank");
  if (!popup) return false;
  popup.opener = null;
  return true;
}

function openPendingAlipayWindow(): Window | null {
  const popup = window.open("about:blank", "_blank");
  if (!popup) return null;
  popup.opener = null;
  popup.document.title = "支付宝支付";
  popup.document.body.textContent = "正在创建支付订单，请稍候…";
  return popup;
}

function formatDiscount(discount: number): string {
  return `${Number((discount * 10).toFixed(2))} 折`;
}

export function RechargeModal({ onClose, onBalanceChange }: RechargeModalProps) {
  const [pointsInput, setPointsInput] = useState("1000");
  const [balance, setBalance] = useState<number | null>(null);
  const [order, setOrder] = useState<RechargeOrder | null>(null);
  const [rechargeInfo, setRechargeInfo] = useState<RechargeInfo | null>(null);
  const [paymentMethod, setPaymentMethod] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const points = Number(pointsInput);
  const validPoints = isValidRechargePoints(points);
  const originalPayable = pointsToYuan(validPoints ? points : 0);
  const appliedDiscount = rechargeDiscountForPoints(validPoints ? points : 0, rechargeInfo?.amountDiscount);
  const discountTiers = useMemo(() => rechargeDiscountTiers(rechargeInfo?.amountDiscount), [rechargeInfo?.amountDiscount]);
  const displayDiscountTiers = discountTiers.filter((tier) => tier.discount < 1);
  const payable = useMemo(() => rechargePayableYuan(validPoints ? points : 0, rechargeInfo?.amountDiscount), [points, rechargeInfo?.amountDiscount, validPoints]);

  const refreshBalance = () => {
    void api.getManagedBalance()
      .then((result) => {
        setBalance(result.balance);
        onBalanceChange?.(result.balance);
      })
      .catch(() => setBalance(null));
  };

  useEffect(refreshBalance, []);

  useEffect(() => {
    void api.getRechargeInfo()
      .then((info) => {
        setRechargeInfo(info);
        setPaymentMethod((current) => current || info.paymentMethods[0]?.type || "");
      })
      .catch((reason) => {
        setRechargeInfo({ enabled: false, paymentMethods: [], amountDiscount: {} });
        setError(reason instanceof Error ? reason.message : "支付方式加载失败");
      });
  }, []);

  useEffect(() => {
    if (!order || !["pending", "paid", "crediting"].includes(order.status)) return;
    const timer = window.setInterval(() => {
      void api.getRechargeOrder(order.transactionId).then((next) => {
        setOrder((current) => current?.transactionId === next.transactionId
          ? {
              ...current,
              ...next,
              paymentKind: next.paymentKind ?? current.paymentKind,
              paymentMethod: next.paymentMethod ?? current.paymentMethod,
              codeUrl: next.codeUrl ?? current.codeUrl,
              payUrl: next.payUrl ?? current.payUrl,
            }
          : next);
        if (next.status === "credited") refreshBalance();
      }).catch(() => {});
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [order?.transactionId, order?.status]);

  const createOrder = async () => {
    if (!validPoints) return;
    const pendingWindow = paymentMethod === "alipay" ? openPendingAlipayWindow() : null;
    setSubmitting(true);
    setError(null);
    try {
      const next = await api.createRechargeOrder(points, paymentMethod);
      setOrder(next);
      if (paymentMethod === "alipay" && !openPaymentPage(next.payUrl, pendingWindow)) {
        setError("浏览器阻止了支付页，请点击下方按钮重新打开");
      }
    } catch (reason) {
      pendingWindow?.close();
      setError(reason instanceof Error ? reason.message : "支付订单创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="account-dialog-overlay" onClick={onClose}>
      <section className="account-dialog recharge-dialog" role="dialog" aria-modal="true" aria-labelledby="recharge-title" onClick={(event) => event.stopPropagation()}>
        <header className="account-dialog-head">
          <span>
            <h2 id="recharge-title">积分充值</h2>
            <p>输入充值积分，系统按 {POINTS_PER_YUAN} 积分 = 1 元自动计算应付金额。</p>
          </span>
          <button type="button" onClick={onClose} aria-label="关闭">×</button>
        </header>

        <div className="recharge-body">
          <div className="recharge-balance">
            <small>我的剩余积分</small>
            <strong>{balance == null ? "—" : formatPoints(yuanToPoints(balance))}</strong>
          </div>

          {!order && (
            <div className="recharge-form">
              <label htmlFor="recharge-points">充值积分</label>
              <div className={`recharge-points-input ${pointsInput && !validPoints ? "invalid" : ""}`}>
                <input
                  id="recharge-points"
                  type="number"
                  min={MIN_RECHARGE_POINTS}
                  step={RECHARGE_POINTS_STEP}
                  inputMode="numeric"
                  value={pointsInput}
                  onChange={(event) => setPointsInput(event.target.value)}
                  aria-describedby="recharge-points-hint"
                />
                <span>积分</span>
              </div>
              <small id="recharge-points-hint">最低充值 {MIN_RECHARGE_POINTS} 积分，请输入 {RECHARGE_POINTS_STEP} 的整数倍</small>

              <fieldset className="recharge-payment-methods">
                <legend>收款方式</legend>
                <div>
                  {rechargeInfo?.paymentMethods.map((method) => (
                    <button
                      key={method.type}
                      type="button"
                      className={paymentMethod === method.type ? "selected" : ""}
                      aria-pressed={paymentMethod === method.type}
                      onClick={() => setPaymentMethod(method.type)}
                    >
                      <span aria-hidden>{method.type === "alipay" ? "支" : method.type === "wxpay" ? "微" : "付"}</span>
                      {method.name}
                    </button>
                  ))}
                </div>
              </fieldset>

              {rechargeInfo && (!rechargeInfo.enabled || rechargeInfo.paymentMethods.length === 0) && (
                <div className="recharge-notice error">暂时没有可用的收款方式</div>
              )}

              {displayDiscountTiers.length > 0 && (
                <div className="recharge-discount-list" aria-label="充值优惠">
                  {displayDiscountTiers.map((tier) => (
                    <div className="recharge-discount-hint" key={tier.threshold}>
                      充值满 {formatPoints(tier.threshold)} 积分享 {formatDiscount(tier.discount)}
                    </div>
                  ))}
                </div>
              )}

              <div className="recharge-payable">
                <span>需要付款</span>
                <span className="recharge-payable-price">
                  {appliedDiscount < 1 && <del>¥ {originalPayable.toFixed(2)}</del>}
                  <strong>¥ {payable.toFixed(2)}</strong>
                </span>
              </div>

              {error && <div className="recharge-notice error">{error}</div>}
              <button type="button" className="recharge-submit" disabled={!validPoints || !rechargeInfo?.enabled || !paymentMethod || submitting} onClick={() => void createOrder()}>
                {submitting ? "正在创建支付订单…" : `立即充值 ${validPoints ? formatPoints(points) : ""} 积分`}
              </button>
            </div>
          )}

          {order && (
            <div className="recharge-checkout">
              <div className={`recharge-status ${order.status}`}>{statusText(order.status)}</div>
              <div className="recharge-order-summary">
                <span>{formatPoints(order.points ?? points)} 积分</span>
                <strong>¥ {(order.amount ?? payable).toFixed(2)}</strong>
              </div>
              {order.status !== "credited" && order.paymentKind === "qrcode" && order.codeUrl && (
                <div className="recharge-wechat-payment">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(order.codeUrl)}`}
                    alt="微信支付二维码"
                  />
                  <strong>请使用微信扫码支付</strong>
                  <small>支付完成后，本页会自动刷新积分余额</small>
                </div>
              )}
              {order.status !== "credited" && order.paymentKind === "redirect" && (
                <div className="recharge-alipay-payment">
                  <p>支付宝支付页已在新标签中打开，请在支付完成后返回此页面。</p>
                  <button type="button" className="recharge-open-window" onClick={() => {
                    if (!openPaymentPage(order.payUrl)) setError("无法打开支付宝支付地址");
                  }}>重新打开支付宝支付页</button>
                </div>
              )}
              {error && <div className="recharge-notice error">{error}</div>}
              {order.status === "credited" && (
                <button type="button" className="recharge-submit" onClick={() => setOrder(null)}>继续充值</button>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
