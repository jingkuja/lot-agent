import type { ComicSeriesCast } from "./cast.js";
import { comicVideoModel, comicVideoProfile } from "./models.js";
import type { ComicDramaClip, ComicDramaDetail, ComicDramaSeries } from "./index.js";

/** Matches MAX_IMAGE_EDIT_REFERENCES (5) without importing Node-only provider modules into browser bundles. */
export const COMIC_KEYFRAME_MAX_REFERENCES = 5;

export type ComicClipCheckIssue =
  | {
    code: "SPEAKER_NOT_IN_CAST";
    clipId: string;
    clipOrdinal: number;
    speaker: string;
    suggestedCharacterId?: string;
  }
  | {
    code: "REFERENCE_LIMIT_EXCEEDED";
    clipId: string;
    clipOrdinal: number;
    count: number;
    limit: number;
    modelId: string | null;
  }
  | {
    code: "DIALOGUE_TOO_LONG";
    clipId: string;
    clipOrdinal: number;
    estimatedMs: number;
    durationMs: number;
  }
  | {
    code: "CAST_UPDATED_IN_LIBRARY";
    clipId: string;
    clipOrdinal: number;
    characterId: string;
    characterName: string;
    reason: "library_updated" | "generated_outdated";
  }
  | {
    code: "INVALID_MATERIAL_REFERENCE";
    clipId: string;
    clipOrdinal: number;
    role: "scene" | "prop" | "sfx";
    materialId: string;
    mediaId: string;
    name?: string;
    reason: "MISSING" | "ARCHIVED" | "WRONG_KIND" | "OUTDATED_VERSION";
  };

/** Loose normalization for character name / alias matching across CJK & Latin punctuation. */
export function normalizeComicName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s·•・,，。、!！?？:：;；"'“”‘’()（）\[\]【】《》\-—_]/g, "");
}

/** Match a speaker or proposed character name against a list of candidates with exact + loose alias matching. */
export function matchComicCharacters<T extends { id: string; name: string; aliases?: readonly string[] }>(
  query: string,
  candidates: readonly T[],
): T[] {
  const exact = query.normalize("NFKC").trim().toLowerCase();
  const loose = normalizeComicName(query);
  if (!loose) return [];
  const strictMatches: T[] = [];
  const looseMatches: T[] = [];
  const partialMatches: T[] = [];
  for (const item of candidates) {
    const names = [item.name, ...(item.aliases ?? [])];
    if (names.some(n => n.normalize("NFKC").trim().toLowerCase() === exact)) {
      strictMatches.push(item);
      continue;
    }
    const normalized = names.map(normalizeComicName).filter(Boolean);
    if (normalized.some(n => n === loose)) {
      looseMatches.push(item);
      continue;
    }
    if (loose.length >= 2 && normalized.some(n => n.length >= 2 && (n.includes(loose) || loose.includes(n)))) {
      partialMatches.push(item);
    }
  }
  if (strictMatches.length) return strictMatches;
  if (looseMatches.length) return looseMatches;
  return partialMatches;
}

/** Estimate spoken duration in ms for a clip's dialogue lines (supports CJK + Latin languages and speed). */
export function estimateComicDialogueMs(lines: readonly ComicDramaClip["draft"]["lines"][number][]): number {
  let totalMs = 0;
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const speed = line.speed > 0 ? line.speed : 1;
    const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
    const nonCjk = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, " ").trim();
    const latinWords = nonCjk ? nonCjk.split(/\s+/).filter(Boolean).length : 0;
    const sec = cjk / 4.2 + latinWords / 2.6;
    const lineMs = Math.max(400, Math.round((sec * 1000) / speed));
    totalMs += lineMs + 200;
  }
  return totalMs > 0 ? totalMs - 200 : 0;
}

/** Count references that a clip will send to generation (cast slots/expressions + persisted scene/props + optional style/keyframe). */
export function countComicClipReferences(
  clip: ComicDramaClip,
  opts?: { hasStyleRef?: boolean; includeKeyframe?: boolean },
): number {
  let count = 0;
  for (const actor of clip.draft.cast ?? []) {
    if (actor.slotKey) count += 1;
    if (actor.expressionKey) count += 1;
  }
  if (clip.draft.sceneRef) count += 1;
  count += clip.draft.propRefs?.length ?? 0;
  if (opts?.hasStyleRef) count += 1;
  if (opts?.includeKeyframe && clip.progress?.keyframeMediaId) count += 1;
  return count;
}

/** Run the 4 product-spec §4.2 / §5.3 quality checks on a single clip. */
export function checkComicClipIssues(
  series: Pick<ComicDramaSeries, "videoModel">,
  clip: ComicDramaClip,
  cast: readonly ComicSeriesCast[],
  opts?: { hasStyleRef?: boolean },
): ComicClipCheckIssue[] {
  const issues: ComicClipCheckIssue[] = [];
  const castInClip = new Set((clip.draft.cast ?? []).map(actor => actor.characterId));
  const castSearchList = cast.map(entry => ({
    id: entry.snapshot.characterId,
    name: entry.snapshot.name,
    aliases: entry.snapshot.aliases,
  }));

  // 1. Named speaker missing from clip cast
  const seenMissingSpeakers = new Set<string>();
  for (const line of clip.draft.lines) {
    const speaker = line.speaker?.trim();
    if (!speaker || !line.text.trim()) continue;
    const key = normalizeComicName(speaker);
    if (!key || seenMissingSpeakers.has(key)) continue;
    if (["旁白", "narrator", "narasi", "画外音", "voiceover"].includes(key)) continue;
    const matched = matchComicCharacters(speaker, castSearchList);
    const inClip = matched.some(item => castInClip.has(item.id));
    if (!inClip) {
      seenMissingSpeakers.add(key);
      issues.push({
        code: "SPEAKER_NOT_IN_CAST",
        clipId: clip.id,
        clipOrdinal: clip.ordinal,
        speaker,
        ...(matched.length === 1 ? { suggestedCharacterId: matched[0].id } : {}),
      });
    }
  }

  // 2. Reference image count exceeds selected video model limit (or default image-edit limit)
  const profile = comicVideoProfile(series.videoModel);
  const limit = profile ? profile.referenceImages.total : COMIC_KEYFRAME_MAX_REFERENCES;
  const count = countComicClipReferences(clip, {
    hasStyleRef: opts?.hasStyleRef,
    includeKeyframe: !!profile && !comicVideoModel(series.videoModel) && !!clip.progress?.keyframeApproved,
  });
  if (count > limit) {
    issues.push({
      code: "REFERENCE_LIMIT_EXCEEDED",
      clipId: clip.id,
      clipOrdinal: clip.ordinal,
      count,
      limit,
      modelId: series.videoModel,
    });
  }

  // 3. Estimated dialogue duration exceeds clip durationMs
  const estimatedMs = estimateComicDialogueMs(clip.draft.lines);
  if (estimatedMs > clip.draft.durationMs) {
    issues.push({
      code: "DIALOGUE_TOO_LONG",
      clipId: clip.id,
      clipOrdinal: clip.ordinal,
      estimatedMs,
      durationMs: clip.draft.durationMs,
    });
  }

  // 4. Cast member has library updates or generated output predates latest cast snapshot
  for (const actor of clip.draft.cast ?? []) {
    const member = cast.find(entry => entry.snapshot.characterId === actor.characterId);
    if (!member) continue;
    if (member.hasUpdates) {
      issues.push({
        code: "CAST_UPDATED_IN_LIBRARY",
        clipId: clip.id,
        clipOrdinal: clip.ordinal,
        characterId: member.snapshot.characterId,
        characterName: member.snapshot.name,
        reason: "library_updated",
      });
    } else if (clip.progress?.castSnapshotStale) {
      issues.push({
        code: "CAST_UPDATED_IN_LIBRARY",
        clipId: clip.id,
        clipOrdinal: clip.ordinal,
        characterId: member.snapshot.characterId,
        characterName: member.snapshot.name,
        reason: "generated_outdated",
      });
    }
  }

  // 5. Scene / prop / sound material reference missing, archived, wrong kind or outdated
  for (const invalid of clip.progress?.invalidMaterialRefs ?? []) {
    issues.push({
      code: "INVALID_MATERIAL_REFERENCE",
      clipId: clip.id,
      clipOrdinal: clip.ordinal,
      role: invalid.role,
      materialId: invalid.materialId,
      mediaId: invalid.mediaId,
      ...(invalid.name ? { name: invalid.name } : {}),
      reason: invalid.reason,
    });
  }

  return issues;
}

/** Run all 4 spec checks across every clip in an episode. */
export function checkComicSeriesIssues(
  detail: Pick<ComicDramaDetail, "series" | "clips" | "cast">,
  opts?: { hasStyleRef?: boolean },
): ComicClipCheckIssue[] {
  return detail.clips.flatMap(clip => checkComicClipIssues(detail.series, clip, detail.cast, opts));
}
