/** Only fixed diagnostics are displayed/logged: never codes, tokens or server bodies. */
export function loginDiagnostic(stage: "mode" | "wechat" | "server", error: unknown): string {
  if (stage === "wechat") return "微信授权失败，请检查导入项目的 AppID 和开发者工具登录状态";
  const value = error && typeof error === "object" ? error as { status?: number; message?: string } : {};
  const message = typeof value.message === "string" ? value.message : "";
  if (value.status === 0) {
    if (/domain list|合法域名/i.test(message)) {
      return "请求域名未通过校验，请检查合法域名配置（本地调试可勾选不校验合法域名）";
    }
    if (/timeout|timed out/i.test(message)) return "连接服务器超时，请检查网络后重试";
    if (/ssl|certificate/i.test(message)) return "服务器安全连接失败，请检查 HTTPS 证书";
    return "无法连接服务器，请检查网络和服务器地址";
  }
  const label = stage === "mode" ? "获取登录配置失败" : "服务端登录失败";
  const status = typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599
    ? `（HTTP ${value.status}）` : "";
  return `${label}${status}，请稍后重试`;
}
