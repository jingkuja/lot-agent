import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  COMIC_DIRECTOR_AGENT_ID, comicDramaClipDraftSchema, matchComicCharacters,
  type ComicClipCasting, type ComicDirectorBreakdown, type ComicDirectorChatMessage, type ComicDirectorDecision, type ComicDirectorInput,
  type ComicDirectorModel, type ComicDirectorProposal, type ComicDirectorRole, type ComicDirectorRoleDecision,
  type ComicDirectorRoleOutcome, type ComicDirectorState, type ComicDirectorToolCallSummary, type ComicGenerationQuote,
} from "@lot-agent/core/comic-drama";
import { ComicLibraryError, libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";
import { ComicDramaError, PgComicDramaRepository } from "./repository.js";
import { editSeriesCast, readSeriesCast } from "./cast-store.js";

const cd = "lot_comic_drama";
const columns = `id,conversation_id AS "conversationId",base_revision AS "baseRevision",created_at AS "createdAt",input,original,proposal,
  CASE WHEN status='writing' AND created_at<now()-interval '150 seconds' THEN 'unknown' ELSE status END AS status,
  applied_revision AS "appliedRevision",decision,sequel_id AS "sequelId",
  coalesce((SELECT jsonb_object_agg(role_index,outcome) FROM ${cd}.cd_director_roles WHERE proposal_id=cd_director_proposals.id),'{}') AS "roleDecisions"`;
type ProposalRow = Omit<ComicDirectorProposal, "createdAt"> & { createdAt: Date };
const view = (row: ProposalRow): ComicDirectorProposal => ({ ...row, createdAt: row.createdAt.toISOString() });

export class PgComicDirector {
  constructor(private readonly pool: Pool, private readonly episodes = new PgComicDramaRepository(pool)) {}

  async episode(owner: string, series: string, db: ComicQuery = this.pool, lock = false) {
    const { rows: [row] } = await db.query<{ title: string; logline: string; revision: number; archived: boolean }>(
      `SELECT title,logline,revision,archived_at IS NOT NULL AS archived FROM ${cd}.cd_series
        WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL ${lock ? "FOR UPDATE" : ""}`, [owner, series]);
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
      return {
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.createdAt.toISOString(),
        ...(toolCalls?.length ? { toolCalls } : {}),
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
  ): Promise<ComicDirectorChatMessage> {
    return libraryTransaction(this.pool, async db => {
      await db.query(
        "INSERT INTO messages(conversation_id,role,content,metadata) VALUES($1,'user',$2,$3)",
        [conversationId, userText, { comicDirectorChat: true }],
      );
      const { rows: [saved] } = await db.query<{ id: string; createdAt: Date }>(
        `INSERT INTO messages(conversation_id,role,content,model,metadata) VALUES($1,'assistant',$2,$3,$4)
         RETURNING id, created_at AS "createdAt"`,
        [conversationId, assistantText, model ?? null, { comicDirectorChat: true, ...(toolCalls.length ? { toolCalls } : {}) }],
      );
      await db.query("UPDATE conversations SET updated_at=now(),model=$2 WHERE id=$1", [conversationId, model ?? null]);
      return {
        id: saved.id,
        role: "assistant",
        content: assistantText,
        createdAt: saved.createdAt.toISOString(),
        ...(toolCalls.length ? { toolCalls } : {}),
      };
    });
  }

  private async get(db: ComicQuery, owner: string, series: string, id: string, lock = false) {
    const { rows: [row] } = await db.query<ProposalRow>(`SELECT ${columns} FROM ${cd}.cd_director_proposals
      WHERE owner_id=$1 AND series_id=$2 AND id=$3 ${lock ? "FOR UPDATE" : ""}`, [owner, series, id]);
    if (!row) libraryMissing();
    return view(row);
  }

  claim(owner: string, series: string, input: ComicDirectorInput, accepting?: () => void) {
    return libraryTransaction(this.pool, async db => {
      const episode = await this.episode(owner, series, db, true);
      const { rows: [same] } = await db.query<ProposalRow>(`SELECT ${columns} FROM ${cd}.cd_director_proposals
        WHERE owner_id=$1 AND series_id=$2 AND request_id=$3`, [owner, series, input.requestId]);
      if (same) {
        if (same.input.expectedRevision !== input.expectedRevision || same.input.text !== input.text || same.input.mode !== input.mode ||
          same.input.language !== input.language || (same.input.action ?? "script") !== (input.action ?? "script")) {
          throw new ComicLibraryError("DIRECTOR_REQUEST_CONFLICT", 409);
        }
        return { proposal: view(same), episode, created: false, previousScenes: [] as string[] };
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
      const { rows: [row] } = await db.query<ProposalRow>(`INSERT INTO ${cd}.cd_director_proposals
        (owner_id,series_id,conversation_id,request_id,base_revision,input,original,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'writing') RETURNING ${columns}`,
      [owner, series, conversation, input.requestId, episode.revision, input, script?.content ?? ""]);
      await db.query("INSERT INTO messages(conversation_id,role,content,metadata) VALUES($1,'user',$2,$3)",
        [conversation, input.text, { comicDirectorProposalId: row.id, mode: input.mode }]);
      const { rows: previous } = input.action === "breakdown" ? await db.query<{ scene: string }>(`SELECT draft->>'scene' AS scene
        FROM ${cd}.cd_clips WHERE series_id=$1 ORDER BY ordinal`, [series]) : { rows: [] };
      return { proposal: view(row), episode, created: true, previousScenes: previous.map(row => row.scene) };
    });
  }

  async finish(owner: string, series: string, id: string, result: ComicDirectorModel | ComicDirectorBreakdown | "failed" | "unknown",
    model?: string, previousScenes: string[] = []) {
    return libraryTransaction(this.pool, async db => {
      const row = await this.get(db, owner, series, id, true);
      if (row.status !== "writing") return row;
      const status = typeof result === "string" ? result : "ready";
      let proposal: ComicDirectorProposal["proposal"] = null;
      if (typeof result !== "string") {
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
          const matchedCast: ComicClipCasting = [];
          const added = new Set<string>();
          const addCastByQuery = (query: string) => {
            const found = matchComicCharacters(query, castCandidates);
            if (found.length !== 1) return;
            const member = found[0]!;
            if (added.has(member.id)) return;
            added.add(member.id);
            const slot = member.snapshot.assets.find(asset => asset.kind === "slot" && asset.key === "front")
              ?? member.snapshot.assets.find(asset => asset.kind === "slot");
            matchedCast.push({ characterId: member.id, slotKey: slot?.key ?? null, expressionKey: null });
          };
          for (const line of clip.lines) {
            if (line.speaker) addCastByQuery(line.speaker);
          }
          const bodyText = [clip.scene, ...clip.shots].join(" ");
          for (const member of castCandidates) {
            if (added.has(member.id)) continue;
            const names = [member.name, ...member.aliases].filter(name => name.trim().length >= 2);
            if (names.some(name => bodyText.includes(name))) {
              added.add(member.id);
              const slot = member.snapshot.assets.find(asset => asset.kind === "slot" && asset.key === "front")
                ?? member.snapshot.assets.find(asset => asset.kind === "slot");
              matchedCast.push({ characterId: member.id, slotKey: slot?.key ?? null, expressionKey: null });
            }
          }
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

  async decide(owner: string, series: string, id: string, expected?: number, decision?: ComicDirectorDecision) {
    return libraryTransaction(this.pool, async db => {
      const episode = await this.episode(owner, series, db, true);
      const row = await this.get(db, owner, series, id, true);
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
