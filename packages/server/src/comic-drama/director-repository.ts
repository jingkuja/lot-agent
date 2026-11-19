import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  COMIC_DIRECTOR_AGENT_ID, type ComicDirectorInput, type ComicDirectorModel, type ComicDirectorProposal, type ComicDirectorState,
} from "@lot-agent/core/comic-drama";
import { ComicLibraryError, libraryMissing, libraryTransaction, type ComicQuery } from "./library-db.js";
import { ComicDramaError, PgComicDramaRepository } from "./repository.js";

const cd = "lot_comic_drama";
const columns = `id,conversation_id AS "conversationId",base_revision AS "baseRevision",created_at AS "createdAt",input,original,proposal,
  CASE WHEN status='writing' AND created_at<now()-interval '150 seconds' THEN 'unknown' ELSE status END AS status,
  applied_revision AS "appliedRevision"`;
type ProposalRow = Omit<ComicDirectorProposal, "createdAt"> & { createdAt: Date };
const view = (row: ProposalRow): ComicDirectorProposal => ({ ...row, createdAt: row.createdAt.toISOString() });
const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase();

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

  async list(owner: string, series: string): Promise<ComicDirectorState> {
    await this.episode(owner, series);
    const conversationId = await this.session(this.pool, owner, series);
    const { rows } = await this.pool.query<ProposalRow>(`SELECT ${columns} FROM ${cd}.cd_director_proposals
      WHERE owner_id=$1 AND series_id=$2 AND conversation_id=$3 ORDER BY created_at DESC,id DESC LIMIT 20`, [owner, series, conversationId]);
    return { conversationId, proposals: rows.map(view) };
  }

  private async get(db: ComicQuery, owner: string, series: string, id: string, lock = false) {
    const { rows: [row] } = await db.query<ProposalRow>(`SELECT ${columns} FROM ${cd}.cd_director_proposals
      WHERE owner_id=$1 AND series_id=$2 AND id=$3 ${lock ? "FOR UPDATE" : ""}`, [owner, series, id]);
    if (!row) libraryMissing();
    return view(row);
  }

  claim(owner: string, series: string, input: ComicDirectorInput) {
    return libraryTransaction(this.pool, async db => {
      const episode = await this.episode(owner, series, db, true);
      const { rows: [same] } = await db.query<ProposalRow>(`SELECT ${columns} FROM ${cd}.cd_director_proposals
        WHERE owner_id=$1 AND series_id=$2 AND request_id=$3`, [owner, series, input.requestId]);
      if (same) {
        if (same.input.expectedRevision !== input.expectedRevision || same.input.text !== input.text || same.input.mode !== input.mode ||
          same.input.language !== input.language) throw new ComicLibraryError("DIRECTOR_REQUEST_CONFLICT", 409);
        return { proposal: view(same), episode, created: false };
      }
      if (episode.revision !== input.expectedRevision) throw new ComicDramaError("REVISION_CONFLICT", episode.revision);
      await db.query(`UPDATE ${cd}.cd_director_proposals SET status='unknown' WHERE owner_id=$1 AND series_id=$2 AND status='writing'
        AND created_at<now()-interval '150 seconds'`, [owner, series]);
      const active = await db.query(`SELECT 1 FROM ${cd}.cd_director_proposals WHERE owner_id=$1 AND series_id=$2 AND status='writing'`, [owner, series]);
      if (active.rowCount) throw new ComicLibraryError("DIRECTOR_BUSY", 409);
      let conversation = await this.session(db, owner, series);
      if (!conversation) {
        conversation = randomUUID();
        await db.query("INSERT INTO conversations(id,user_id,agent_id,title,metadata) VALUES($1,$2,$3,$4,$5)",
          [conversation, owner, COMIC_DIRECTOR_AGENT_ID, episode.title, { comicSeriesId: series }]);
        await db.query(`INSERT INTO ${cd}.cd_director_sessions(owner_id,series_id,conversation_id) VALUES($1,$2,$3)`, [owner, series, conversation]);
      }
      const { rows: [script] } = await db.query<{ content: string }>(`SELECT content FROM ${cd}.cd_scripts
        WHERE series_id=$1 ORDER BY version DESC LIMIT 1`, [series]);
      const { rows: [row] } = await db.query<ProposalRow>(`INSERT INTO ${cd}.cd_director_proposals
        (owner_id,series_id,conversation_id,request_id,base_revision,input,original,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'writing') RETURNING ${columns}`,
      [owner, series, conversation, input.requestId, episode.revision, input, script?.content ?? ""]);
      await db.query("INSERT INTO messages(conversation_id,role,content,metadata) VALUES($1,'user',$2,$3)",
        [conversation, input.text, { comicDirectorProposalId: row.id, mode: input.mode }]);
      return { proposal: view(row), episode, created: true };
    });
  }

  async finish(owner: string, series: string, id: string, result: ComicDirectorModel | "failed" | "unknown", model?: string) {
    return libraryTransaction(this.pool, async db => {
      const row = await this.get(db, owner, series, id, true);
      if (row.status !== "writing") return row;
      const status = typeof result === "string" ? result : "ready";
      let proposal: ComicDirectorProposal["proposal"] = null;
      if (typeof result !== "string") {
        const { rows } = await db.query<{ id: string; name: string; aliases: string[] }>(`SELECT id,name,aliases FROM ${cd}.cd_characters
          WHERE owner_id=$1 AND archived_at IS NULL ORDER BY name,id`, [owner]);
        const byName = new Map<string, Map<string, { id: string; name: string }>>();
        for (const { id, name, aliases } of rows) for (const value of [name, ...aliases]) {
          const key = normalize(value);
          const matches = byName.get(key) ?? new Map();
          if (matches.size < 24) matches.set(id, { id, name });
          byName.set(key, matches);
        }
        proposal = { script: result.script, roles: result.characters.map(role => ({
          ...role, candidates: [...byName.get(normalize(role.name))?.values() ?? []],
        })) };
        await db.query("INSERT INTO messages(conversation_id,role,content,model,metadata) VALUES($1,'assistant',$2,$3,$4)",
          [row.conversationId, result.script, model ?? null, { comicDirectorProposalId: id, status: "ready" }]);
        await db.query("UPDATE conversations SET updated_at=now(),model=$2 WHERE id=$1", [row.conversationId, model ?? null]);
      }
      const { rows: [updated] } = await db.query<ProposalRow>(`UPDATE ${cd}.cd_director_proposals SET status=$4,proposal=$5,model=$6
        WHERE owner_id=$1 AND series_id=$2 AND id=$3 RETURNING ${columns}`, [owner, series, id, status, proposal, model ?? null]);
      return view(updated);
    });
  }

  async decide(owner: string, series: string, id: string, expected?: number) {
    return libraryTransaction(this.pool, async db => {
      await this.episode(owner, series, db, true);
      const row = await this.get(db, owner, series, id, true);
      const status = expected === undefined ? "dismissed" : "applied";
      if (row.status === status) return row;
      if (row.status !== "ready" || !row.proposal) throw new ComicLibraryError("DIRECTOR_PROPOSAL_UNAVAILABLE", 409);
      if (expected !== undefined && expected !== row.baseRevision) throw new ComicLibraryError("DIRECTOR_PROPOSAL_STALE", 409);
      const revision = expected === undefined ? null : await this.episodes.writeScript(db, owner, series, expected, row.proposal.script, "assistant");
      const { rows: [updated] } = await db.query<ProposalRow>(`UPDATE ${cd}.cd_director_proposals SET status=$4,applied_revision=$5
        WHERE owner_id=$1 AND series_id=$2 AND id=$3 RETURNING ${columns}`, [owner, series, id, status, revision]);
      await db.query(`UPDATE messages SET metadata=metadata || jsonb_build_object('status',$3::text)
        WHERE conversation_id=$1 AND role='assistant' AND metadata->>'comicDirectorProposalId'=$2`, [row.conversationId, id, status]);
      return view(updated);
    });
  }
}
