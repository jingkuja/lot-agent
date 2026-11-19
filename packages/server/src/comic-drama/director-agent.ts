import { complete, LLMIncompleteError } from "@lot-agent/core";
import { COMIC_DIRECTOR_AGENT_ID, comicDirectorDefinition, comicDirectorModelSchema, comicDramaIdSchema } from "@lot-agent/core/comic-drama";
import { AgentConversationError, type AgentExtension } from "../services/agent-extensions.js";
import type { PgComicDirector } from "./director-repository.js";

const scoped = "Open this director conversation from its comic-drama episode";
type DirectorExtension = AgentExtension & Required<Pick<AgentExtension, "beginTurn" | "resolveModel">>;
const episodeId = (metadata: unknown) => comicDramaIdSchema.safeParse(
  typeof metadata === "object" && metadata !== null && "comicSeriesId" in metadata ? metadata.comicSeriesId : undefined);
export function createComicDirectorExtension(repo: PgComicDirector, resolveModel: DirectorExtension["resolveModel"], enabled: boolean): DirectorExtension {
  return {
    agentId: COMIC_DIRECTOR_AGENT_ID, ownerKeyOnly: true, disableUserMemory: true,
    conversationMetadata() { throw new AgentConversationError(scoped); },
    assertConversation() { throw new AgentConversationError(scoped); },
    validateChatMedia: async () => scoped,
    resolveModel,
    async beginTurn({ userId, conversationId, metadata, toolNames }) {
      const series = episodeId(metadata);
      if (!enabled || !userId || !series.success) throw new AgentConversationError(scoped);
      await repo.assertSession(userId, series.data, conversationId);
      return { allowedToolNames: [], blockedToolNames: toolNames, dynamicParts: [], featureScope: series.data };
    },
  };
}

export class ComicDirector {
  constructor(private readonly repo: PgComicDirector, private readonly extension: DirectorExtension) {}

  async write(owner: string, series: string, input: Parameters<PgComicDirector["claim"]>[2], signal: AbortSignal) {
    const { episode, proposal, created } = await this.repo.claim(owner, series, input);
    if (!created) return proposal;
    let invoked = false;
    let model: string | undefined;
    let result: Parameters<PgComicDirector["finish"]>[3];
    try {
      await this.extension.beginTurn({
        agentId: COMIC_DIRECTOR_AGENT_ID, userId: owner, conversationId: proposal.conversationId, metadata: { comicSeriesId: series }, toolNames: [],
      });
      const { llm, usedModelId } = await this.extension.resolveModel(owner);
      model = usedModelId;
      signal.throwIfAborted();
      invoked = true;
      let attempts = 0;
      const text = await complete(llm, [
        { role: "system", content: comicDirectorDefinition.systemPrompt },
        { role: "user", content: JSON.stringify({
          mode: input.mode, language: input.language, source: input.text, title: episode.title, logline: episode.logline, existingScript: proposal.original,
        }) },
      ], {
        signal: AbortSignal.any([signal, AbortSignal.timeout(110_000)]),
        params: { maxTokens: 6500, responseFormat: "json_object" },
        onAttempt: () => { if (attempts++ > 0) throw new Error("DIRECTOR_DUPLICATE_ATTEMPT"); },
      });
      try {
        const parsed = comicDirectorModelSchema.safeParse(JSON.parse(text));
        result = parsed.success ? parsed.data : "failed";
      } catch { result = "failed"; }
    } catch (error) { result = invoked && !(error instanceof LLMIncompleteError) ? "unknown" : "failed"; }
    return this.repo.finish(owner, series, proposal.id, result, model);
  }
}
