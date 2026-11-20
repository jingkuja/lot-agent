import { useCallback, useEffect, useState } from "react";
import type { ModelCatalog } from "../../../hooks/useModels.js";
import { useI18n } from "../../../i18n/index.js";
import { employeeApi } from "../api.js";
import type { AssignmentInput, AssignmentSchedule, AssignmentScheduleTiming } from "../types.js";
import { usePolling } from "../usePolling.js";
import { AssignmentComposer } from "./AssignmentComposer.js";
import { toLocalInput } from "./grouping.js";

const POLL_MS = 15_000;
const UNIT_LABELS = { minutes: "分钟", hours: "小时", days: "天" } as const;
type Unit = keyof typeof UNIT_LABELS;

function initialTime(): string {
  const next = new Date();
  next.setHours(next.getHours() + 1, 0, 0, 0);
  return toLocalInput(next);
}

function buildTiming(kind: AssignmentScheduleTiming["kind"], at: string, every: string, unit: Unit): AssignmentScheduleTiming | null {
  const start = at ? new Date(at) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  if (kind === "once") return { kind, at: start.toISOString() };
  const interval = Number(every);
  if (!Number.isInteger(interval) || interval < 1 || interval > 10_000) return null;
  return { kind, startAt: start.toISOString(), every: interval, unit };
}

function title(schedule: AssignmentSchedule): string {
  const { goal, attachments } = schedule.assignment;
  return goal.split("\n")[0]?.trim() || attachments.map((item) => item.filename).join("、") || "任务";
}

function finished(schedule: AssignmentSchedule): boolean {
  return schedule.timing.kind === "once" && !schedule.enabled && schedule.lastRunAt !== null;
}

function completed(schedule: AssignmentSchedule): boolean {
  return finished(schedule) && schedule.lastError === null && schedule.lastAssignmentId !== null;
}

/** Creates the same assignment as the immediate tab, but saves its timing instead of starting it now. */
export function ScheduledAssignmentsPage({ modelCatalog, onOpen }: { modelCatalog: ModelCatalog; onOpen: (id: string) => void }) {
  const { t, locale, modelName } = useI18n();
  const [items, setItems] = useState<AssignmentSchedule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [kind, setKind] = useState<AssignmentScheduleTiming["kind"]>("interval");
  const [at, setAt] = useState(initialTime);
  const [every, setEvery] = useState("1");
  const [unit, setUnit] = useState<Unit>("days");

  const load = useCallback(async () => {
    try {
      setItems((await employeeApi.listAssignmentSchedules()).items);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取失败");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  usePolling(load, POLL_MS, loaded);

  const timing = buildTiming(kind, at, every, unit);
  const create = async (assignment: AssignmentInput) => {
    if (!timing) throw new Error("执行时间无效");
    await employeeApi.createAssignmentSchedule({
      ...assignment, timing, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  };

  const act = async (id: string, action: "pause" | "resume" | "delete") => {
    setBusyId(id); setError(null);
    try {
      if (action === "pause") await employeeApi.pauseAssignmentSchedule(id);
      else if (action === "resume") await employeeApi.resumeAssignmentSchedule(id);
      else await employeeApi.deleteAssignmentSchedule(id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const timingText = (schedule: AssignmentSchedule) => {
    if (schedule.timing.kind === "once") return t("仅执行一次");
    return t("每 {0} {1}执行一次", [schedule.timing.every, t(UNIT_LABELS[schedule.timing.unit])]);
  };

  return <>
    <AssignmentComposer
      modelCatalog={modelCatalog}
      onSubmit={create}
      submitLabel="创建定时任务"
      submitDisabled={!timing}
      onCreated={() => { setAt(initialTime()); void load(); }}
      extraFields={<div className="de-assignment-schedule-fields">
        <label>
          <span>{t("重复")}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as AssignmentScheduleTiming["kind"])}>
            <option value="once">{t("一次")}</option>
            <option value="interval">{t("按间隔重复")}</option>
          </select>
        </label>
        <label className="is-wide">
          <span>{t(kind === "once" ? "执行时间" : "首次执行时间")}</span>
          <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
        </label>
        {kind === "interval" && <>
          <label>
            <span>{t("每隔")}</span>
            <input type="number" min="1" max="10000" step="1" inputMode="numeric" value={every} onChange={(event) => setEvery(event.target.value)} />
          </label>
          <label>
            <span>{t("间隔单位")}</span>
            <select value={unit} onChange={(event) => setUnit(event.target.value as Unit)}>
              {(Object.keys(UNIT_LABELS) as Unit[]).map((value) => <option key={value} value={value}>{t(UNIT_LABELS[value])}</option>)}
            </select>
          </label>
        </>}
      </div>}
    />

    <section className="de-assignment-scheduled-list" aria-label={t("已有定时任务")}>
      <h2>{t("已有定时任务")}</h2>
      {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span><button onClick={() => setError(null)}>{t("关闭")}</button></div>}
      {!loaded && !error && <div className="de-state">{t("加载中…")}</div>}
      {loaded && !items.length && <div className="de-state de-empty-state"><strong>{t("还没有定时任务")}</strong></div>}
      <div className="de-assignment-schedule-list">
        {items.map((item) => <article className="de-assignment-schedule-card" key={item.id}>
          <header>
            <strong>{title(item)}</strong>
            <em className={`de-assignment-status is-${item.enabled ? "active" : completed(item) ? "done" : finished(item) ? "failed" : "paused"}`}>
              {t(item.enabled ? "已开启" : completed(item) ? "已完成" : finished(item) ? "创建失败" : "已暂停")}
            </em>
          </header>
          <p>{item.assignment.goal || item.assignment.attachments.map((file) => file.filename).join("、")}</p>
          <small>
            <span>{timingText(item)}</span>
            {item.assignment.modelId && <span>{modelName(item.assignment.modelId)}</span>}
            {item.nextRunAt && <span>{t("下次执行：{0}", [new Date(item.nextRunAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })])}</span>}
            {!item.nextRunAt && item.lastRunAt && <span>
              {t("上次执行：{0}", [new Date(item.lastRunAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })])}
            </span>}
          </small>
          {item.lastError && <p className="de-assignment-note is-error" role="status">{t("上次未能创建任务：{0}", [t(item.lastError)])}</p>}
          <footer>
            {!finished(item) && <button
              type="button" className="de-secondary-button" disabled={busyId === item.id}
              onClick={() => void act(item.id, item.enabled ? "pause" : "resume")}
            >{t(item.enabled ? "暂停" : "恢复")}</button>}
            {item.lastAssignmentId && <button type="button" className="de-text-button" onClick={() => onOpen(item.lastAssignmentId!)}>{t("查看最近任务")}</button>}
            <button type="button" className="de-quiet-button" disabled={busyId === item.id} onClick={() => void act(item.id, "delete")}>{t("删除")}</button>
          </footer>
        </article>)}
      </div>
    </section>
  </>;
}
