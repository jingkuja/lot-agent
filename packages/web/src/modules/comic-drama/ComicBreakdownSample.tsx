import { useState } from "react";
import { useI18n } from "../../i18n/index.js";

const sample = {
  before: ["一段长镜头交代雨夜、便利店与柜台相遇。"],
  after: ["林夏在雨夜走到亮灯的便利店门前。", "店主听到门铃，从柜台后抬头。"],
};

export function ComicBreakdownSample() {
  const { t } = useI18n();
  const [mode, setMode] = useState<"replace" | "append">("replace");
  return <details className="comic-breakdown-sample">
    <summary>{t("拆分镜差异样例")}</summary>
    <p>{t("使用示例数据预览，当前剧集不会修改。")}</p>
    <div className="comic-actions">
      <button type="button" aria-pressed={mode === "replace"} onClick={() => setMode("replace")}>{t("替换预览")}</button>
      <button type="button" aria-pressed={mode === "append"} onClick={() => setMode("append")}>{t("追加预览")}</button>
    </div>
    <div className="comic-breakdown-diff">
      <div><h3>{t(mode === "replace" ? "将移除的分镜" : "保留的分镜")}</h3>
        <ul>{sample.before.map(line => <li key={line}>{t(line)}</li>)}</ul></div>
      <div><h3>{t("新增分镜")}</h3><ol>{sample.after.map(line => <li key={line}>{t(line)}</li>)}</ol></div>
    </div>
  </details>;
}
