import { useState } from "react";
import { useI18n } from "../../../i18n/index.js";
import { TEMPLATE_LABELS } from "../schedule/labels.js";
import type { TodayItem } from "../types.js";

interface ReportCardProps {
  item: TodayItem;
  disabled: boolean;
  onOpen: () => void;
  onAcknowledge: () => void;
  /** The run has ended, so the answer starts ordinary work in a conversation. */
  onAnswer: (answer: string) => void;
}

/** What a scheduled run left. A question keeps it here until the owner answers or lets it go. */
export function ReportCard({ item, disabled, onOpen, onAcknowledge, onAnswer }: ReportCardProps) {
  const { t } = useI18n();
  const [answer, setAnswer] = useState("");
  const run = item.scheduleRun!;
  const question = run.report?.question;
  return <article className="de-today-card de-today-report">
    <div>
      <h3>{t(TEMPLATE_LABELS[run.template])}</h3>
      <p>{item.reason}</p>
      {question && <>
        <p className="de-today-question">{question}</p>
        <textarea aria-label={t("你的回答")} rows={2} value={answer} onChange={(event) => setAnswer(event.target.value)} />
      </>}
    </div>
    <div className="de-today-actions">
      {question && <button type="button" className="de-primary-button" disabled={disabled || !answer.trim()} onClick={() => onAnswer(answer.trim())}>
        {t("回答")}
      </button>}
      <button type="button" className="de-secondary-button" onClick={onOpen}>{t("查看")}</button>
      <button type="button" className="de-quiet-button" disabled={disabled} onClick={onAcknowledge}>{t("知道了")}</button>
    </div>
  </article>;
}
