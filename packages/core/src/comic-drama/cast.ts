import { z } from "zod";

const id = z.string().uuid().transform(value => value.toLowerCase());
const key = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const revision = z.number().int().min(1).max(2_147_483_647);

const image = z.object({
  id, mime: z.enum(["image/jpeg", "image/png", "image/webp"]), sizeBytes: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(), durationMs: z.null(), hasThumbnail: z.boolean(),
}).strict();
export const comicCastAssetSchema = z.object({
  kind: z.enum(["slot", "expression"]), key, version: z.number().int().positive(), media: image,
}).strict();

export const comicCastSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  characterId: id,
  name: z.string().min(1),
  aliases: z.array(z.string()),
  age: z.string(),
  personality: z.string(),
  appearance: z.string(),
  roleKey: key.nullable(),
  outfitId: id,
  outfitName: z.string().min(1),
  assets: z.array(comicCastAssetSchema),
}).strict();

export const comicClipCastingSchema = z.array(z.object({
  characterId: id, slotKey: key.nullable(), expressionKey: key.nullable(),
  descriptionOnly: z.literal(true).optional(),
}).strict().refine(actor => !actor.descriptionOnly || actor.slotKey === null)).max(32)
  .refine(items => new Set(items.map(item => item.characterId)).size === items.length, "Cast members must be unique");

export const comicCastAddSchema = z.object({ expectedRevision: revision, characterId: id, outfitId: id }).strict();
export const comicCastOutfitSchema = z.object({ expectedRevision: revision, outfitId: id }).strict();
export const comicSequelOptionsSchema = z.object({ inheritCastAndStyle: z.boolean().default(true) }).strict();

export type ComicCastSnapshot = z.infer<typeof comicCastSnapshotSchema>;
export type ComicCastAsset = ComicCastSnapshot["assets"][number];
export type ComicClipCasting = z.infer<typeof comicClipCastingSchema>;
export type ComicSeriesCast = {
  snapshot: ComicCastSnapshot;
  archived: boolean;
  hasUpdates: boolean;
  availableAppearance?: ComicCastAsset;
  originDramaId?: string | null;
  originDramaTitle?: string | null;
};
export type ComicCastChange =
  | { action: "add" | "outfit"; characterId: string; outfitId: string }
  | { action: "sync" | "remove"; characterId: string };

export function comicCastAsset(snapshot: ComicCastSnapshot, kind: ComicCastAsset["kind"], key: string | null): ComicCastAsset | undefined {
  return key ? snapshot.assets.find(asset => asset.kind === kind && asset.key === key) : undefined;
}

export function comicCastDefaultAppearance(snapshot: ComicCastSnapshot) {
  return comicCastAsset(snapshot, "slot", "front") ?? snapshot.assets.find(asset => asset.kind === "slot");
}

export function comicCastReferenceAsset(member: ComicSeriesCast, kind: ComicCastAsset["kind"], key: string) {
  return comicCastAsset(member.snapshot, kind, key)
    ?? (kind === "slot" && member.availableAppearance?.key === key ? member.availableAppearance : undefined);
}

export function fitComicActor(actor: ComicClipCasting[number], snapshot: ComicCastSnapshot): ComicClipCasting[number] {
  return {
    ...actor,
    slotKey: comicCastAsset(snapshot, "slot", actor.slotKey)?.key ?? null,
    expressionKey: comicCastAsset(snapshot, "expression", actor.expressionKey)?.key ?? null,
  };
}
