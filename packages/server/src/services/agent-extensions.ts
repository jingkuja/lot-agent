import type { LLMProvider, Tool } from "@lot-agent/core";

export interface ResolvedLlm {
  llm: LLMProvider;
  usedModelId: string;
  modelIds: string[];
}

export interface AgentTurnInput {
  agentId: string;
  userId?: string;
  conversationId: string;
  metadata: unknown;
  toolNames: string[];
}

export interface AgentTurnContext {
  allowedToolNames: string[];
  dynamicParts: string[];
  featureScope?: string;
  /** Removed after every other tool is added, so a channel's own tools cannot come back. */
  blockedToolNames?: string[];
  /** Tools for this turn only. `original` looks up the shared tool of the same name, which they may wrap. */
  toolOverrides?(original: (name: string) => Tool | undefined): Tool[];
}

/** A conversation an extension refuses; routes report it as a 400. */
export class AgentConversationError extends Error {}

/** What an agent module adds to the platform, so the platform never names the agent. */
export interface AgentExtension {
  agentId: string;
  /** Model calls use only the owner's own gateway key, never an environment key. */
  ownerKeyOnly: boolean;
  /** Facts stay in the module's own tables instead of user memory. */
  disableUserMemory?: boolean;
  /** Business tools no other agent may use. */
  privateToolNames?: string[];
  /** Throws AgentConversationError when the conversation cannot be created. */
  conversationMetadata?(input: { featureScope?: string }): Record<string, unknown>;
  /** Throws AgentConversationError when the stored conversation cannot run. */
  assertConversation?(metadata: unknown): void;
  resolveModel?(userId: string | undefined, requested?: string | null): Promise<ResolvedLlm>;
  beginTurn?(input: AgentTurnInput): Promise<AgentTurnContext>;
}

const extensions = new Map<string, AgentExtension>();

/** One per process: the API and each Worker register their own at startup. */
export function registerAgentExtension(extension: AgentExtension): void {
  extensions.set(extension.agentId, extension);
}

export function agentExtension(agentId: string | null | undefined): AgentExtension | undefined {
  return agentId ? extensions.get(agentId) : undefined;
}
