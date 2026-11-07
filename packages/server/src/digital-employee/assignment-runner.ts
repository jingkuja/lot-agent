import { randomUUID } from "node:crypto";
import type { AgentEvent, RunStatus } from "@lot-agent/core";
import type { AttachmentRef } from "../services/attachment-extractor.js";
import { boardNotice, ProgressDigest, subtaskBrief, withOverview, type BoardEvent } from "./assignment-board.js";
import { assignmentConfig } from "./assignment-config.js";
import { assignmentLink, costLimitNotice, decisionNotice, finishedNotice, quotaNotice } from "./assignment-notices.js";
import type { AssignmentEvent, AssignmentNode, AssignmentRepository } from "./assignment-repository.js";
import { decideTurn, type FailureReason, type OwnerQuestion, type TurnDecision } from "./assignment-state.js";
import { DIGITAL_EMPLOYEE_LLM_UNAVAILABLE, MANAGED_CREDENTIAL_UNAVAILABLE } from "./llm.js";

const CLAIM_INTERVAL_MS = 1_000;
const SWEEP_INTERVAL_MS = 15_000;
const DELIVERY_INTERVAL_MS = 5_000;
/** An owner who cancels expects it to stop within two seconds, abort included. */
const CANCEL_CHECK_MS = 1_000;
const RENEW_MS = 20_000;
/** A conversation held longer than this without renewal belongs to a dead process. */
export const CONVERSATION_STALE_MS = 55_000;
const BUSY_CONVERSATION_RETRY_MS = 10_000;
/** Stops at an iteration boundary before the 30-minute deadline would cut a tool off mid-write. */
const SOFT_TURN_MS = 25 * 60_000;
const DELIVERY_BATCH = 20;
const QUOTA_NOTICE_HOURS = 24;
const PAUSE_NOTICE_DELAY_MS = 30_000;
const REMINDER_HOURS = 24;
const NOTICE_ENTRIES = 5;
const WAKE_BATCH = 200;
const RESULT_ON_BOARD_CHARS = 1_000;
const MAX_OPTIONS = 6;

/** A new segment reads its own history, so this only has to say what is happening. */
const CONTINUE_MESSAGE = "[Task continuation] Carry on from where you stopped. Check the execution records before repeating any write. " +
  "Call finish_task when the task is done.";

export interface AssignmentTurnInput {
  conversationId: string;
  message: string;
  userId: string;
  attachments: AttachmentRef[];
  signal: AbortSignal;
  runId: string;
  modelId: string;
  beforeIteration(usage: { tokens: number; cost: number }): Promise<{ notices?: string[]; stop?: boolean } | void>;
}

/** The platform pieces a task run needs. The worker wires these to AgentService, so this module never imports it. */
export interface AssignmentRunnerPorts {
  claimConversation(conversationId: string, runId: string): Promise<boolean>;
  renewConversation(conversationId: string, runId: string): Promise<boolean>;
  releaseConversation(conversationId: string, runId: string): Promise<void>;
  stream(input: AssignmentTurnInput): AsyncIterable<AgentEvent>;
  generateTitle(node: AssignmentNode): Promise<string | null>;
  /** Uses the cheap background model, not the task's. Left out, subtasks share only what they publish. */
  summarize?: (input: { userId: string; title: string; previous: string | null; delta: string }) => Promise<{ title: string; summary: string }>;
  employeeName(userId: string): Promise<string>;
  /** Has no recipient: a notice can only ever reach the account's owner. */
  sendToOwner?: (userId: string, message: { text: string; requestId: string }) => Promise<{ messageId?: string } | void>;
  english: boolean;
}

interface TurnRecord {
  status: RunStatus | undefined;
  question: OwnerQuestion | null;
  quota: boolean;
  text: string;
  madeProgress: boolean;
  digest: ProgressDigest;
}

function ownerQuestion(input: unknown): OwnerQuestion {
  const { question, options, multiSelect } = (input ?? {}) as { question?: unknown; options?: unknown; multiSelect?: unknown };
  return {
    question: typeof question === "string" ? question.trim() : "",
    options: Array.isArray(options) ? options.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, MAX_OPTIONS) : [],
    multiSelect: multiSelect === true,
  };
}

/** Polls PostgreSQL rather than a queue: a task may wait for days, and a queue's stalled retry could repeat a write. */
export class AssignmentRunner {
  private readonly running = new Map<string, { task: Promise<void>; controller: AbortController }>();
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly busy = new Set<string>();
  private stopping = false;

  constructor(private readonly repository: AssignmentRepository, private readonly ports: AssignmentRunnerPorts) {}

  start(): void {
    this.every(CLAIM_INTERVAL_MS, "claim", () => this.pump());
    this.every(SWEEP_INTERVAL_MS, "sweep", () => this.sweep());
    if (this.ports.sendToOwner) this.every(DELIVERY_INTERVAL_MS, "delivery", () => this.deliver());
  }

  private every(intervalMs: number, label: string, work: () => Promise<void>): void {
    const tick = () => {
      if (this.stopping || this.busy.has(label)) return;
      this.busy.add(label);
      void work().catch((error) => console.warn(`[assignments] ${label} failed:`, error instanceof Error ? error.message : "unknown"))
        .finally(() => this.busy.delete(label));
    };
    this.timers.push(setInterval(tick, intervalMs));
    tick();
  }

  /** Lets turns finish for the grace period, then aborts them. The next process picks them up by the interruption rule. */
  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    const tasks = () => [...this.running.values()].map((item) => item.task);
    await Promise.race([Promise.allSettled(tasks()), new Promise((resolve) => setTimeout(resolve, graceMs))]);
    for (const { controller } of this.running.values()) controller.abort(new Error("Worker shutting down"));
    await Promise.allSettled(tasks());
  }

  async pump(): Promise<void> {
    const { workerConcurrency, runningPerUser } = assignmentConfig();
    while (!this.stopping && this.running.size < workerConcurrency) {
      const node = await this.repository.claim(runningPerUser);
      if (!node) return;
      const controller = new AbortController();
      const task = this.execute(node, controller)
        .catch((error) => console.warn("[assignments] turn failed:", error instanceof Error ? error.message : "unknown"))
        .finally(() => this.running.delete(node.id));
      this.running.set(node.id, { task, controller });
    }
  }

  async sweep(): Promise<void> {
    for (const { node, resumed } of await this.repository.sweepOrphans()) {
      console.warn(`[assignments] node ${node.id} lost its worker: ${resumed ? "resumed" : "failed"}`);
    }
    await this.repository.wakeWaiting(WAKE_BATCH);
    await this.repository.queueReminders(REMINDER_HOURS);
  }

  /** Test seam: resolves when every turn started so far has ended. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((item) => item.task));
  }

  private async execute(node: AssignmentNode, controller: AbortController): Promise<void> {
    const runId = randomUUID();
    if (!await this.ports.claimConversation(node.conversationId, runId)) {
      await this.repository.release(node, BUSY_CONVERSATION_RETRY_MS);
      return;
    }
    let turn: TurnRecord | null = null;
    let paused = false;
    const monitor = this.watch(node, runId, controller);
    try {
      await this.repository.recordRun(node, runId);
      const first = await this.repository.isFirstTurn(node);
      if (first && node.id === node.rootId) void this.title(node);
      const message = await this.opening(node, first);
      turn = await this.run(node, runId, first, message, controller.signal, () => { paused = true; });
    } finally {
      clearInterval(monitor);
      await this.ports.releaseConversation(node.conversationId, runId);
    }
    await this.repository.syncUsage(node);
    await this.repository.finishRun(runId, turn.madeProgress);
    // Before the node settles, so whoever it wakes reads the latest.
    if (!this.stopping && turn.status !== "cancelled") await this.summarize(node, turn.digest);
    await this.conclude(node, runId, turn, paused);
    await this.repository.wakeTree(node.rootId);
  }

  /** Every segment opens with the board, so runtime notices never have to be stored: nothing is lost between segments. */
  private async opening(node: AssignmentNode, first: boolean): Promise<string> {
    const overview = await this.repository.overview(node);
    const team = overview.members.length > 1;
    if (team) await this.repository.markBoardRead(node);
    if (first && node.id !== node.rootId) {
      const root = await this.repository.readNode(node.rootId);
      return subtaskBrief({ rootGoal: root?.goal ?? "", position: node.position, goal: node.goal, overview });
    }
    const message = node.nextMessage ?? (first ? node.goal : CONTINUE_MESSAGE);
    return team ? withOverview(message, overview) : message;
  }

  /** Best effort: a failed summary costs teammates some freshness and nothing else, and the text waits for the next try. */
  private async summarize(node: AssignmentNode, digest: ProgressDigest): Promise<void> {
    if (!this.ports.summarize || node.id === node.rootId || digest.busy || !digest.pending) return;
    digest.busy = true;
    const delta = digest.take();
    try {
      const others = await this.repository.openChildren(node.rootId) - (await this.repository.isOpen(node.id) ? 1 : 0);
      if (others <= 0) return digest.restore(delta);
      const previous = await this.repository.latestSummary(node);
      const { title, summary } = await this.ports.summarize({ userId: node.userId, title: node.title, previous, delta });
      await this.repository.post({ rootId: node.rootId, userId: node.userId, authorId: node.id, kind: "summary", title, body: summary });
    } catch {
      digest.restore(delta);
    } finally {
      digest.busy = false;
    }
  }

  private watch(node: AssignmentNode, runId: string, controller: AbortController) {
    let ticks = 0;
    let checking = false;
    const renewEvery = Math.round(RENEW_MS / CANCEL_CHECK_MS);
    const monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      ticks += 1;
      void (async () => {
        const held = ticks % renewEvery === 0
          ? await this.repository.renewLease(node) && await this.ports.renewConversation(node.conversationId, runId)
          : await this.repository.stillRunning(node);
        if (!held) controller.abort(new Error("Assignment is no longer running here"));
      })().catch(() => { /* A database blip is not a cancellation; the lease decides. */ }).finally(() => { checking = false; });
    }, CANCEL_CHECK_MS);
    monitor.unref();
    return monitor;
  }

  private async run(
    node: AssignmentNode, runId: string, first: boolean, message: string, signal: AbortSignal, onPaused: () => void,
  ): Promise<TurnRecord> {
    const turn: TurnRecord = { status: undefined, question: null, quota: false, text: "", madeProgress: false, digest: new ProgressDigest() };
    const asked = new Map<string, unknown>();
    const startedAt = Date.now();
    const beforeIteration = async (usage: { tokens: number; cost: number }) => {
      try {
        const state = await this.repository.checkpoint(node, usage);
        if (state.overLimit && !state.paused) await this.repository.pause(node.rootId, "cost_limit");
        if (state.paused || state.overLimit) { onPaused(); return { stop: true }; }
      } catch {
        // Failing to read the limit must not fail the task; the next iteration checks again.
      }
      const notice = await this.repository.takeUnread(node, NOTICE_ENTRIES).then(boardNotice).catch(() => null);
      const stop = Date.now() - startedAt > SOFT_TURN_MS;
      return notice || stop ? { ...(notice ? { notices: [notice] } : {}), ...(stop ? { stop } : {}) } : undefined;
    };
    const summaries = setInterval(() => void this.summarize(node, turn.digest), assignmentConfig().summaryIntervalMs);
    summaries.unref();
    try {
      for await (const event of this.ports.stream({
        conversationId: node.conversationId, message, userId: node.userId,
        attachments: first ? node.attachments : [], signal, runId, modelId: node.modelId, beforeIteration,
      })) {
        if (event.type === "text") {
          turn.text += event.content;
          turn.digest.text(event.content);
          if (event.content.trim()) turn.madeProgress = true;
        } else if (event.type === "tool_call") {
          turn.text = "";
          if (event.name === "ask_user") asked.set(event.id, event.input);
        } else if (event.type === "tool_result") {
          turn.madeProgress = true;
          turn.digest.tool(event.name, event.output, event.isError === true);
          // Taken from a call that was accepted, so a rejected one cannot pause the task with no question.
          if (event.name === "ask_user" && !event.isError) turn.question = ownerQuestion(asked.get(event.toolCallId));
          if (event.errorKind === "quota") {
            turn.quota = true;
            await this.repository.pause(node.rootId, "quota");
          }
        } else if (event.type === "error") {
          if (event.code === "quota") turn.quota = true;
        } else if (event.type === "done") {
          turn.status = event.status ?? "completed";
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // An exhausted key can fail the model lookup before any model call. Pausing costs nothing; the owner tops up and continues.
      if (message === DIGITAL_EMPLOYEE_LLM_UNAVAILABLE || message === MANAGED_CREDENTIAL_UNAVAILABLE) turn.quota = true;
      if (signal.aborted) turn.status = "cancelled";
    } finally {
      clearInterval(summaries);
    }
    if (signal.aborted && !turn.status) turn.status = "cancelled";
    return turn;
  }

  private async conclude(node: AssignmentNode, runId: string, turn: TurnRecord, paused: boolean): Promise<void> {
    const current = await this.repository.readNode(node.id);
    const isRoot = node.id === node.rootId;
    const openChildren = isRoot ? await this.repository.openChildren(node.rootId) : 0;
    const decision: TurnDecision = decideTurn({
      openChildren, mode: node.mode, status: turn.status, endIntent: current?.endIntent ?? null, question: turn.question, quota: turn.quota, paused,
      shuttingDown: this.stopping,
      text: turn.text.trim(), madeProgress: turn.madeProgress, previousMadeProgress: await this.repository.previousProgress(node, runId),
    });
    const title = current?.title ?? node.title;
    // Subtasks tell the team through the board. The owner hears about the task as a whole, once.
    const board = (event: BoardEvent, what: string, body = "") => isRoot ? {} : {
      board: { event, title: `subtask ${node.position} ${what}: ${title}`, body: body.slice(0, RESULT_ON_BOARD_CHARS) },
    };
    const label = isRoot ? title : `${(await this.repository.readNode(node.rootId))?.title ?? ""} · ${title}`;
    switch (decision.next) {
      case "succeed": {
        const missed = isRoot ? await this.repository.missedSubtasks(node.rootId) : [];
        await this.repository.settle(node, "succeeded", {
          result: { summary: decision.summary, assumptions: decision.assumptions, skipped: decision.skipped },
          ...(isRoot ? { event: { status: "succeeded", title, summary: decision.summary, ...(missed.length ? { missed } : {}) } } : {}),
          ...board("succeeded", "finished", decision.summary),
        });
        return;
      }
      case "fail":
        await this.repository.settle(node, "failed", {
          failureReason: decision.reason,
          ...(decision.summary ? { result: { summary: decision.summary, assumptions: decision.assumptions ?? [], skipped: decision.skipped ?? [] } } : {}),
          ...(isRoot ? { event: { status: "failed", title, failureReason: decision.reason, summary: decision.summary ?? "" } } : {}),
          ...board("failed", `failed (${decision.reason})`, decision.summary),
        });
        return;
      case "ask_failure":
        await this.repository.settle(node, "waiting_user", {
          failureReason: decision.reason,
          ...(decision.summary ? { result: { summary: decision.summary, assumptions: decision.assumptions ?? [], skipped: decision.skipped ?? [] } } : {}),
          decision: { kind: "failure", title: label, failureReason: decision.reason, summary: decision.summary },
          ...board("waiting_user", "stopped and is waiting for the owner", decision.summary),
        });
        return;
      case "ask":
        await this.repository.settle(node, "waiting_user", {
          decision: { kind: "question", title: label, ...decision.question },
          ...board("waiting_user", "is waiting for the owner", decision.question.question),
        });
        return;
      case "wait_team":
        await this.repository.settle(node, "waiting_team");
        return;
      case "wait_children":
        if (turn.quota) await this.repository.pause(node.rootId, "quota");
        await this.repository.settle(node, "waiting_children");
        return;
      case "pause":
        if (turn.quota) await this.repository.pause(node.rootId, "quota");
        await this.repository.settle(node, "queued");
        return;
      case "segment":
        await this.repository.settle(node, "queued");
        return;
      // The node is cancelled already, or stays running for the sweep to judge once its lease runs out.
      case "cancel":
      case "interrupted":
        return;
    }
  }

  /** Best effort: the first line of the goal stays as the title if this fails. */
  private async title(node: AssignmentNode): Promise<void> {
    const title = await this.ports.generateTitle(node).catch(() => null);
    if (title) await this.repository.updateTitle(node.id, title).catch(() => {});
  }

  async deliver(): Promise<void> {
    const events = await this.repository.claimEvents(DELIVERY_BATCH, PAUSE_NOTICE_DELAY_MS);
    const quotaByUser = new Map<string, AssignmentEvent[]>();
    for (const event of events) {
      if (event.kind === "paused" && event.payload.reason === "quota") {
        quotaByUser.set(event.userId, [...(quotaByUser.get(event.userId) ?? []), event]);
      } else if (event.kind === "decision" || event.kind === "reminder") {
        await this.sendDecision(event);
      } else {
        await this.send(event.userId, `assignment-event:${event.id}`, async (name) => this.eventText(event, name));
      }
    }
    for (const [userId, group] of quotaByUser) {
      if (await this.repository.quotaNoticeSentSince(userId, group.map((event) => event.id), QUOTA_NOTICE_HOURS)) continue;
      await this.send(userId, `assignment-quota:${group[0]!.id}`, async (name) => quotaNotice({
        name, count: await this.repository.countQuotaPaused(userId), link: assignmentLink(),
      }, this.ports.english));
    }
  }

  /** The sent message's id is kept so a quoted reply can find its decision. */
  private async sendDecision(event: AssignmentEvent): Promise<void> {
    const id = String(event.payload.decisionId);
    if (!await this.repository.decisionIsOpen(id)) return;
    const { decisionKind, question, options, title, failureReason, summary } = event.payload;
    const sent = await this.send(event.userId, `assignment-event:${event.id}`, async (name) => decisionNotice({
      name, title: String(title ?? ""), kind: decisionKind, question, options, failureReason: failureReason as FailureReason | null, summary,
      link: assignmentLink(event.rootId), reminder: event.kind === "reminder",
    }, this.ports.english));
    if (sent?.messageId) await this.repository.saveDecisionMessage(id, event.kind as "decision" | "reminder", sent.messageId);
  }

  private eventText(event: AssignmentEvent, name: string): string {
    const title = String(event.payload.title ?? "");
    const link = assignmentLink(event.rootId);
    if (event.kind === "paused") return costLimitNotice({ name, title, link }, this.ports.english);
    return finishedNotice({
      name, title, status: event.payload.status, failureReason: event.payload.failureReason as FailureReason | undefined, summary: event.payload.summary, link,
      missed: event.payload.missed,
    }, this.ports.english);
  }

  private async send(userId: string, requestId: string, text: (name: string) => Promise<string>): Promise<{ messageId?: string } | void> {
    try {
      return await this.ports.sendToOwner!(userId, { text: await text(await this.ports.employeeName(userId)), requestId });
    } catch {
      // Not resent: the outcome of a failed send can be unknown, and the result is on the task page.
      console.warn("[assignments] Feishu notice not delivered");
    }
  }
}
