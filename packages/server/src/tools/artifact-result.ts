/**
 * Appended to a document/PPT tool result. The web renders a download button
 * from the tool's own (trustworthy) URL, so the model must NOT relay the link
 * itself — when it paraphrases a long URL + UUID it occasionally mangles the
 * host or path and hands the user a broken link. Keep the `下载链接：<url>` line
 * above this hint intact: the web parses it (see web/lib/download-artifact).
 */
export const DOWNLOAD_RESULT_HINT =
  "[系统提示] 下载入口已由前端自动展示，请勿在回复中输出或复述上面的下载链接、URL 或 asset_id；" +
  "只需用一句话告知用户文件已生成即可。";
