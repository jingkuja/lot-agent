import { z } from "zod";
import { COMIC_DIRECTOR_AGENT_ID, COMIC_DIRECTOR_TOOL_NAMES, comicDirectorDefinition } from "../agents/definitions/comic-drama.js";
import type { ComicDramaClipDraft } from "./index.js";
import type { ComicGenerationQuote } from "./generation.js";

export { COMIC_DIRECTOR_AGENT_ID, COMIC_DIRECTOR_TOOL_NAMES, comicDirectorDefinition };
export const COMIC_SCRIPT_MAX_CHARS = 20_000;
export const COMIC_SCRIPT_FILE_BYTES = 2 * 1024 * 1024;
export const COMIC_SCRIPT_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const id = z.string().uuid().transform(value => value.toLowerCase());
const revision = z.number().int().min(1).max(2_147_483_647);
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !value.includes("\0"));
export const comicDirectorInputSchema = z.object({
  requestId: id, expectedRevision: revision, mode: z.enum(["outline", "paste", "file"]),
  language: z.enum(["zh", "en", "id"]), text: text(COMIC_SCRIPT_MAX_CHARS),
  action: z.enum(["script", "breakdown", "sequel"]).optional(),
}).strict();
export const comicDirectorModelSchema = z.object({
  script: text(COMIC_SCRIPT_MAX_CHARS),
  characters: z.array(z.object({ name: text(120), description: text(600) }).strict()).max(24),
}).strict();
const part = z.object({
  scene: text(1000), durationMs: z.number().int().min(1000).max(60_000),
  shots: z.array(text(2000)).min(1).max(3),
  lines: z.array(z.object({ speaker: text(120).nullable(), text: text(1000) }).strict()).max(30),
}).strict();
export const comicDirectorBreakdownSchema = z.object({
  clips: z.array(part).min(1).max(24), characters: comicDirectorModelSchema.shape.characters,
}).strict();
export const comicDirectorApplySchema = z.object({ expectedRevision: revision, decision: z.enum(["append", "replace", "sequel"]).optional() }).strict();
export const comicDirectorRoleDecisionSchema = z.discriminatedUnion("choice", [
  z.object({ choice: z.literal("existing"), expectedRevision: revision, characterId: id, outfitId: id }).strict(),
  z.object({ choice: z.literal("new"), expectedRevision: revision, outfitName: text(120) }).strict(),
  z.object({ choice: z.literal("skip"), expectedRevision: revision }).strict(),
]);

export type ComicDirectorInput = z.infer<typeof comicDirectorInputSchema>;
export type ComicDirectorModel = z.infer<typeof comicDirectorModelSchema>;
export type ComicDirectorBreakdown = z.infer<typeof comicDirectorBreakdownSchema>;
export type ComicDirectorDecision = z.infer<typeof comicDirectorApplySchema>["decision"];
export type ComicDirectorRoleDecision = z.infer<typeof comicDirectorRoleDecisionSchema>;
export type ComicDirectorRoleOutcome = { choice: ComicDirectorRoleDecision["choice"]; characterId: string | null; revision: number };
export type ComicDirectorRole = ComicDirectorModel["characters"][number] & { candidates: { id: string; name: string; appearance?: string }[] };
export type ComicDirectorProposal = {
  id: string; conversationId: string; baseRevision: number; createdAt: string; input: ComicDirectorInput; original: string;
  status: "writing" | "ready" | "unknown" | "failed" | "applied" | "dismissed"; appliedRevision: number | null;
  proposal: { script: string; roles: ComicDirectorRole[]; clips?: ComicDramaClipDraft[]; previousScenes?: string[] } | null;
  decision?: ComicDirectorDecision | null; sequelId?: string | null;
  roleDecisions?: Record<string, ComicDirectorRoleOutcome>;
};
export const comicDirectorChatInputSchema = z.object({
  message: text(4000),
  expectedRevision: revision,
  language: z.enum(["zh", "en", "id"]).default("zh"),
}).strict();
export type ComicDirectorChatInput = z.infer<typeof comicDirectorChatInputSchema>;
export type ComicDirectorToolCallSummary = { name: string; summary: string; ok: boolean };
export type ComicDirectorChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolCalls?: ComicDirectorToolCallSummary[];
  proposalId?: string;
  confirmationId?: string;
};
export type ComicDirectorChatResponse = {
  conversationId: string;
  reply: ComicDirectorChatMessage;
  toolResults: Array<ComicDirectorToolCallSummary & { data?: unknown }>;
  seriesUpdated: boolean;
  latestRevision: number;
  proposal?: ComicDirectorProposal;
  quote?: ComicGenerationQuote;
};
export type ComicDirectorQuote = { quote: ComicGenerationQuote; confirmed: boolean };
export type ComicDirectorState = {
  conversationId: string | null;
  proposals: ComicDirectorProposal[];
  quotes?: ComicDirectorQuote[];
  messages?: ComicDirectorChatMessage[];
};
export type ComicScriptImport = { text: string; truncated: boolean };
