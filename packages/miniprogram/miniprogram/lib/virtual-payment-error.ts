// WeChat's requestVirtualPayment failure codes, independent of server order state.
// https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html
const messages: Record<number, string> = {
  1001: "支付参数有误，请联系管理员",
  [-1]: "微信支付未完成；如已扣款，请稍后查看积分",
  [-4]: "微信暂时限制本次支付，请稍后重试",
  [-5]: "支付开通结果尚未确认，请稍后重试",
  [-15001]: "支付参数有误，请联系管理员",
  [-15002]: "支付订单号已使用，请重新点击支付",
  [-15003]: "微信支付服务繁忙，请稍后重试",
  [-15004]: "支付币种配置有误，请联系管理员",
  [-15005]: "微信身份签名校验失败，请重新进入小程序后重试",
  [-15006]: "支付签名校验失败，请联系管理员检查支付配置",
  [-15007]: "微信登录已过期，请重新点击支付",
  [-15008]: "商户尚未完成支付进件，请联系管理员",
  [-15009]: "充值商品尚未发布，请联系管理员",
  [-15010]: "充值商品尚未在微信后台发布，请联系管理员",
  [-15011]: "当前小程序版本不能使用沙箱支付，请联系管理员",
  [-15012]: "微信已关闭本次订单，请重新点击支付",
  [-15013]: "商品价格与微信后台不一致，请联系管理员",
  [-15014]: "充值商品发布尚未生效，通常在发布后约 10 分钟生效，请稍后重试",
  [-15016]: "支付数据格式有误，请联系管理员",
  [-15017]: "商户收款功能受限，请联系管理员",
  [-15018]: "充值商品尚未通过审核，请联系管理员",
  [-15019]: "商户收款功能受限，请联系管理员",
  [-15020]: "支付操作过于频繁，请稍后重试",
  [-15021]: "小程序支付暂时限流，请稍后重试",
};

export function virtualPaymentFailure(error: unknown): { cancelled: boolean; code?: number; message: string; detail?: string } {
  const data = error && typeof error === "object" ? error as { errCode?: unknown; errMsg?: unknown; err_code?: unknown; err_msg?: unknown } : {};
  const nativeCode = data.errCode ?? data.err_code;
  const parsed = typeof nativeCode === "number" ? nativeCode
    : typeof nativeCode === "string" && /^-?\d+$/.test(nativeCode) ? Number(nativeCode) : undefined;
  const code = Number.isSafeInteger(parsed) ? parsed : undefined;
  const rawMessages = [data.errMsg, data.err_msg, error instanceof Error ? error.message : undefined]
    .filter((value): value is string => typeof value === "string" && !!value.trim());
  if (code === -2 || rawMessages.some(raw => /\bcancel(?:led|ed)?\b/i.test(raw))) return { cancelled: true, code, message: "已取消支付" };
  // Preserve useful native failure details, but never print signed URLs or credentials.
  const details = rawMessages.map(raw => raw.replace(/^requestVirtualPayment:fail[:\s]*/i, "")
    .replace(/https?:\/\/\S+/gi, "[链接已隐藏]")
    .replace(/(["']?(?:session[_-]?key|access[_-]?token|app[_-]?key|paySig|signature|openid|unionid)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[已隐藏]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ").trim()).filter(Boolean);
  const detail = [...new Set(details)].join("；").slice(0, 300);
  // Prefer a specific native reason when the numeric code is generic or absent.
  const iosPaymentUnavailable = rawMessages.some(raw => /当前商户尚未开启\s*iOS\s*支付/i.test(raw));
  const productNotPublished = rawMessages.some(raw => /\bproduct_id_not_publish\b/i.test(raw));
  const productRecentlyPublished = rawMessages.some(raw => /\bcoin_or_product_id_created_in_recently\b/i.test(raw));
  const summary = iosPaymentUnavailable ? "苹果支付暂不可用，请联系管理员"
    : productNotPublished ? messages[-15010]
    : productRecentlyPublished ? messages[-15014]
    : code !== undefined && messages[code] ? messages[code]
    : detail ? "支付未完成" : "微信未返回支付结果，请稍后查看积分";
  const label = typeof data.errMsg === "string" || typeof data.err_msg === "string" ? "微信返回" : "原因";
  const explanation = detail ? `\n${label}：${detail}` : code !== undefined ? "\n微信未提供具体错误原因" : "";
  const message = `${summary}${code === undefined ? "" : `（错误码：${code}）`}${explanation}`;
  return { cancelled: false, code, message, detail };
}
