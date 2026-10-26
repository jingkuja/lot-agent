import { capMarketingStoryboard, MARKETING_REVIEW_MODEL, marketingShotMaxSeconds, planMarketingSegments, type MarketingDraft, type MarketingProject,
  type MarketingSource, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import type { AgentService } from "../services/agent-service.js";
import { marketingReviewInput, REVIEW_INSTRUCTION, reviewDeltaInstruction, type MarketingReviewDelta } from "./compliance.js";
import { creationPrompt, publicationPrompt, storyboardPrompt } from "./creation.js";
import type { PgMarketingTextOperations, TextOperation } from "./operations.js";
import { MarketingError, type PgMarketingProjectStore } from "./repository.js";
import { invalidTextResult, parseOperationResult, parseTextResult } from "./text-result.js";

export type MarketingLocale = "zh" | "en" | "id";

export interface MarketingWritingDeps {
  service: Pick<AgentService, "marketingText">;
  store: Pick<PgMarketingProjectStore, "get">;
  operations: Pick<PgMarketingTextOperations, "begin" | "receipt" | "finish" | "fail">;
  /** Clip model whose shot limit new storyboards are planned for. */
  activeProfile: MarketingVideoProfile;
}

/** Common to every paid text request: one model call per clientRequestId. */
interface TextRequest { clientRequestId: string; version: number; locale: MarketingLocale }
type Prompt = { system: string; input: string };
type TextKind = "copy" | "storyboard" | "review" | "publication";

/** Paid copy, storyboard, review and publication requests. Each request is recorded before the model call,
 * the receipt is saved before the result is applied, and a repeated or lost request replays the saved
 * outcome instead of paying again. The calls are not tied to the browser connection: a refresh or closed
 * tab must not turn a paid request into an unknown one. */
export class MarketingWriting {
  constructor(private readonly deps: MarketingWritingDeps) {}

  /** New copy (and its storyboard) for an unsaved draft of the project. */
  async copy(owner: string, projectId: string, request: TextRequest & { draft: MarketingDraft; source: MarketingSource }) {
    const { operations } = this.deps;
    const { clientRequestId, version, locale, draft, source } = request;
    const reserved = await operations.begin(owner, clientRequestId, projectId, version, "copy", { draft, locale, source, version }, draft);
    if (!reserved.fresh) return { ...replay(reserved.operation), operation: reserved.operation, project: await this.project(owner, projectId) };
    try {
      const prompt = creationPrompt(reserved.draft, locale);
      const result = parseTextResult("copy", await this.call(owner, clientRequestId, prompt, { upstreamBilling: true }, "copy"), reserved.draft);
      const operation = await operations.finish(owner, clientRequestId, result);
      return { ...result, operation, project: await this.project(owner, projectId) };
    } catch (error) { await operations.fail(owner, clientRequestId, true, invalidTextResult(error)); throw error; }
  }

  /** Writes the whole storyboard, or rewrites shot `index`, of the saved draft. */
  async storyboard(owner: string, p: MarketingProject, request: TextRequest & { instruction: string; index?: number }) {
    const { operations, activeProfile } = this.deps;
    const { clientRequestId, version, locale, instruction, index } = request;
    const reserved = await operations.begin(owner, clientRequestId, p.id, version, "storyboard", { version, locale, instruction, index });
    if (!reserved.fresh) { replay(reserved.operation); return { ...p, operation: reserved.operation }; }
    const draft = reserved.draft;
    let started = false;
    try {
      if (index !== undefined && index >= draft.storyboard.length) throw new MarketingError("分镜修改参数无效。");
      let initial;
      try {
        initial = draft.storyboard.length ? capMarketingStoryboard(draft.storyboard, draft, activeProfile)
          : planMarketingSegments(draft.script, draft.durationSec, marketingShotMaxSeconds(draft, activeProfile))
            .map(part => ({ durationSec: part.durationSec, script: part.script, visual: "", action: "", camera: "" }));
      }
      catch (error) { throw new MarketingError((error as Error).message); }
      const prompt = storyboardPrompt(draft, locale, initial, instruction, index);
      started = true;
      const result = parseTextResult("storyboard", await this.call(owner, clientRequestId, prompt, { upstreamBilling: true }, "storyboard"), draft, index);
      const operation = await operations.finish(owner, clientRequestId, result);
      return { ...await this.project(owner, p.id), operation };
    } catch (error) { await operations.fail(owner, clientRequestId, started, invalidTextResult(error)); throw error; }
  }

  /** Compliance review of the saved copy; a re-check after edits sends only what changed. */
  review(owner: string, projectId: string, request: TextRequest) {
    const { locale } = request;
    return this.recorded(owner, projectId, request, "review", { version: request.version, locale }, (draft, delta) => ({
      // The fixed rules come first and are the same for every check, so the gateway can cache them.
      system: `${REVIEW_INSTRUCTION}\nWrite reasons and suggested replacements in ${locale}. Keep excerpts exactly as supplied.`
        + (delta ? `\n${reviewDeltaInstruction(delta)}` : ""),
      input: marketingReviewInput(draft),
    }));
  }

  /** Publishing title and tags of the saved copy; `fillMissing` keeps fields the user already wrote. */
  publication(owner: string, projectId: string, request: TextRequest & { fillMissing: boolean }) {
    const { version, locale, fillMissing } = request;
    return this.recorded(owner, projectId, request, "publication", { version, locale, fillMissing }, draft => publicationPrompt(draft.script, locale));
  }

  private async recorded(owner: string, projectId: string, request: TextRequest, kind: "review" | "publication",
    input: { version: number; locale: MarketingLocale; fillMissing?: boolean }, prompt: (draft: MarketingDraft, delta?: MarketingReviewDelta) => Prompt) {
    const { operations } = this.deps;
    const reserved = await operations.begin(owner, request.clientRequestId, projectId, request.version, kind, input);
    let operation = reserved.operation;
    if (reserved.fresh) {
      try {
        const frozen = reserved.input as typeof input & { delta?: MarketingReviewDelta };
        const raw = await this.call(owner, request.clientRequestId, prompt(reserved.draft, frozen.delta),
          kind === "review" ? { model: MARKETING_REVIEW_MODEL } : {}, kind);
        operation = await operations.finish(owner, request.clientRequestId, parseOperationResult(kind, raw, reserved.draft, frozen));
      } catch (error) { await operations.fail(owner, request.clientRequestId, true, invalidTextResult(error)); throw error; }
    } else replay(operation);
    if (operation.status === "conflict") throw new MarketingError(kind === "review" ? "文案已更新，请重新检查。" : "草稿已更新，请重新生成标题和标签。", 409);
    return { ...await this.project(owner, projectId), operation };
  }

  /** One model call whose receipt is saved as soon as the gateway returns it. Every prompt starts with its fixed
   * instruction, so the gateway can cache that prefix; the log shows how much of each prompt it served from cache. */
  private call(owner: string, clientRequestId: string, prompt: Prompt, options: { upstreamBilling?: boolean; model?: string }, kind: TextKind) {
    return this.deps.service.marketingText(prompt.system, prompt.input, owner, undefined, { ...options, onReceipt: receipt => {
      if (receipt.outcome === "completed" && receipt.usage) {
        const { promptTokens, completionTokens, cachedPromptTokens } = receipt.usage;
        console.log("[marketing-video] text usage", { kind, promptTokens, cachedPromptTokens: cachedPromptTokens ?? null, completionTokens });
      }
      return this.deps.operations.receipt(owner, clientRequestId, receipt);
    } });
  }

  private async project(owner: string, id: string) {
    const p = await this.deps.store.get(owner, id);
    if (!p) throw new MarketingError("草稿不存在", 404);
    return p;
  }
}

/** The saved result of a repeated request; a request without one is never paid for again. */
function replay(operation: TextOperation) {
  if (operation.result) return operation.result;
  throw new MarketingError(["failed", "cancelled"].includes(operation.status) ? "本次创作未完成，已有调用记录已保存；如需重新付费创作，请发起新请求。"
    : "已有创作请求正在处理或结果待核实，请查看页面底部的处理结果。", 409);
}
