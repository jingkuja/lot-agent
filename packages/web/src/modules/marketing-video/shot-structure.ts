import { MarketingShotSchema, marketingSpeechMinimumSeconds, speechUnits, type MarketingShot } from "@lot-agent/core/marketing-video";

// Structure edits of a storyboard (assessment M03). Each returns the new board, or null when the
// edit does not apply, so the editor can disable its button with the same call.

/** Most shots a board holds (`MarketingStoryboardSchema`) and the shortest shot a model accepts. */
export const MARKETING_MAX_SHOTS = 15;
export const MARKETING_MIN_SHOT_SECONDS = 4;

const blank = (): MarketingShot => ({ durationSec: MARKETING_MIN_SHOT_SECONDS, script: "", visual: "", action: "", camera: "" });

/** An empty shot after `index`, or first when `index` is -1. */
export function insertShot(shots: MarketingShot[], index: number): MarketingShot[] | null {
  if (shots.length >= MARKETING_MAX_SHOTS) return null;
  return [...shots.slice(0, index + 1), blank(), ...shots.slice(index + 1)];
}

export function removeShot(shots: MarketingShot[], index: number): MarketingShot[] | null {
  return shots.length > 1 && shots[index] ? shots.filter((_, i) => i !== index) : null;
}

/** Swap a shot with the one before (-1) or after (1). */
export function moveShot(shots: MarketingShot[], index: number, by: -1 | 1): MarketingShot[] | null {
  const other = index + by;
  if (!shots[index] || !shots[other]) return null;
  const next = [...shots];
  [next[index], next[other]] = [next[other], next[index]];
  return next;
}

export function setShotDuration(shots: MarketingShot[], index: number, durationSec: number): MarketingShot[] {
  return shots.map((shot, i) => i === index ? { ...shot, durationSec } : shot);
}

/** Two shots from one: the line splits at the phrase boundary nearest its middle, the time by
 * how much each part says, and both keep the picture, action and camera to edit. */
export function splitShot(shots: MarketingShot[], index: number): MarketingShot[] | null {
  const shot = shots[index];
  if (!shot || shots.length >= MARKETING_MAX_SHOTS) return null;
  const chars = Array.from(shot.script.trim());
  const middle = Math.round(chars.length / 2);
  const boundaries = chars.map((_, n) => n).filter(n => n > 0 && n < chars.length && /[。！？.!?；;，,\s]/u.test(chars[n - 1]));
  const at = boundaries.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0] ?? middle;
  const parts = [chars.slice(0, at).join("").trim(), chars.slice(at).join("").trim()];
  const units = parts.map(speechUnits);
  if (units.some(n => !n)) return null;
  const first = Math.max(MARKETING_MIN_SHOT_SECONDS, Math.round(shot.durationSec * units[0] / (units[0] + units[1])));
  const second = Math.max(MARKETING_MIN_SHOT_SECONDS, shot.durationSec - first);
  return [...shots.slice(0, index), { ...shot, script: parts[0], durationSec: first }, { ...shot, script: parts[1], durationSec: second },
    ...shots.slice(index + 1)];
}

/** A shot joined with the next one: each field keeps both parts, one per line, and the time adds
 * up to the longest shot allowed. Refused when the joined line or text would not fit one shot. */
export function mergeShots(shots: MarketingShot[], index: number, maxShot: number): MarketingShot[] | null {
  const [a, b] = [shots[index], shots[index + 1]];
  if (!a || !b) return null;
  const join = (x: string, y: string) => [x.trim(), y.trim()].filter(Boolean).join("\n");
  const joined = MarketingShotSchema.safeParse({ durationSec: Math.min(maxShot, a.durationSec + b.durationSec), script: join(a.script, b.script),
    visual: join(a.visual, b.visual), action: join(a.action, b.action), camera: join(a.camera, b.camera) });
  if (!joined.success || marketingSpeechMinimumSeconds(joined.data.script) > maxShot) return null;
  return [...shots.slice(0, index), joined.data, ...shots.slice(index + 2)];
}

/** Shots of `shots` whose line has no take yet, when `takes` lists the lines that have one. */
export function shotsWithoutTake(shots: MarketingShot[], takes: ReadonlySet<string>): number[] {
  return shots.flatMap((shot, index) => shot.script.trim() && !takes.has(shot.script) ? [index] : []);
}
