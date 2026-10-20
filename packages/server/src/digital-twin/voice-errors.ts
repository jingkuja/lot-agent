import { isQwenCreateRejected, ProviderError, QwenVoiceError } from "@lot-agent/core";

/** Static copy only; never show upstream free text or mistake every 4xx for bad audio. */
export function voiceEnrollmentErrorMessage(error: ProviderError): string {
  // Unknown creation outcomes must retain the read-only recovery instruction.
  if (!isQwenCreateRejected(error)) return "声音复刻请求未完成，请刷新音色状态核实";
  const code = error instanceof QwenVoiceError ? error.vendorCode : undefined;
  if (code === "Arrearage" || error.httpStatus === 402) return "声音复刻服务账号额度不足，请联系管理员";
  if (error.httpStatus === 401 || error.httpStatus === 403 || ["InvalidApiKey", "AccessDenied", "Forbidden"].includes(code ?? "")) {
    return "声音复刻服务鉴权或权限不足，请联系管理员检查千问配置";
  }
  if (error.httpStatus === 429 || code?.startsWith("Throttling")) return "声音复刻服务请求受限，请稍后重试或联系管理员";
  if (["BadRequest.InputDownloadFailed", "InvalidFile.DownloadFailed", "InvalidURL.ConnectionRefused", "InvalidURL.Timeout"].includes(code ?? "")) {
    return "千问无法下载声音样例，请联系管理员检查样例公网访问";
  }
  if (code?.startsWith("Audio.") || ["BadRequest.UnsupportedFileFormat", "BadRequest.TooLarge"].includes(code ?? "")) {
    return "千问未能处理声音样例，请检查音频格式、采样率、时长及清晰人声";
  }
  return "千问未接受本次声音复刻，请联系管理员查看错误原因";
}
