import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  applyComicScriptEnhancements, COMIC_DIRECTOR_AGENT_ID, COMIC_SCRIPT_MAX_CHARS, comicDramaClipDraftSchema, comicDramaClipSchema,
  comicVideoDurationSupported, comicVideoProfile, extractComicScriptExcerptSegments, matchComicCharacters, normalizeShotDurationShares,
  splitComicScriptSegments, type ComicClipCasting, type ComicClipEnhancementSegment, type ComicDictionaryEntry, type ComicDirectorApplyInput,
  type ComicDirectorBreakdown, type ComicDirectorChatMessage, type ComicDirectorClipEnhanceModel, type ComicDirectorDecision,
  type ComicDirectorInput, type ComicDirectorModel, type ComicDirectorProposal, type ComicDirectorRole, type ComicDirectorRoleDecision,
  type ComicDirectorRoleOutcome, type ComicDirectorScriptEnhanceModel, type ComicDirectorState, type ComicDirectorToolCallSummary,
  type ComicDramaClip, type ComicDramaClipDraft, type ComicGenerationQuote, type ComicScriptEnhancementSegment,
  type ComicScriptSegmentSlice, type ComicSeriesCast,
} from "@lot-agent/core/comic-drama";
import { editSeriesCast, readSeriesCast } from "./cast-store.js";
import { readComicDictionary } from "./dictionary.js";
import { ComicLibraryError, libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";
import { ComicDramaError, PgComicDramaRepository } from "./repository.js";

const cd = "lot_comic_drama";
const columns = `id,conversation_id AS "conversationId",base_revision AS "baseRevision",created_at AS "createdAt",input,original,proposal,
  CASE WHEN status='writing' AND created_at<now()-interval '150 seconds' THEN 'unknown' ELSE status END AS status,
  applied_revision AS "appliedRevision",decision,sequel_id AS "sequelId",
  coalesce((SELECT jsonb_object_agg(role_index,outcome) FROM ${cd}.cd_director_roles WHERE proposal_id=cd_director_proposals.id),'{}') AS "roleDecisions"`;
type ProposalRow = Omit<ComicDirectorProposal, "createdAt"> & { createdAt: Date };
const view = (row: ProposalRow): ComicDirectorProposal => ({ ...row, createdAt: row.createdAt.toISOString() });

export type DirectorEnhanceSeriesMeta = {
  dramaTitle?: string;
  episodeNo?: number | null;
  title: string;
  logline: string;
  styleKey: string;
  styleLabel: string;
  aspectRatio: string;
  videoModel: string | null;
};

export type DirectorEnhanceContext =
  | {
    kind: "script";
    scope: "script_full" | "script_excerpt";
    fullScript: string;
    segments: ComicScriptSegmentSlice[];
    beforeContext: string;
    afterContext: string;
    seriesMeta: DirectorEnhanceSeriesMeta;
    cast: ComicSeriesCast[];
  }
  | {
    kind: "clips";
    seriesMeta: DirectorEnhanceSeriesMeta;
    cast: ComicSeriesCast[];
    dictionaries: {
      framing: ComicDictionaryEntry[];
      movement: ComicDictionaryEntry[];
      emotion: ComicDictionaryEntry[];
    };
    targets: Array<{
      index: number;
      clip: ComicDramaClip;
      previousClip: ComicDramaClip | null;
      nextClip: ComicDramaClip | null;
    }>;
  };

export type DirectorEnhanceResult =
  | {
    kind: "script";
    segments: ComicDirectorScriptEnhanceModel["segments"];
    context: Extract<DirectorEnhanceContext, { kind: "script" }>;
  }
  | {
    kind: "clips";
    clips: ComicDirectorClipEnhanceModel["clips"];
    context: Extract<DirectorEnhanceContext, { kind: "clips" }>;
  };

function mergeMatchedClipCast(
  baseCast: ComicClipCasting,
  castCandidates: ReadonlyArray<{ id: string; name: string; aliases: string[]; snapshot: ComicSeriesCast["snapshot"] }>,
  lines: ReadonlyArray<{ speaker: string | null }>,
  bodyTexts: ReadonlyArray<string>,
): ComicClipCasting {
  const matchedCast: ComicClipCasting = [...baseCast];
  const added = new Set(baseCast.map(entry => entry.characterId));
  const addMember = (member: { id: string; snapshot: ComicSeriesCast["snapshot"] }) => {
    if (added.has(member.id)) return;
    added.add(member.id);
    const slot = member.snapshot.assets.find(asset => asset.kind === "slot" && asset.key === "front")
      ?? member.snapshot.assets.find(asset => asset.kind === "slot");
    matchedCast.push({ characterId: member.id, slotKey: slot?.key ?? null, expressionKey: null });
  };
  for (const line of lines) {
    if (!line.speaker) continue;
    const found = matchComicCharacters(line.speaker, castCandidates);
    if (found.length === 1) addMember(found[0]!);
  }
  const bodyText = bodyTexts.join(" ");
  for (const member of castCandidates) {
    if (added.has(member.id)) continue;
    const names = [member.name, ...member.aliases].filter(name => name.trim().length >= 2);
    if (names.some(name => bodyText.includes(name))) addMember(member);
  }
  return matchedCast.slice(0, 32);
}

export class PgComicDirector {
  constructor(private readonly pool: Pool, private readonly episodes = new PgComicDramaRepository(pool)) {}

  async episode(owner: string, series: string, db: ComicQuery = this.pool, lock = false) {
    const { rows: [row] } = await db.query<{
      title: string; logline: string; seriesGroup?: string | null; episodeNo?: number | null;
      styleKey: string; aspectRatio: string; videoModel: string | null; revision: number; archived: boolean;
    }>(
      `SELECT title,logline,series_group AS "seriesGroup",episode_no AS "episodeNo",
         style_key AS "styleKey",aspect_ratio AS "aspectRatio",video_model AS "videoModel",
         revision,archived_at IS NOT NULL AS archived
       FROM ${cd}.cd_series WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
      [owner, series],
    );
    if (!row) libraryMissing();
    if (lock && row.archived) throw new ComicLibraryError("DIRECTOR_ARCHIVED", 409);
    return row;
  }

  async assertSession(owner: string, series: string, conversation: string) {
    const { rowCount } = await this.pool.query(`SELECT 1 FROM ${cd}.cd_director_sessions s
      JOIN ${cd}.cd_series e ON (e.owner_id,e.id)=(s.owner_id,s.series_id) AND e.deleted_at IS NULL AND e.archived_at IS NULL
      JOIN conversations c ON c.id=s.conversation_id AND c.user_id=s.owner_id::text AND c.agent_id=$4
        AND c.metadata->>'comicSeriesId'=s.series_id::text
      WHERE s.owner_id=$1 AND s.series_id=$2 AND s.conversation_id=$3`, [owner, series, conversation, COMIC_DIRECTOR_AGENT_ID]);
    if (!rowCount) libraryMissing();
  }

  private async session(db: ComicQuery, owner: string, series: string) {
    const { rows: [row] } = await db.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM ${cd}.cd_director_sessions WHERE owner_id=$1 AND series_id=$2`, [owner, series]);
    return row?.conversation_id ?? null;
  }

  private async ensureSession(db: ComicQuery, owner: string, series: string, title: string) {
    const existing = await this.session(db, owner, series);
    if (existing) return existing;
    const conversation = randomUUID();
    await db.query("INSERT INTO conversations(id,user_id,agent_id,title,metadata) VALUES($1,$2,$3,$4,$5)",
      [conversation, owner, COMIC_DIRECTOR_AGENT_ID, title, { comicSeriesId: series }]);
    await db.query(`INSERT INTO ${cd}.cd_director_sessions(owner_id,series_id,conversation_id) VALUES($1,$2,$3)`, [owner, series, conversation]);
    return conversation;
  }

  recordQuote(owner: string, series: string, quote: ComicGenerationQuote) {
    if (!quote.confirmationId) return;
    return libraryTransaction(this.pool, async db => {
      const episode = await this.episode(owner, series, db, true);
      const session = await this.ensureSession(db, owner, series, episode.title);
      const result = await db.query(`INSERT INTO ${cd}.cd_director_quotes(confirmation_id,owner_id,series_id,conversation_id,quote)
        SELECT id,owner_id,series_id,$4,$5 FROM ${cd}.cd_generation_requests WHERE id=$1 AND owner_id=$2 AND series_id=$3
        ON CONFLICT DO NOTHING`, [quote.confirmationId, owner, series, session, quote]);
      if (result.rowCount) await db.query("INSERT INTO messages(conversation_id,role,content,metadata) VALUES($1,'assistant','',$2)",
        [session, { comicDirectorQuoteId: quote.confirmationId, tool: "request_generation", endsTurn: true, status: "ready" }]);
    });
  }

  async list(owner: string, series: string): Promise<ComicDirectorState> {
    await this.episode(owner, series);
    const conversationId = await this.session(this.pool, owner, series);
    const { rows } = await this.pool.query<ProposalRow>(`SELECT ${columns} FROM ${cd}.cd_director_proposals
      WHERE owner_id=$1 AND series_id=$2 AND conversation_id=$3 ORDER BY created_at DESC,id DESC LIMIT 20`, [owner, series, conversationId]);
    const { rows: quotes } = await this.pool.query<NonNullable<ComicDirectorState["quotes"]>[number]>(`SELECT q.quote,g.confirmed_at IS NOT NULL AS confirmed
      FROM ${cd}.cd_director_quotes q JOIN ${cd}.cd_generation_requests g ON g.id=q.confirmation_id AND g.owner_id=q.owner_id
      WHERE q.owner_id=$1 AND q.series_id=$2 AND q.conversation_id=$3 ORDER BY g.expires_at DESC,g.id DESC LIMIT 20`, [owner, series, conversationId]);
    const messages = conversationId ? await this.chatMessages(conversationId, 40) : [];
    return {
      conversationId,
      proposals: rows.map(view),
      ...(quotes.length ? { quotes } : {}),
      ...(messages.length ? { messages } : {}),
    };
  }

  async chatMessages(conversationId: string, limit = 24): Promise<ComicDirectorChatMessage[]> {
    const { rows } = await this.pool.query<{
      id: string; role: "user" | "assistant"; content: string; createdAt: Date; metadata: Record<string, unknown> | null;
    }>(
      `SELECT id, role, content, created_at AS "createdAt", metadata FROM (
         SELECT id, role, content, created_at, metadata FROM messages
         WHERE conversation_id=$1 AND role IN ('user','assistant') AND metadata->>'comicDirectorChat'='true'
         ORDER BY created_at DESC, id DESC LIMIT $2
       ) recent ORDER BY created_at ASC, id ASC`,
      [conversationId, limit],
    );
    return rows.map(row => {
      const toolCalls = Array.isArray(row.metadata?.toolCalls)
        ? row.metadata.toolCalls as ComicDirectorToolCallSummary[]
        : undefined;
      const proposalId = typeof row.metadata?.proposalId === "string" ? row.metadata.proposalId : undefined;
      const confirmationId = typeof row.metadata?.confirmationId === "string" ? row.metadata.confirmationId : undefined;
      return {
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.createdAt.toISOString(),
        ...(toolCalls?.length ? { toolCalls } : {}),
        ...(proposalId ? { proposalId } : {}),
        ...(confirmationId ? { confirmationId } : {}),
      };
    });
  }

  async ensureChatSession(owner: string, series: string): Promise<{ conversationId: string; revision: number; title: string }> {
    return libraryTransaction(this.pool, async db => {
      const episode = await this.episode(owner, series, db, true);
      const conversationId = await this.ensureSession(db, owner, series, episode.title);
      return { conversationId, revision: episode.revision, title: episode.title };
    });
  }

  async recordChatTurn(
    conversationId: string,
    userText: string,
    assistantText: string,
    toolCalls: ComicDirectorToolCallSummary[],
    model?: string,
    cards?: { proposalId?: string; confirmationId?: string },
  ): Promise<ComicDirectorChatMessage> {
    return libraryTransaction(this.pool, async db => {
      await db.query(
        "INSERT INTO messages(conversation_id,role,content,metadata) VALUES($1,'user',$2,$3)",
        [conversationId, userText, { comicDirectorChat: true }],
      );
      const metadata = {
        comicDirectorChat: true,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(cards?.proposalId ? { proposalId: cards.proposalId, endsTurn: true } : {}),
        ...(cards?.confirmationId ? { confirmationId: cards.confirmationId, endsTurn: true } : {}),
      };
      const { rows: [saved] } = await db.query<{ id: string; createdAt: Date }>(
        `INSERT INTO messages(conversation_id,role,content,model,metadata) VALUES($1,'assistant',$2,$3,$4)
         RETURNING id, created_at AS "createdAt"`,
        [conversationId, assistantText, model ?? null, metadata],
      );
      await db.query("UPDATE conversations SET updated_at=now(),model=$2 WHERE id=$1", [conversationId, model ?? null]);
      return {
        id: saved.id,
        role: "assistant",
        content: assistantText,
        createdAt: saved.createdAt.toISOString(),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(cards?.proposalId ? { proposalId: cards.proposalId } : {}),
        ...(cards?.confirmationId ? { confirmationId: cards.confirmationId } : {}),
      };
    });
  }

  private async get(db: ComicQuery, owner: string, series: string, id: string, lock = false) {
    const { rows: [row] } = await db.query<ProposalRow>(`SELECT ${columns} FROM ${cd}.cd_director_proposals
      WHERE owner_id=$1 AND series_id=$2 AND id=$3 ${lock ? "FOR UPDATE" : ""}`, [owner, series, id]);
    if (!row) libraryMissing();
    return view(row);
  }

  private async buildEnhanceContext(
    db: ComicQuery,
    owner: string,
    series: string,
    episode: {
      title: string; logline: string; seriesGroup?: string | null; episodeNo?: number | null;
      styleKey: string; aspectRatio: string; videoModel: string | null;
    },
    fullScript: string,
    input: ComicDirectorInput,
  ): Promise<DirectorEnhanceContext> {
    const enhance = input.enhance!;
    const cast = await readSeriesCast(db, series);
    const styles = await readComicDictionary(db, owner, "style");
    const styleLabel = styles.find(entry => entry.key === episode.styleKey)?.labels[input.language] ?? episode.styleKey;
    const seriesMeta: DirectorEnhanceSeriesMeta = {
      dramaTitle: episode.seriesGroup ?? episode.title,
      episodeNo: episode.episodeNo ?? 1,
      title: episode.title, logline: episode.logline, styleKey: episode.styleKey,
      styleLabel, aspectRatio: episode.aspectRatio, videoModel: episode.videoModel,
    };
    if (enhance.scope === "script_full" || enhance.scope === "script_excerpt") {
      if (!fullScript.trim()) throw new ComicLibraryError("DIRECTOR_EMPTY_SCRIPT", 400);
      const segments = enhance.scope === "script_full"
        ? splitComicScriptSegments(fullScript, 24)
        : extractComicScriptExcerptSegments(fullScript, enhance.ranges, 24);
      if (!segments?.length) throw new ComicLibraryError("INVALID_INPUT", 400);
      const first = segments[0]!;
      const last = segments[segments.length - 1]!;
      return {
        kind: "script",
        scope: enhance.scope,
        fullScript,
        segments,
        beforeContext: fullScript.slice(Math.max(0, first.start - 600), first.start).trim(),
        afterContext: fullScript.slice(last.end, Math.min(fullScript.length, last.end + 600)).trim(),
        seriesMeta,
        cast,
      };
    }
    const { rows: clipRows } = await db.query(
      `SELECT id, revision, selection_revision AS "selectionRevision", ordinal, draft
       FROM ${cd}.cd_clips WHERE series_id=$1 ORDER BY ordinal`,
      [series],
    );
    const allClips = clipRows.map(row => comicDramaClipSchema.parse(row));
    const requested = new Set(enhance.clipIds);
    const targetClips = allClips.filter(clip => requested.has(clip.id));
    if (targetClips.length !== enhance.clipIds.length) libraryMissing();
    const [framing, movement, emotion] = await Promise.all([
      readComicDictionary(db, owner, "framing"),
      readComicDictionary(db, owner, "movement"),
      readComicDictionary(db, owner, "emotion"),
    ]);
    return {
      kind: "clips",
      seriesMeta,
      cast,
      dictionaries: {
        framing: framing.filter(entry => !entry.inactive),
        movement: movement.filter(entry => !entry.inactive),
        emotion: emotion.filter(entry => !entry.inactive),
      },
      targets: targetClips.map((clip, index) => {
        const pos = allClips.findIndex(item => item.id === clip.id);
        return {
          index,
          clip,
          previousClip: pos > 0 ? allClips[pos - 1]! : null,
          nextClip: pos + 1 < allClips.length ? allClips[pos + 1]! : null,
        };
      }),
    };
  }

  private buildEnhanceProposal(result: DirectorEnhanceResult): { proposal: NonNullable<ComicDirectorProposal["proposal"]>; messageContent: string } {
    if (result.kind === "script") {
      const byIndex = new Map(result.segments.map(seg => [seg.index, seg]));
      const scriptEnhancements: ComicScriptEnhancementSegment[] = result.context.segments.map(seg => {
        const matched = byIndex.get(seg.index);
        const notes = matched?.notes?.trim();
        return {
          index: seg.index,
          start: seg.start,
          end: seg.end,
          original: seg.original,
          suggested: matched?.suggested.trim() || seg.original,
          ...(notes ? { notes } : {}),
          status: "pending",
        };
      });
      const previewScript = applyComicScriptEnhancements(
        result.context.fullScript,
        scriptEnhancements.map(seg => ({ ...seg, status: "applied" as const })),
      );
      return {
        proposal: { script: previewScript, roles: [], scriptEnhancements },
        messageContent: scriptEnhancements.map(seg => seg.suggested).join("\n\n").slice(0, 4000),
      };
    }
    const { dictionaries, seriesMeta, cast, targets } = result.context;
    const framingKeys = new Set(dictionaries.framing.map(entry => entry.key));
    const movementKeys = new Set(dictionaries.movement.map(entry => entry.key));
    const emotionKeys = new Set(dictionaries.emotion.map(entry => entry.key));
    const defaultFraming = dictionaries.framing[0]?.key ?? "medium";
    const defaultMovement = dictionaries.movement[0]?.key ?? "fixed";
    const videoProfile = comicVideoProfile(seriesMeta.videoModel);
    const castCandidates = cast.map(entry => ({
      id: entry.snapshot.characterId,
      name: entry.snapshot.name,
      aliases: entry.snapshot.aliases,
      snapshot: entry.snapshot,
    }));
    const clipEnhancements: ComicClipEnhancementSegment[] = targets.map(target => {
      const llmClip = result.clips.find(item => item.clipId === target.clip.id || item.index === target.index)
        ?? (result.clips.length === targets.length ? result.clips[target.index] : undefined);
      const orig = target.clip.draft;
      const notes = llmClip?.notes?.trim();
      if (!llmClip) {
        return {
          index: target.index, clipId: target.clip.id, ordinal: target.clip.ordinal,
          baseClipRevision: target.clip.revision, original: orig, suggested: orig, status: "pending",
        };
      }
      const validDuration = typeof llmClip.durationMs === "number" && Number.isInteger(llmClip.durationMs)
        && llmClip.durationMs >= 1000 && llmClip.durationMs <= 60_000
        && (!videoProfile || comicVideoDurationSupported(llmClip.durationMs, videoProfile));
      const durationMs = validDuration ? llmClip.durationMs! : orig.durationMs;
      const shares = normalizeShotDurationShares(llmClip.shots.map(shot => shot.durationShare));
      const shots = llmClip.shots.map((shot, i) => {
        const origShot = orig.shots[i];
        const framingKey = framingKeys.has(shot.framingKey)
          ? shot.framingKey
          : (origShot && framingKeys.has(origShot.framingKey) ? origShot.framingKey : defaultFraming);
        const movementKey = movementKeys.has(shot.movementKey)
          ? shot.movementKey
          : (origShot && movementKeys.has(origShot.movementKey) ? origShot.movementKey : defaultMovement);
        return {
          id: origShot?.id ?? randomUUID(),
          framingKey,
          movementKey,
          description: shot.description.trim().slice(0, 2000),
          durationShare: shares[i]!,
          ...(origShot?.sfxRefs?.length ? { sfxRefs: origShot.sfxRefs } : {}),
        };
      });
      const orphanSfx = orig.shots.slice(shots.length).flatMap(shot => shot.sfxRefs ?? []);
      if (orphanSfx.length && shots.length) {
        const lastShot = shots[shots.length - 1]!;
        lastShot.sfxRefs = [...(lastShot.sfxRefs ?? []), ...orphanSfx].slice(0, 5);
      }
      const lines = llmClip.lines.slice(0, 30).map((line, i) => {
        const origLine = orig.lines[i];
        const rawSpeaker = line.speaker?.trim() || null;
        const matched = rawSpeaker ? matchComicCharacters(rawSpeaker, castCandidates) : [];
        const speaker = matched.length === 1 ? matched[0]!.name : rawSpeaker?.slice(0, 120) ?? null;
        const emotionKey = line.emotionKey && emotionKeys.has(line.emotionKey) ? line.emotionKey : null;
        const speed = typeof line.speed === "number" && line.speed >= 0.5 && line.speed <= 2 ? line.speed : (origLine?.speed ?? 1);
        return { id: origLine?.id ?? randomUUID(), speaker, text: line.text.trim().slice(0, 1000), emotionKey, speed };
      });
      const scene = llmClip.scene.trim().slice(0, 1000) || orig.scene;
      const mergedCast = mergeMatchedClipCast(orig.cast ?? [], castCandidates, lines, [scene, ...shots.map(s => s.description)]);
      const suggested = comicDramaClipDraftSchema.parse({
        schemaVersion: 1,
        durationMs,
        scene,
        shots,
        lines,
        ...(mergedCast.length ? { cast: mergedCast } : {}),
        ...(orig.sceneRef !== undefined ? { sceneRef: orig.sceneRef } : {}),
        ...(orig.propRefs !== undefined ? { propRefs: orig.propRefs } : {}),
        ...(orig.sfxRefs !== undefined ? { sfxRefs: orig.sfxRefs } : {}),
        ...(orig.videoInputs ? { videoInputs: orig.videoInputs } : {}),
      });
      return {
        index: target.index,
        clipId: target.clip.id,
        ordinal: target.clip.ordinal,
        baseClipRevision: target.clip.revision,
        original: orig,
        suggested,
        ...(notes ? { notes } : {}),
        status: "pending",
      };
    });
    return {
      proposal: { script: "", roles: [], clipEnhancements },
      messageContent: clipEnhancements.map(item => item.suggested.scene).join("\n"),
    };
  }

  claim(owner: string, series: string, input: ComicDirectorInput, accepting?: () => void) {
    return libraryTransaction(this.pool, async db => {
      const episode = await this.episode(owner, series, db, true);
      const { rows: [same] } = await db.query<ProposalRow>(`SELECT ${columns} FROM ${cd}.cd_director_proposals
        WHERE owner_id=$1 AND series_id=$2 AND request_id=$3`, [owner, series, input.requestId]);
      if (same) {
        const sameEnhance = JSON.stringify(same.input.enhance ?? null) === JSON.stringify(input.enhance ?? null);
        if (same.input.expectedRevision !== input.expectedRevision || same.input.text !== input.text || same.input.mode !== input.mode ||
          same.input.language !== input.language || (same.input.action ?? "script") !== (input.action ?? "script") || !sameEnhance) {
          throw new ComicLibraryError("DIRECTOR_REQUEST_CONFLICT", 409);
        }
        return { proposal: view(same), episode, created: false, previousScenes: [] as string[], enhanceContext: undefined };
      }
      if (episode.revision !== input.expectedRevision) throw new ComicDramaError("REVISION_CONFLICT", episode.revision);
      accepting?.();
      await db.query(`UPDATE ${cd}.cd_director_proposals SET status='unknown' WHERE owner_id=$1 AND series_id=$2 AND status='writing'
        AND created_at<now()-interval '150 seconds'`, [owner, series]);
      const active = await db.query(`SELECT 1 FROM ${cd}.cd_director_proposals WHERE owner_id=$1 AND series_id=$2 AND status='writing'`, [owner, series]);
      if (active.rowCount) throw new ComicLibraryError("DIRECTOR_BUSY", 409);
      const conversation = await this.ensureSession(db, owner, series, episode.title);
      const { rows: [script] } = await db.query<{ content: string }>(`SELECT content FROM ${cd}.cd_scripts
        WHERE series_id=$1 ORDER BY version DESC LIMIT 1`, [series]);
      const fullScript = script?.content ?? "";
      const enhanceContext = input.action === "enhance" && input.enhance
        ? await this.buildEnhanceContext(db, owner, series, episode, fullScript, input)
        : undefined;
      const { rows: [row] } = await db.query<ProposalRow>(`INSERT INTO ${cd}.cd_director_proposals
        (owner_id,series_id,conversation_id,request_id,base_revision,input,original,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'writing') RETURNING ${columns}`,
      [owner, series, conversation, input.requestId, episode.revision, input, fullScript]);
      const userMsg = input.text || (input.enhance?.scope === "clips" ? "AI 增强分镜" : "AI 增强剧本");
      await db.query("INSERT INTO messages(conversation_id,role,content,metadata) VALUES($1,'user',$2,$3)",
        [conversation, userMsg, { comicDirectorProposalId: row.id, mode: input.mode }]);
      const { rows: previous } = input.action === "breakdown" ? await db.query<{ scene: string }>(`SELECT draft->>'scene' AS scene
        FROM ${cd}.cd_clips WHERE series_id=$1 ORDER BY ordinal`, [series]) : { rows: [] };
      return { proposal: view(row), episode, created: true, previousScenes: previous.map(item => item.scene), enhanceContext };
    });
  }

  async finish(
    owner: string,
    series: string,
    id: string,
    result: ComicDirectorModel | ComicDirectorBreakdown | DirectorEnhanceResult | "failed" | "unknown",
    model?: string,
    previousScenes: string[] = [],
  ) {
    return libraryTransaction(this.pool, async db => {
      const row = await this.get(db, owner, series, id, true);
      if (row.status !== "writing") return row;
      const status = typeof result === "string" ? result : "ready";
      let proposal: ComicDirectorProposal["proposal"] = null;
      if (typeof result !== "string" && "kind" in result) {
        const built = this.buildEnhanceProposal(result);
        proposal = built.proposal;
        await db.query("INSERT INTO messages(conversation_id,role,content,model,metadata) VALUES($1,'assistant',$2,$3,$4)",
          [row.conversationId, built.messageContent, model ?? null, { comicDirectorProposalId: id, status: "ready", endsTurn: true }]);
        await db.query("UPDATE conversations SET updated_at=now(),model=$2 WHERE id=$1", [row.conversationId, model ?? null]);
      } else if (typeof result !== "string") {
        type Candidate = ComicDirectorRole["candidates"][number];
        const { rows } = await db.query<Required<Candidate> & { aliases: string[] }>(`SELECT id,name,aliases,left(appearance,80) AS appearance
          FROM ${cd}.cd_characters WHERE owner_id=$1 AND archived_at IS NULL ORDER BY name,id`, [owner]);
        const seriesCast = "clips" in result ? await readSeriesCast(db, series) : [];
        const castCandidates = seriesCast.map(entry => ({
          id: entry.snapshot.characterId,
          name: entry.snapshot.name,
          aliases: entry.snapshot.aliases,
          snapshot: entry.snapshot,
        }));
        const clips = "clips" in result ? result.clips.map(clip => {
          const matchedCast = mergeMatchedClipCast([], castCandidates, clip.lines, [clip.scene, ...clip.shots]);
          return comicDramaClipDraftSchema.parse({
            schemaVersion: 1, scene: clip.scene, durationMs: clip.durationMs,
            shots: clip.shots.map((description, i) => ({ id: randomUUID(), framingKey: "medium", movementKey: "fixed", description,
              durationShare: Math.floor(100 / clip.shots.length) + (i < 100 % clip.shots.length ? 1 : 0) })),
            lines: clip.lines.map(line => ({ id: randomUUID(), ...line, speed: 1, emotionKey: null })),
            ...(matchedCast.length ? { cast: matchedCast } : {}),
          });
        }) : undefined;
        proposal = {
          script: "script" in result ? result.script : "",
          ...(clips ? { clips, previousScenes } : {}),
          roles: result.characters.map(role => ({
            ...role,
            candidates: matchComicCharacters(role.name, rows).slice(0, 24).map(({ id, name, appearance }) => ({ id, name, appearance })),
          })),
        };
        const content = clips ? clips.map(clip => clip.scene).join("\n") : proposal.script;
        await db.query("INSERT INTO messages(conversation_id,role,content,model,metadata) VALUES($1,'assistant',$2,$3,$4)",
          [row.conversationId, content, model ?? null, { comicDirectorProposalId: id, status: "ready", endsTurn: true }]);
        await db.query("UPDATE conversations SET updated_at=now(),model=$2 WHERE id=$1", [row.conversationId, model ?? null]);
      }
      const { rows: [updated] } = await db.query<ProposalRow>(`UPDATE ${cd}.cd_director_proposals SET status=$4,proposal=$5,model=$6
        WHERE owner_id=$1 AND series_id=$2 AND id=$3 RETURNING ${columns}`, [owner, series, id, status, proposal, model ?? null]);
      return view(updated);
    });
  }

  private async decideEnhance(
    db: ComicQuery & Parameters<PgComicDramaRepository["writeScript"]>[0],
    owner: string,
    series: string,
    episode: { revision: number },
    row: ComicDirectorProposal,
    input?: ComicDirectorApplyInput,
    dismissItemIndex?: number,
  ): Promise<ComicDirectorProposal> {
    if (!row.proposal) throw new ComicLibraryError("DIRECTOR_PROPOSAL_UNAVAILABLE", 409);
    const scriptSegs = row.proposal.scriptEnhancements;
    const clipSegs = row.proposal.clipEnhancements;
    if (!scriptSegs?.length && !clipSegs?.length) throw new ComicLibraryError("DIRECTOR_PROPOSAL_UNAVAILABLE", 409);

    if (input === undefined) {
      const items = scriptSegs ?? clipSegs!;
      if (dismissItemIndex !== undefined) {
        const idx = items.findIndex(seg => seg.index === dismissItemIndex);
        if (idx < 0) throw new ComicLibraryError("INVALID_INPUT", 400);
        if (items[idx]!.status === "applied") throw new ComicLibraryError("DIRECTOR_REQUEST_CONFLICT", 409);
        if (items[idx]!.status === "dismissed") return row;
        if (row.status !== "ready") throw new ComicLibraryError("DIRECTOR_PROPOSAL_UNAVAILABLE", 409);
        items[idx]!.status = "dismissed";
      } else {
        if (row.status === "dismissed") return row;
        if (row.status === "applied") throw new ComicLibraryError("DIRECTOR_REQUEST_CONFLICT", 409);
        if (row.status !== "ready") throw new ComicLibraryError("DIRECTOR_PROPOSAL_UNAVAILABLE", 409);
        for (const seg of items) {
          if (seg.status === "pending") seg.status = "dismissed";
        }
      }
      const hasPending = items.some(seg => seg.status === "pending");
      const hasApplied = items.some(seg => seg.status === "applied");
      const nextStatus = hasPending ? "ready" : hasApplied ? "applied" : "dismissed";
      const { rows: [updated] } = await db.query<ProposalRow>(
        `UPDATE ${cd}.cd_director_proposals SET status=$4,proposal=$5 WHERE owner_id=$1 AND series_id=$2 AND id=$3 RETURNING ${columns}`,
        [owner, series, row.id, nextStatus, row.proposal],
      );
      await db.query(
        `UPDATE messages SET metadata=metadata || jsonb_build_object('status',$3::text)
         WHERE conversation_id=$1 AND role='assistant' AND metadata->>'comicDirectorProposalId'=$2`,
        [row.conversationId, row.id, nextStatus],
      );
      return view(updated);
    }

    if (row.status !== "ready") throw new ComicLibraryError("DIRECTOR_PROPOSAL_UNAVAILABLE", 409);
    const expectedBase = row.appliedRevision ?? row.baseRevision;
    if (input.expectedRevision !== expectedBase || episode.revision !== expectedBase) {
      throw new ComicLibraryError("DIRECTOR_PROPOSAL_STALE", 409);
    }
    if (input.decision && input.decision !== "enhance") throw new ComicLibraryError("INVALID_INPUT", 400);

    let nextRevision: number;
    let nextProposal: NonNullable<ComicDirectorProposal["proposal"]>;
    let hasPending = false;
    if (scriptSegs?.length) {
      if (input.clipItems?.length) throw new ComicLibraryError("INVALID_INPUT", 400);
      const nextSegs = scriptSegs.map(seg => ({ ...seg }));
      const selected: NonNullable<ComicDirectorApplyInput["scriptItems"]> = input.scriptItems
        ?? nextSegs.filter(seg => seg.status === "pending").map(seg => ({ index: seg.index }));
      if (!selected.length) throw new ComicLibraryError("INVALID_INPUT", 400);
      const seen = new Set<number>();
      for (const item of selected) {
        if (seen.has(item.index)) throw new ComicLibraryError("INVALID_INPUT", 400);
        seen.add(item.index);
        const seg = nextSegs.find(entry => entry.index === item.index);
        if (!seg) throw new ComicLibraryError("INVALID_INPUT", 400);
        if (seg.status !== "pending") throw new ComicLibraryError("DIRECTOR_REQUEST_CONFLICT", 409);
        seg.status = "applied";
        seg.appliedText = item.text ?? seg.suggested;
      }
      const nextScript = applyComicScriptEnhancements(row.original, nextSegs);
      if (nextScript.length > COMIC_SCRIPT_MAX_CHARS) throw new ComicLibraryError("INVALID_INPUT", 400);
      nextRevision = await this.episodes.writeScript(db, owner, series, expectedBase, nextScript, "assistant");
      hasPending = nextSegs.some(seg => seg.status === "pending");
      nextProposal = { ...row.proposal, scriptEnhancements: nextSegs };
    } else if (clipSegs?.length) {
      if (input.scriptItems?.length) throw new ComicLibraryError("INVALID_INPUT", 400);
      const nextSegs = clipSegs.map(seg => ({ ...seg }));
      const selected: NonNullable<ComicDirectorApplyInput["clipItems"]> = input.clipItems
        ?? nextSegs.filter(seg => seg.status === "pending").map(seg => ({ index: seg.index }));
      if (!selected.length) throw new ComicLibraryError("INVALID_INPUT", 400);
      const seen = new Set<number>();
      const updates: Array<{ clipId: string; expectedClipRevision: number; draft: ComicDramaClipDraft }> = [];
      for (const item of selected) {
        if (seen.has(item.index)) throw new ComicLibraryError("INVALID_INPUT", 400);
        seen.add(item.index);
        const seg = nextSegs.find(entry => entry.index === item.index);
        if (!seg) throw new ComicLibraryError("INVALID_INPUT", 400);
        if (seg.status !== "pending") throw new ComicLibraryError("DIRECTOR_REQUEST_CONFLICT", 409);
        const parsed = comicDramaClipDraftSchema.safeParse(item.draft ?? seg.suggested);
        if (!parsed.success) throw new ComicLibraryError("INVALID_INPUT", 400);
        updates.push({ clipId: seg.clipId, expectedClipRevision: seg.baseClipRevision, draft: parsed.data });
        seg.status = "applied";
        seg.appliedDraft = parsed.data;
        seg.baseClipRevision += 1;
      }
      nextRevision = await this.episodes.writeEnhancedClips(db, owner, series, expectedBase, updates);
      hasPending = nextSegs.some(seg => seg.status === "pending");
      nextProposal = { ...row.proposal, clipEnhancements: nextSegs };
    } else {
      throw new ComicLibraryError("DIRECTOR_PROPOSAL_UNAVAILABLE", 409);
    }
    const nextStatus = hasPending ? "ready" : "applied";
    const { rows: [updated] } = await db.query<ProposalRow>(
      `UPDATE ${cd}.cd_director_proposals SET status=$4,applied_revision=$5,decision='enhance',proposal=$6
       WHERE owner_id=$1 AND series_id=$2 AND id=$3 RETURNING ${columns}`,
      [owner, series, row.id, nextStatus, nextRevision, nextProposal],
    );
    await db.query(
      `UPDATE messages SET metadata=metadata || jsonb_build_object('status',$3::text,'decision','enhance','sequelId',null::text)
       WHERE conversation_id=$1 AND role='assistant' AND metadata->>'comicDirectorProposalId'=$2`,
      [row.conversationId, row.id, nextStatus],
    );
    return view(updated);
  }

  async decide(owner: string, series: string, id: string, input?: ComicDirectorApplyInput, dismissItemIndex?: number) {
    return libraryTransaction(this.pool, async db => {
      const episode = await this.episode(owner, series, db, true);
      const row = await this.get(db, owner, series, id, true);
      if (row.input.action === "enhance") {
        return this.decideEnhance(db, owner, series, episode, row, input, dismissItemIndex);
      }
      const expected = input?.expectedRevision;
      const decision: ComicDirectorDecision = input?.decision;
      const status = expected === undefined ? "dismissed" : "applied";
      if (row.status === status) {
        if ((row.decision ?? undefined) !== decision) throw new ComicLibraryError("DIRECTOR_REQUEST_CONFLICT", 409);
        return row;
      }
      if (row.status !== "ready" || !row.proposal) throw new ComicLibraryError("DIRECTOR_PROPOSAL_UNAVAILABLE", 409);
      let revision: number | null = null, sequelId: string | null = null;
      if (expected !== undefined) {
        if (expected !== row.baseRevision || episode.revision !== expected) throw new ComicLibraryError("DIRECTOR_PROPOSAL_STALE", 409);
        if (row.input.action === "sequel" && decision === "sequel") {
          const next = await this.episodes.deriveOn(db, owner, series, true);
          sequelId = next.series.id;
          await this.episodes.writeScript(db, owner, sequelId, next.series.revision, row.proposal.script, "assistant");
          revision = expected;
        } else if (row.proposal.clips && (decision === "append" || decision === "replace")) {
          revision = await this.episodes.writeBreakdown(db, owner, series, expected, row.proposal.clips, decision === "replace");
        } else if (!decision && (!row.input.action || row.input.action === "script")) {
          revision = await this.episodes.writeScript(db, owner, series, expected, row.proposal.script, "assistant");
        } else throw new ComicLibraryError("INVALID_INPUT", 400);
      }
      const { rows: [updated] } = await db.query<ProposalRow>(`UPDATE ${cd}.cd_director_proposals SET status=$4,applied_revision=$5,decision=$6,sequel_id=$7
        WHERE owner_id=$1 AND series_id=$2 AND id=$3 RETURNING ${columns}`, [owner, series, id, status, revision, decision ?? null, sequelId]);
      await db.query(`UPDATE messages SET metadata=metadata || jsonb_build_object('status',$3::text,'decision',$4::text,'sequelId',$5::text)
        WHERE conversation_id=$1 AND role='assistant' AND metadata->>'comicDirectorProposalId'=$2`, [row.conversationId, id, status, decision ?? null, sequelId]);
      return view(updated);
    });
  }

  role(owner: string, series: string, id: string, index: number, input: ComicDirectorRoleDecision) {
    return libraryTransaction(this.pool, async db => {
      const sourceEpisode = await this.episode(owner, series, db, true);
      const row = await this.get(db, owner, series, id, true);
      const suggestion = row.proposal?.roles[index];
      if (row.status !== "applied" || !suggestion) throw new ComicLibraryError("DIRECTOR_PROPOSAL_UNAVAILABLE", 409);
      const targetSeriesId = row.sequelId ?? series;
      const targetEpisode = targetSeriesId === series ? sourceEpisode : await this.episode(owner, targetSeriesId, db, true);
      const previous = row.roleDecisions?.[index];
      if (previous) {
        if (previous.choice !== input.choice || (input.choice === "existing" && previous.characterId !== input.characterId)) {
          throw new ComicLibraryError("DIRECTOR_REQUEST_CONFLICT", 409);
        }
        return previous;
      }
      if (targetEpisode.revision !== input.expectedRevision && sourceEpisode.revision !== input.expectedRevision) {
        throw new ComicLibraryError("DIRECTOR_PROPOSAL_STALE", 409);
      }
      let characterId: string | null = null, revision = targetEpisode.revision;
      if (input.choice !== "skip") {
        let outfitId: string;
        if (input.choice === "existing") {
          if (!suggestion.candidates.some(candidate => candidate.id === input.characterId)) libraryMissing();
          ({ characterId, outfitId } = input);
        } else {
          const { rows: [character] } = await db.query<{ id: string }>(`INSERT INTO ${cd}.cd_characters
            (owner_id,name,aliases,tags,age,personality,appearance) VALUES($1,$2,'{}','{}','','',$3) RETURNING id`,
          [owner, suggestion.name, suggestion.description]);
          characterId = character.id;
          const { rows: [outfit] } = await db.query<{ id: string }>(`INSERT INTO ${cd}.cd_character_outfits(owner_id,character_id,name)
            VALUES($1,$2,$3) RETURNING id`, [owner, characterId, input.outfitName]);
          outfitId = outfit.id;
        }
        const { rowCount } = await db.query(`SELECT 1 FROM ${cd}.cd_series_cast WHERE series_id=$1 AND character_id=$2 AND outfit_id=$3`,
          [targetSeriesId, characterId, outfitId]);
        if (!rowCount) {
          await editSeriesCast(db, owner, targetSeriesId, { action: "add", characterId, outfitId });
          const { rows: [next] } = await db.query<{ revision: number }>(`UPDATE ${cd}.cd_series
            SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING revision`, [targetSeriesId]);
          revision = next.revision;
        }
      }
      const outcome: ComicDirectorRoleOutcome = { choice: input.choice, characterId, revision };
      await db.query(`INSERT INTO ${cd}.cd_director_roles(proposal_id,role_index,outcome) VALUES($1,$2,$3)`, [id, index, outcome]);
      await db.query(`UPDATE messages SET metadata=metadata || jsonb_build_object('roleDecisions',
        coalesce(metadata->'roleDecisions','{}') || jsonb_build_object($3::text,$4::jsonb))
        WHERE conversation_id=$1 AND role='assistant' AND metadata->>'comicDirectorProposalId'=$2`, [row.conversationId, id, index, outcome]);
      return outcome;
    });
  }
}
