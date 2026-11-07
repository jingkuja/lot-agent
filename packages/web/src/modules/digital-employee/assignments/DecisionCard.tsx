import { useState } from "react";
import { RunRecoveryCard } from "../../../components/RunRecoveryCard.js";
import { useI18n } from "../../../i18n/index.js";
import { employeeApi } from "../api.js";
import type { AssignmentDecision, DecisionAnswer, FailureChoice } from "../types.js";
import { FAILURE_LABELS } from "./copy.js";

const MAX_ANSWER = 2000;
const CHOICES: Array<{ choice: Exclude<FailureChoice, "change">; label: string; primary?: boolean }> = [
  { choice: "retry", label: "重试", primary: true },
  { choice: "skip", label: "跳过" },
  { choice: "end", label: "结束任务" },
];

interface DecisionCardProps {
  decision: AssignmentDecision;
  onAnswered: () => Promise<void> | void;
  /** Where the owner can confirm unverified operations. Without it, the card lets them do that itself. */
  onOpenTask?: () => void;
}

/** One card for both kinds of stop: a question from the employee, and a failure the owner has to call. */
export function DecisionCard({ decision, onAnswered, onOpenTask }: DecisionCardProps) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (value: DecisionAnswer) => {
    setBusy(true); setError(null);
    try {
      await employeeApi.answerDecision(decision.id, value);
      await onAnswered();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (option: string) => setPicked((current) => current.includes(option) ? current.filter((item) => item !== option) : [...current, option]);
  const unverified = decision.unverified > 0;

  return <div className="de-decision-card">
    {decision.kind === "question"
      ? <>
        <p className="de-decision-question">{decision.question}</p>
        {decision.options.length > 0 && <div className="de-decision-options">
          {decision.options.map((option) => decision.multiSelect
            ? <label key={option}>
              <input type="checkbox" checked={picked.includes(option)} disabled={busy} onChange={() => toggle(option)} />
              <span>{option}</span>
            </label>
            : <button key={option} type="button" className="de-secondary-button" disabled={busy} onClick={() => void answer({ text: option })}>{option}</button>)}
        </div>}
        <form onSubmit={(event) => {
          event.preventDefault();
          void answer({ text: [...picked, text.trim()].filter(Boolean).join("、") });
        }}>
          <textarea
            aria-label={t("你的回答")}
            placeholder={t(decision.options.length ? "或者写下你的想法" : "写下你的回答")}
            rows={2}
            maxLength={MAX_ANSWER}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button className="de-primary-button" disabled={busy || (!text.trim() && !picked.length)}>{t("回答")}</button>
        </form>
      </>
      : <>
        {!unverified && <p className="de-decision-question">{t(FAILURE_LABELS[decision.failureReason ?? "model_failed"])}</p>}
        {unverified && <>
          <p className="de-assignment-note is-error" role="status">{t("有 {0} 项操作的结果没有确认。先核实，才能重试或换个做法。", [decision.unverified])}</p>
          {onOpenTask
            ? <button type="button" className="de-text-button" onClick={onOpenTask}>{t("去核实")}</button>
            : <RunRecoveryCard conversationId={decision.conversationId} />}
        </>}
        <div className="de-decision-options">
          {CHOICES.map(({ choice, label, primary }) => <button
            key={choice}
            type="button"
            className={primary ? "de-primary-button" : "de-secondary-button"}
            disabled={busy || (choice === "retry" && unverified)}
            onClick={() => void answer({ choice })}
          >{t(label)}</button>)}
          <button type="button" className="de-secondary-button" disabled={busy || unverified} aria-expanded={changing} onClick={() => setChanging(!changing)}>{t("换个做法")}</button>
        </div>
        {changing && <form onSubmit={(event) => {
          event.preventDefault();
          void answer({ choice: "change", text });
        }}>
          <textarea
            aria-label={t("换个做法")}
            placeholder={t("告诉员工这次怎么做")}
            rows={2}
            maxLength={MAX_ANSWER}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button className="de-primary-button" disabled={busy}>{t("就这样做")}</button>
        </form>}
      </>}
    {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span></div>}
  </div>;
}
