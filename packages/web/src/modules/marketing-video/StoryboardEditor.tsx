import { useState } from "react";
import type { MarketingShot } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";

export function StoryboardEditor({ shots, busy, readOnly = false, creation = false, onChange, onAi }: {
  shots: MarketingShot[];
  busy: boolean;
  readOnly?: boolean;
  creation?: boolean;
  onChange?: (shots: MarketingShot[]) => void;
  onAi?: (instruction: string, index?: number) => void;
}) {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const [target, setTarget] = useState("all");
  const fields = [{ key: "script", label: "分镜口播", max: 600 }, { key: "visual", label: "画面内容", max: 600 }, { key: "action", label: "人物与产品动作", max: 400 }, { key: "camera", label: "景别与镜头运动", max: 400 }] as const;
  return <div className="mv-storyboard">
    <div className="mv-section-head"><h3>{t(readOnly ? "制作分镜" : creation ? "生成分镜" : "确认分镜")}</h3><span>{t("{0} 个分镜 · 每镜 15 秒", [shots.length])}</span></div>
    <p className="mv-hint">{t(readOnly ? "以下是本次制作使用的分镜。修改后需作为新视频重新生成。" : creation ? "文案和分镜已生成，可直接继续制作，也可按需修改。" : "可直接修改每段内容，或输入要求让 AI 调整；确认后才开始生成视频。")}</p>
    <div className="mv-shot-list">{shots.map((shot, index) => <article className="mv-shot" key={index} aria-label={t("第 {0} 镜", [index + 1])}>
      <header><h4>{t("第 {0} 镜", [index + 1])}</h4><span>{index * 15}–{(index + 1) * 15}s</span></header>
      {fields.map(({ key, label, max }) => <label className="mv-field" key={key}><span>{t(label)}</span><textarea rows={key === "visual" ? 3 : 2} maxLength={max} value={shot[key]} readOnly={readOnly} disabled={busy} onChange={e => onChange?.(shots.map((value, i) => i === index ? { ...value, [key]: e.target.value } : value))} /></label>)}
    </article>)}</div>
    {!readOnly && <details className="mv-storyboard-ai" open={creation ? undefined : true}><summary>{t("调整分镜（选填）")}</summary>
      <label className="mv-field"><span>{t("AI 修改范围")}</span><select value={target} disabled={busy} onChange={e => setTarget(e.target.value)}><option value="all">{t("全部分镜")}</option>{shots.map((_, index) => <option key={index} value={index}>{t("第 {0} 镜", [index + 1])}</option>)}</select></label>
      <label className="mv-field"><span>{t("分镜修改要求")}</span><textarea rows={2} maxLength={1000} value={instruction} disabled={busy} placeholder={t("例如：开场改为产品特写，镜头缓慢推近，口播保持不变。")} onChange={e => setInstruction(e.target.value)} /></label>
      <button className="mv-soft" disabled={busy || !instruction.trim()} onClick={() => onAi?.(instruction.trim(), target === "all" ? undefined : Number(target))}>{t(busy ? "正在处理…" : "AI 修改分镜")}</button>
    </details>}
  </div>;
}
