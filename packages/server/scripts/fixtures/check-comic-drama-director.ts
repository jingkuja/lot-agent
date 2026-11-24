import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Document, Packer, Paragraph } from "docx";
import type { Hono } from "hono";
import type { Pool } from "pg";
import type { LLMProvider } from "@lot-agent/core";
import { mapAnthropicStream, mapOpenAIStream, mapResponsesStream } from "@lot-agent/core";
import {
  COMIC_DIRECTOR_AGENT_ID, COMIC_DRAMA_API_ROOT, COMIC_SCRIPT_DOCX,
  type ComicDirectorInput, type ComicDirectorProposal, type ComicDirectorState, type ComicScriptImport,
} from "@lot-agent/core/comic-drama";
import { ComicDirector, createComicDirectorExtension } from "../../src/comic-drama/director-agent.js";
import { PgComicDirector } from "../../src/comic-drama/director-repository.js";
import { createComicDirectorRoutes } from "../../src/comic-drama/director-routes.js";
import type { PgComicDramaRepository } from "../../src/comic-drama/repository.js";

type App = Hono<{ Variables: { userId: string } }>;
export const directorDraft = "W10 导演草稿\n\n林夏推开便利店的门。\n老板：今天还营业。";

async function* streamOf<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function openAiToolStream(id: string, name: string, args: unknown, finish: "tool_calls" | "length" | "content_filter" = "tool_calls") {
  return mapOpenAIStream(streamOf([
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: finish }] },
  ] as never[]));
}

function openAiTextStream(content: string, finish: "stop" | "length" | "content_filter" = "stop") {
  return mapOpenAIStream(streamOf([
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: finish }] },
  ] as never[]));
}

function anthropicToolStream(id: string, name: string, args: unknown, stopReason: "tool_use" | "max_tokens" | "refusal" = "tool_use") {
  return mapAnthropicStream(streamOf([
    { type: "message_start", message: { id: "msg_" + id, usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } },
    { type: "message_delta", usage: { output_tokens: 20 }, delta: { stop_reason: stopReason } },
    { type: "message_stop" },
  ] as never[]));
}

function responsesToolStream(id: string, name: string, args: unknown) {
  return mapResponsesStream(streamOf([{
    type: "response.completed",
    response: {
      id: "resp_" + id, status: "completed",
      output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args), status: "completed" }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  }] as never[]), "fixture-director");
}

export function mountComicDirector(app: App, pool: Pool, owner: string, accepting?: () => void) {
  const calls: string[] = [];
  const llm: LLMProvider = {
    async *chat(messages, tools) {
      const input = JSON.parse(String(messages.at(-1)!.content));
      if (tools?.[0]?.name === "enhance_script") {
        const segs = (input.segments as Array<{ index: number; original: string }>).map(seg => ({
          index: seg.index,
          suggested: `${seg.original}（AI增强）`,
        }));
        yield* openAiToolStream("fixture-enhance-script", "enhance_script", { segments: segs });
        return;
      }
      if (tools?.[0]?.name === "enhance_clips") {
        const clips = (input.targets as Array<{ index: number; clipId: string; current: { scene: string; durationMs: number } }>).map(t => ({
          index: t.index,
          clipId: t.clipId,
          scene: `${t.current.scene}（增强）`,
          durationMs: t.current.durationMs,
          shots: [
            { framingKey: "wide", movementKey: "push", description: "推进镜头", durationShare: 40 },
            { framingKey: "close_up", movementKey: "fixed", description: "特写镜头", durationShare: 60 },
          ],
          lines: [{ speaker: null, text: "增强旁白", emotionKey: "calm", speed: 1 }],
        }));
        yield* openAiToolStream("fixture-enhance-clips", "enhance_clips", { clips });
        return;
      }
      calls.push(input.source);
      if (input.source === "fixture disconnect") throw new Error("fixture disconnected");
      const characters = [
        { name: "夜访者", description: "来访者" }, { name: "老板", description: "便利店老板" }, { name: "陌生人", description: "新面孔" },
      ];
      if (tools?.[0]?.name === "breakdown_script") {
        assert.equal(tools.length, 1);
        if (input.source === "fixture unauthorized tool") {
          yield* openAiToolStream("refused", "request_generation", {});
          return;
        }
        const value = { clips: [{ scene: "W11 雨夜相逢", durationMs: 4000, shots: input.source === "fixture empty shot" ? [] : ["店主推开窗。"],
          lines: [{ speaker: "老板", text: "营业到凌晨。" }] }], characters };
        if (input.source === "fixture truncated") {
          yield* openAiToolStream("trunc", "breakdown_script", value, "length");
        } else if (input.source === "fixture filtered") {
          yield* anthropicToolStream("filter", "breakdown_script", value, "refusal");
        } else if (input.source === "fixture JSON adapter") {
          yield* openAiTextStream(JSON.stringify(value));
        } else if (input.source === "fixture anthropic tool") {
          yield* anthropicToolStream("anth", "breakdown_script", value);
        } else {
          yield* openAiToolStream("fixture-breakdown", "breakdown_script", value);
        }
        return;
      }
      if (tools?.[0]?.name === "continue_series") {
        assert.equal(tools.length, 1);
        const sequelPayload = { script: directorDraft, characters };
        if (input.source === "fixture sequel truncated") {
          yield* openAiTextStream(JSON.stringify(sequelPayload), "length");
        } else if (input.source === "fixture sequel JSON") {
          yield* openAiTextStream(JSON.stringify(sequelPayload));
        } else {
          yield* responsesToolStream("fixture-sequel", "continue_series", sequelPayload);
        }
        return;
      }
      assert.ok(!tools);
      yield* openAiTextStream(input.source === "fixture invalid" ? "{bad" : JSON.stringify({
        script: directorDraft,
        characters,
      }));
    },
  };
  const repo = new PgComicDirector(pool);
  const extension = createComicDirectorExtension(repo, async caller => {
    assert.equal(caller, owner);
    return { llm, usedModelId: "fixture-director", modelIds: ["fixture-director"] };
  }, true);
  const parser = fileURLToPath(new URL("../../src/workers/knowledge-parser.ts", import.meta.url));
  app.route(COMIC_DRAMA_API_ROOT, createComicDirectorRoutes(repo, new ComicDirector(repo, extension, accepting), parser));
  return { calls, extension };
}

export async function verifyComicDirector(app: App, pool: Pool, episodes: PgComicDramaRepository, owner: string,
  other: string, fixture: ReturnType<typeof mountComicDirector>) {
  const { series } = await episodes.create(owner, { title: "W10 导演接口", styleKey: "webtoon", aspectRatio: "9:16", videoModel: null });
  const original = await episodes.saveScript(owner, series.id, series.revision, "原来的剧本。");
  const route = "/series/" + series.id + "/director";
  async function json<T>(path: string, method = "GET", fields?: unknown, expected = 200, token = "fixture-one") {
    const response = await app.request(COMIC_DRAMA_API_ROOT + path, { method,
      body: fields === undefined ? undefined : JSON.stringify(fields),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value as T;
  }
  const createRole = (name: string, aliases: string[], account = "fixture-one", appearance = "") => json<{ id: string }>("/characters", "POST",
    { name, aliases, roleKey: null, tags: [], age: "", personality: "", appearance }, 201, account);
  const lin = await createRole("林夏", ["夜访者"]);
  await createRole("老板", [], "fixture-one", "圆框眼镜");
  await createRole("老板", ["店主"], "fixture-one", "左脸有疤");
  await createRole("陌生人", [], "fixture-two");
  assert.deepEqual(await json<ComicDirectorState>(route), { conversationId: null, proposals: [] });
  await json(route, "GET", undefined, 404, "fixture-two");
  const upload = (mime: string, bytes: Buffer) => app.request(COMIC_DRAMA_API_ROOT + route + "/import", { method: "POST",
    headers: { Authorization: "Bearer fixture-one", "Content-Type": mime }, body: new Uint8Array(bytes) });
  const txt = await upload("text/plain", Buffer.from("雨夜开店\n下一场"));
  assert.equal(txt.status, 200, await txt.clone().text());
  assert.match((await txt.json() as ComicScriptImport).text, /下一场/);
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("真实 DOCX"), new Paragraph("第二段。")] }] }));
  const extracted = await upload(COMIC_SCRIPT_DOCX, docx);
  assert.equal(extracted.status, 200, await extracted.clone().text());
  assert.equal((await extracted.json() as ComicScriptImport).text, "真实 DOCX\n\n第二段。");
  const long = await upload("text/plain", Buffer.from("长".repeat(20_100)));
  assert.equal(long.status, 200);
  assert.equal((await long.json() as ComicScriptImport).truncated, true);
  assert.equal((await upload(COMIC_SCRIPT_DOCX, Buffer.from("broken"))).status, 400);
  assert.equal((await upload("image/png", Buffer.from("wrong"))).status, 415);
  assert.equal((await upload("text/plain", Buffer.alloc(2 * 1024 * 1024 + 1, 97))).status, 413);

  const input: ComicDirectorInput = { requestId: randomUUID(), expectedRevision: original.seriesRevision, mode: "file", language: "zh", text: "原文件正文" };
  const propose = (fields: ComicDirectorInput, expected = 200, token = "fixture-one") =>
    json<ComicDirectorProposal>(route + "/proposals", "POST", fields, expected, token);
  await propose(input, 404, "fixture-two");
  await propose({ ...input, expectedRevision: original.seriesRevision - 1 }, 409);
  const proposal = await propose(input);
  assert.equal(proposal.status, "ready");
  assert.equal(proposal.original, "原来的剧本。");
  assert.equal((await propose({ ...input, requestId: input.requestId.toUpperCase() })).id, proposal.id);
  await propose({ ...input, text: "same nonce different content" }, 409);
  assert.deepEqual(proposal.proposal?.roles.map(role => role.candidates.length), [1, 2, 0]);
  assert.equal(proposal.proposal?.roles[0].candidates[0].id, lin.id);
  assert.equal((await episodes.get(owner, series.id)).script?.content, "原来的剧本。");
  const turn = { userId: owner, conversationId: proposal.conversationId, metadata: { comicSeriesId: series.id },
    agentId: COMIC_DIRECTOR_AGENT_ID, toolNames: ["generate_video", "generate_image"] };
  assert.deepEqual((await fixture.extension.beginTurn!(turn)).allowedToolNames, []);
  const awaitedBlocked = (await fixture.extension.beginTurn!(turn)).blockedToolNames ?? [];
  assert.ok(turn.toolNames.every(name => (awaitedBlocked).includes(name)));
  await assert.rejects(fixture.extension.beginTurn!({ ...turn, userId: other }));
  await assert.rejects(fixture.extension.beginTurn!({ ...turn, metadata: { comicSeriesId: randomUUID() } }));
  assert.throws(() => fixture.extension.conversationMetadata!({}));

  const changed = await episodes.saveScript(owner, series.id, original.seriesRevision, "另一窗口的剧本");
  const apply = (row: ComicDirectorProposal, expected = 200) =>
    json<ComicDirectorProposal>(route + "/proposals/" + row.id + "/apply", "POST", { expectedRevision: row.baseRevision }, expected);
  await apply(proposal, 409);
  const freshInput = { ...input, expectedRevision: changed.seriesRevision, requestId: randomUUID(), mode: "outline" as const };
  const fresh = await propose(freshInput);
  const applied = await apply(fresh);
  assert.equal(applied.status, "applied");
  assert.equal((await apply(fresh)).appliedRevision, applied.appliedRevision);
  assert.equal((await episodes.get(owner, series.id)).script?.version, 3);
  assert.equal((await episodes.get(owner, series.id)).script?.content, directorDraft);
  assert.deepEqual((await episodes.get(owner, series.id)).cast, []);
  const { rows: [message] } = await pool.query("SELECT metadata FROM messages WHERE conversation_id=$1 AND role='assistant' AND metadata->>'comicDirectorProposalId'=$2",
    [proposal.conversationId, fresh.id]);
  assert.equal(message.metadata.status, "applied");
  const after = { ...freshInput, expectedRevision: applied.appliedRevision! };
  const bad = await propose({ ...after, requestId: randomUUID(), text: "fixture invalid" });
  assert.equal(bad.status, "failed");
  const disconnected = { ...after, requestId: randomUUID(), text: "fixture disconnect" };
  assert.equal((await propose(disconnected)).status, "unknown");
  assert.equal((await propose(disconnected)).status, "unknown");
  assert.equal(fixture.calls.filter(text => text === "fixture disconnect").length, 1);
  const dismissed = await propose({ ...after, requestId: randomUUID(), text: "最后一份提案" });
  assert.equal((await json<ComicDirectorProposal>(route + "/proposals/" + dismissed.id + "/dismiss", "POST", {})).status, "dismissed");
  const state = await json<ComicDirectorState>(route);
  assert.equal(state.conversationId, proposal.conversationId);
  assert.equal(state.proposals.length, 5);

  // Verify AI enhancement (adjacent clips partial adoption + stale conflict) on an isolated episode
  const enhSeries = await episodes.create(owner, { title: "W10 AI 增强", styleKey: "webtoon", aspectRatio: "9:16", videoModel: null });
  const c1 = await episodes.addClip(owner, enhSeries.series.id, enhSeries.series.revision);
  const c2 = await episodes.addClip(owner, enhSeries.series.id, c1.seriesRevision);
  const clipIds = c2.clips.map(c => c.id);
  const enhProp = await json<ComicDirectorProposal>(`/series/${enhSeries.series.id}/director/proposals`, "POST", {
    requestId: randomUUID(), expectedRevision: c2.seriesRevision, language: "zh", action: "enhance",
    enhance: { scope: "clips", clipIds },
  });
  assert.equal(enhProp.status, "ready");
  assert.equal(enhProp.proposal?.clipEnhancements?.length, 2);
  const partialApplied = await json<ComicDirectorProposal>(
    `/series/${enhSeries.series.id}/director/proposals/${enhProp.id}/apply`,
    "POST",
    { expectedRevision: c2.seriesRevision, decision: "enhance", clipItems: [{ index: 1 }] },
  );
  assert.equal(partialApplied.status, "ready");
  const afterPartial = await episodes.get(owner, enhSeries.series.id);
  assert.equal(afterPartial.clips[0]!.draft.scene, "");
  assert.equal(afterPartial.clips[1]!.draft.shots.reduce((s, x) => s + x.durationShare, 0), 100);
  await episodes.saveScript(owner, enhSeries.series.id, afterPartial.series.revision, "并发改稿");
  await json(`/series/${enhSeries.series.id}/director/proposals/${enhProp.id}/apply`, "POST", {
    expectedRevision: partialApplied.appliedRevision!, decision: "enhance", clipItems: [{ index: 0 }],
  }, 409);

  console.log("PASS W10 director PG/HTTP: real TXT/DOCX extraction, owner and session isolation, replay, role ambiguity, revision CAS and persisted decisions");
  return series.id;
}
