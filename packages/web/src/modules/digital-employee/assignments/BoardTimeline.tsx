import { useState } from "react";
import { useI18n } from "../../../i18n/index.js";
import { employeeApi } from "../api.js";
import type { BoardEntry } from "../types.js";
import { BOARD_EVENT_LABELS, BOARD_KIND_LABELS } from "./copy.js";

const PAGE = 50;

function author(entry: BoardEntry, t: (text: string, args?: unknown[]) => string): string {
  if (entry.author === null) return t("你");
  return entry.author === 0 ? t("负责人") : t("子任务 {0}", [entry.author]);
}

function headline(entry: BoardEntry, t: (text: string, args?: unknown[]) => string): string {
  if (!entry.event) return entry.title;
  const subject = entry.event === "added" || entry.event === "followed_up" ? entry.body : entry.authorTitle ?? "";
  return `${t(BOARD_EVENT_LABELS[entry.event])}${subject ? `：${subject}` : ""}`;
}

/** Newest first. A status line needs no body, and its title is written for the models, so it is worded here. */
export function BoardTimeline({ taskId, entries }: { taskId: string; entries: BoardEntry[] }) {
  const { t, locale } = useI18n();
  const [older, setOlder] = useState<BoardEntry[]>([]);
  const [ended, setEnded] = useState(false);
  const [loading, setLoading] = useState(false);
  if (!entries.length) return null;

  const more = async () => {
    setLoading(true);
    try {
      const last = older.at(-1) ?? entries.at(-1)!;
      const page = await employeeApi.getAssignmentBoard(taskId, last.id);
      setOlder((current) => [...current, ...page.entries]);
      setEnded(page.entries.length < PAGE);
    } finally {
      setLoading(false);
    }
  };

  const shown = [...entries, ...older];
  return <section className="de-assignment-panel">
    <h2>{t("工作板")}</h2>
    <ol className="de-board">
      {shown.map((entry) => {
        const body = entry.event === "added" || entry.event === "followed_up" ? "" : entry.body;
        return <li key={entry.id} className={`is-${entry.kind}`}>
          <small>
            <time>{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(entry.createdAt))}</time>
            <span>{author(entry, t)}</span>
            <span>{t(BOARD_KIND_LABELS[entry.kind])}</span>
          </small>
          {body
            ? <details><summary>{headline(entry, t)}</summary><p>{body}</p></details>
            : <p>{headline(entry, t)}</p>}
          {entry.artifacts.length > 0 && <ul>{entry.artifacts.map((link) => <li key={link}>{link}</li>)}</ul>}
        </li>;
      })}
    </ol>
    {entries.length >= PAGE && !ended && <button type="button" className="de-text-button" disabled={loading} onClick={() => void more()}>{t("看更早的")}</button>}
  </section>;
}
