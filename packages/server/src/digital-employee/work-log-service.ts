import type { Pool } from "pg";
import { DIGITAL_EMPLOYEE_AGENT_ID } from "./agent.js";
import { NotFoundError } from "./errors.js";

const RUN_LIMIT = 20;
const OUTCOME_MAX = 4_000;
/** Bookkeeping, not work the owner asked for. */
const HIDDEN_TOOLS = ["load_skill"];
const PRODUCING_TOOL = /^(commit|generate|rewrite|adopt|record|mark|start)_/;
const DOCUMENT_LINK = /下载链接：\s*(\S+)/;
const DOCUMENT_TOOLS = new Set(["generate_document", "generate_ppt"]);
const DOCUMENT_PATH = /(?:^|\/)static\/documents\/([\w.-]+)$/;
const CHAT_LINK = /\[([^\]\n]{1,80})\]\((\/digital-employee\/[^)\s]+)\)/;
const SAFE_PATH = /^\/(digital-employee\/[\w\-/%]+|assistant\?agent=marketing_video&project=[\w-]+)$/;

export interface WorkArtifact {
  label: string | null;
  url: string | null;
  /** Something here waits for the owner's review rather than being finished. */
  needsReview?: boolean;
  /** A file to download, not a page in the app. */
  download?: boolean;
}

export interface WorkStep {
  id: string;
  tool: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  artifact: WorkArtifact | null;
}

export interface WorkRun {
  id: string;
  goal: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  steps: WorkStep[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

function safePath(value: unknown): string | null {
  return typeof value === "string" && SAFE_PATH.test(value) ? value : null;
}

function parsed(content: string): Record<string, unknown> | null {
  if (!content.startsWith("{")) return null;
  try { return JSON.parse(content) as Record<string, unknown>; } catch { return null; }
}

function field(source: unknown, key: string): unknown {
  return source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;
}

/** Only a name and a link leave this function: raw tool input and output stay on the server. */
export interface TaskArtifact {
  id: string;
  tool: string;
  artifact: WorkArtifact;
}

export function stepArtifact(tool: string, status: string, result: unknown): WorkArtifact | null {
  if (status !== "succeeded" || !PRODUCING_TOOL.test(tool)) return null;
  const content = field(result, "content");
  if (typeof content !== "string") return null;
  if (DOCUMENT_TOOLS.has(tool)) return documentArtifact(content);
  const value = parsed(content);
  if (!value) {
    const link = content.match(CHAT_LINK);
    return link ? { label: link[1]!, url: safePath(link[2]) } : null;
  }
  const label = text(field(value.asset, "title")) ?? text(field(value.campaign, "name")) ?? text(field(value.preview, "title"))
    ?? text(field(value.action, "title")) ?? text(value.title) ?? text(value.name);
  const review = safePath(value.reviewUrl);
  if (review) return { label, url: review, needsReview: true };
  const url = safePath(value.managementUrl);
  return label || url ? { label, url } : null;
}

/** The server wrote this link into its own result; it is checked anyway because it reaches the browser. */
function documentArtifact(content: string): WorkArtifact | null {
  const url = content.match(DOCUMENT_LINK)?.[1];
  const file = url?.split(/[?#]/)[0]?.match(DOCUMENT_PATH)?.[1];
  return url && file ? { label: file, url, download: true } : null;
}

function iso(value: unknown): string {
  return new Date(value as string).toISOString();
}

function optionalIso(value: unknown): string | null {
  return value ? iso(value) : null;
}

/** What one conversation's runs did, read from the execution journal the runtime already keeps. */
export class WorkLogService {
  constructor(private readonly pool: Pool) {}

  /** Everything a set of conversations produced, in one query: a task can have many subtasks. */
  async artifacts(userId: string, conversationIds: string[]): Promise<TaskArtifact[]> {
    const { rows } = await this.pool.query(
      `SELECT step.id, step.tool_name, step.status, step.result FROM agent_steps step JOIN agent_runs run ON run.id = step.run_id
       WHERE run.conversation_id = ANY($1::uuid[]) AND run.user_id=$2 AND step.status='succeeded' ORDER BY step.started_at`,
      [conversationIds, userId]
    );
    return rows.flatMap((row) => {
      const artifact = stepArtifact(String(row.tool_name), String(row.status), row.result);
      return artifact?.url ? [{ id: String(row.id), tool: String(row.tool_name), artifact }] : [];
    });
  }

  async conversation(userId: string, conversationId: string) {
    const { rows: [conversation] } = await this.pool.query(
      `SELECT id, title FROM conversations WHERE id=$1 AND user_id=$2 AND agent_id=$3`,
      [conversationId, userId, DIGITAL_EMPLOYEE_AGENT_ID]
    );
    if (!conversation) throw new NotFoundError("工作记录不存在");
    const { rows: runs } = await this.pool.query(
      `SELECT r.id, r.goal, r.status, r.started_at, r.finished_at,
         (SELECT m.content FROM messages m
          WHERE m.conversation_id=r.conversation_id AND m.role='assistant' AND m.metadata->>'runId'=r.id::text
          ORDER BY m.created_at DESC LIMIT 1) AS outcome
       FROM agent_runs r WHERE r.conversation_id=$1 AND r.user_id=$2
       ORDER BY r.started_at DESC LIMIT $3`,
      [conversationId, userId, RUN_LIMIT]
    );
    const { rows: steps } = runs.length ? await this.pool.query(
      `SELECT id, run_id, tool_name, status, result, started_at, finished_at FROM agent_steps
       WHERE run_id = ANY($1::uuid[]) AND NOT tool_name = ANY($2::text[]) ORDER BY started_at, iteration`,
      [runs.map((run) => run.id), HIDDEN_TOOLS]
    ) : { rows: [] };
    return {
      id: String(conversation.id),
      title: String(conversation.title ?? ""),
      runs: runs.map((run): WorkRun => ({
        id: String(run.id),
        goal: String(run.goal),
        status: String(run.status),
        startedAt: iso(run.started_at),
        finishedAt: optionalIso(run.finished_at),
        outcome: run.outcome ? String(run.outcome).slice(0, OUTCOME_MAX) : null,
        steps: steps.filter((step) => step.run_id === run.id).map((step): WorkStep => ({
          id: String(step.id),
          tool: String(step.tool_name),
          status: String(step.status),
          startedAt: iso(step.started_at),
          finishedAt: optionalIso(step.finished_at),
          artifact: stepArtifact(String(step.tool_name), String(step.status), step.result),
        })),
      })),
    };
  }
}
