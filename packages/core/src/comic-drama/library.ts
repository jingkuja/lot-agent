import { z } from "zod";

const id = z.string().uuid().transform(value => value.toLowerCase());
const label = z.string().trim().min(1).max(120);
const key = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const COMIC_MEDIA_PATH = "/api/public/comic-drama-media/";
export const comicMaterialKinds = ["scene", "prop", "sound", "music", "other"] as const;
export const comicMaterialKind = z.enum(comicMaterialKinds);
export type ComicMaterialKind = z.infer<typeof comicMaterialKind>;

export const comicDictionaryDomains = [
  "role", "slot", "expression", "scene", "prop", "sound", "music", "other", "framing", "movement", "style", "emotion",
] as const;
export const comicDictionaryDomain = z.enum(comicDictionaryDomains);
export type ComicDictionaryDomain = z.infer<typeof comicDictionaryDomain>;
export type ComicLabels = { zh: string; en: string; id: string };
export type ComicDictionaryEntry = { key: string; labels: ComicLabels; system: boolean; inactive: boolean };

const labels = z.object({ zh: label, en: label, id: label }).strict();
export const comicDictionaryCreate = z.object({ key, labels }).strict();
export const comicDictionaryUpdate = z.object({ inactive: z.boolean().optional(), labels: labels.optional() }).strict()
  .refine(value => typeof value.inactive === "boolean" || !!value.labels);
export const comicDictionaryOrder = z.object({ keys: z.array(key).max(512).refine(values => new Set(values).size === values.length) }).strict();

function entries(rows: ReadonlyArray<readonly [string, string, string, string]>): readonly ComicDictionaryEntry[] {
  return rows.map(([key, zh, en, id]) => ({ key, labels: { zh, en, id }, inactive: false, system: true }));
}

export const comicSystemDictionary: Record<ComicDictionaryDomain, readonly ComicDictionaryEntry[]> = {
  role: entries([["lead", "主角", "Lead", "Tokoh utama"], ["support", "配角", "Supporting", "Tokoh pendukung"],
    ["antagonist", "反派", "Antagonist", "Antagonis"], ["extra", "路人", "Extra", "Figuran"]]),
  slot: entries([["front", "正面全身", "Front view", "Tampak depan"], ["side", "侧身", "Side view", "Tampak samping"],
    ["back", "背面", "Back view", "Tampak belakang"], ["face", "高清人脸", "Face close-up", "Wajah jarak dekat"],
    ["turnaround", "三视图", "Turnaround", "Tiga sudut"], ["half_body", "半身", "Half body", "Setengah badan"]]),
  expression: entries([["calm", "平静", "Calm", "Tenang"], ["smile", "微笑", "Smile", "Senyum"], ["laugh", "大笑", "Laugh", "Tertawa"],
    ["angry", "愤怒", "Anger", "Marah"], ["sad", "悲伤", "Sadness", "Sedih"], ["surprised", "惊讶", "Surprise", "Terkejut"],
    ["shy", "害羞", "Shy", "Malu"], ["smirk", "冷笑", "Smirk", "Seringai"], ["afraid", "恐惧", "Fear", "Takut"]]),
  scene: entries([["interior", "室内", "Interior", "Dalam ruangan"], ["street", "街道", "Street", "Jalan"],
    ["campus", "校园", "Campus", "Kampus"], ["historic", "古风建筑", "Historic architecture", "Arsitektur bersejarah"],
    ["nature", "自然", "Nature", "Alam"], ["sci_fi", "科幻", "Science fiction", "Fiksi ilmiah"]]),
  prop: entries([["weapon", "武器", "Weapon", "Senjata"], ["vehicle", "交通工具", "Vehicle", "Kendaraan"], ["food", "食物", "Food", "Makanan"],
    ["accessory", "饰品", "Accessory", "Aksesori"], ["electronics", "电子产品", "Electronics", "Elektronik"], ["furniture", "家具", "Furniture", "Furnitur"]]),
  sound: entries([["ambience", "环境", "Ambience", "Suasana"], ["action", "动作", "Action", "Aksi"],
    ["fight", "打斗", "Combat", "Pertarungan"], ["transition", "转场", "Transition", "Transisi"],
    ["ui", "界面提示音", "Interface", "Antarmuka"], ["foley", "拟声", "Foley", "Foley"]]),
  music: entries([["tense", "紧张", "Tense", "Tegang"], ["epic", "热血", "Epic", "Epik"], ["warm", "温馨", "Warm", "Hangat"],
    ["sad", "悲伤", "Sad", "Sedih"], ["comic", "搞笑", "Comic", "Lucu"], ["mystery", "悬疑", "Mystery", "Misteri"],
    ["romance", "甜宠", "Romance", "Romantis"]]),
  other: entries([["general", "其他", "Other", "Lainnya"]]),
  framing: entries([["extreme_wide", "远景", "Extreme wide shot", "Bidikan sangat lebar"], ["wide", "全景", "Wide shot", "Bidikan lebar"],
    ["medium", "中景", "Medium shot", "Bidikan sedang"], ["near", "近景", "Medium close-up", "Jarak sedang dekat"], ["close_up", "特写", "Close-up", "Jarak dekat"]]),
  movement: entries([["fixed", "固定镜头", "Static camera", "Kamera statis"], ["push", "推进", "Push in", "Dorong maju"],
    ["pull", "拉远", "Pull back", "Tarik mundur"], ["pan", "摇镜", "Pan", "Geser kamera"], ["truck", "横移", "Truck", "Gerak menyamping"],
    ["follow", "跟拍", "Follow", "Mengikuti"], ["orbit", "环绕", "Orbit", "Mengorbit"], ["crane", "升降", "Crane", "Naik turun"]]),
  style: entries([["thick_painting", "国漫厚涂", "Painterly comic", "Komik bergaya lukisan"], ["cel_shading", "赛璐璐", "Cel shading", "Gaya cel shading"],
    ["webtoon", "条漫", "Webtoon", "Webtoon"], ["stylized_3d", "3D 卡通", "3D cartoon", "Kartun 3D"],
    ["ink", "水墨", "Ink wash", "Lukisan tinta"], ["pixel", "像素", "Pixel art", "Seni piksel"]]),
  emotion: entries([["calm", "平静", "Calm", "Tenang"], ["happy", "高兴", "Happy", "Senang"],
    ["sad", "悲伤", "Sad", "Sedih"], ["angry", "生气", "Angry", "Marah"], ["excited", "激动", "Excited", "Bersemangat"],
    ["whisper", "低语", "Whisper", "Berbisik"], ["crying", "哭腔", "Crying", "Menangis"],
    ["sarcastic", "嘲讽", "Sarcastic", "Sarkastis"], ["gentle", "温柔", "Gentle", "Lembut"]]),
};

const words = z.array(label).max(20);
export const comicCharacterInput = z.object({
  name: label, aliases: words, tags: words, roleKey: key.nullable(),
  dramaId: id.nullable().optional(),
  age: z.string().trim().max(120), personality: z.string().trim().max(2000), appearance: z.string().trim().max(2000),
}).strict();
export const comicOutfitInput = z.object({ name: label }).strict();
export const comicOutfitOrder = z.object({
  outfitIds: z.array(id).max(100).refine(values => new Set(values).size === values.length),
}).strict();
export const comicCharacterUpload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slot"), key, outfitId: id }).strict(),
  z.object({ kind: z.literal("expression"), key }).strict(),
]);
export const comicMaterialInput = z.object({
  kind: comicMaterialKind, name: label, categoryKey: key.nullable(), tags: words,
}).strict();
export const comicMaterialUpdate = z.object({
  name: label, categoryKey: key.nullable(), tags: words,
}).strict();
export const comicSaveMediaAsMaterial = z.object({
  mediaId: id,
  material: comicMaterialInput,
}).strict();
export const comicUserPreferencesSchema = z.object({
  defaultVideoModel: z.string().trim().min(1).max(128).nullable().optional(),
  defaultImageModel: z.string().trim().min(1).max(128).nullable().optional(),
}).strip();
export const comicStyleReferenceBindSchema = z.object({ mediaId: id }).strict();
export const comicLibrarySearch = z.object({
  query: z.string().trim().max(120).optional(), archived: z.enum(["true", "false"]).default("false"),
  page: z.coerce.number().int().min(1).max(10000).default(1),
}).strict();
export const comicCharacterSearch = comicLibrarySearch.extend({
  dramaId: z.union([id, z.literal("unassigned")]).optional(),
}).strict();
export const comicMaterialSearch = comicLibrarySearch.extend({
  kind: comicMaterialKind.optional(), mime: z.enum(["image", "audio", "video"]).optional(),
}).strict();

export type ComicCharacterInput = z.infer<typeof comicCharacterInput>;
export type ComicCharacterUpload = z.infer<typeof comicCharacterUpload>;
export type ComicMaterialInput = z.infer<typeof comicMaterialInput>;
export type ComicMaterialUpdate = z.infer<typeof comicMaterialUpdate>;
export type ComicSaveMediaAsMaterial = z.infer<typeof comicSaveMediaAsMaterial>;
export type ComicUserPreferences = z.infer<typeof comicUserPreferencesSchema>;
export type ComicLibrarySearch = z.infer<typeof comicLibrarySearch>;
export type ComicCharacterSearch = z.infer<typeof comicCharacterSearch>;
export type ComicMaterialSearch = z.infer<typeof comicMaterialSearch>;
export type ComicDictionaryUpdate = z.infer<typeof comicDictionaryUpdate>;
export type ComicLibraryPage<T> = { entries: T[]; more: boolean };
export type ComicMedia = {
  id: string; mime: string; sizeBytes: number; width: number | null; height: number | null; durationMs: number | null; hasThumbnail: boolean;
};
export type ComicMediaLinks = { url: string; thumbnailUrl: string | null };
export type ComicMediaVersion = { version: number; media: ComicMedia };
export type ComicCharacterAsset = { kind: "slot" | "expression"; key: string; outfitId: string | null } & ComicMediaVersion;
export type ComicOutfit = { id: string; name: string; sort?: number };
export type ComicCharacter = ComicCharacterInput & {
  id: string; archived: boolean; cover: ComicMedia | null;
  dramaId?: string | null; dramaTitle?: string | null;
};
export type ComicCharacterDetail = ComicCharacter & { outfits: ComicOutfit[]; assets: ComicCharacterAsset[] };
export type ComicMaterial = ComicMaterialInput & { id: string; archived: boolean } & ComicMediaVersion;
export type ComicStylePreset = { styleKey: string; mediaId: string; media: ComicMedia; updatedAt: string };
export type ComicUserSettings = { preferences: ComicUserPreferences; stylePresets: ComicStylePreset[] };

export interface ComicDictionaryRepository {
  dictionary(owner: string, domain: ComicDictionaryDomain): Promise<ComicDictionaryEntry[]>;
  addDictionary(owner: string, domain: ComicDictionaryDomain, key: string, labels: ComicLabels): Promise<ComicDictionaryEntry[]>;
  editDictionary(owner: string, domain: ComicDictionaryDomain, key: string, input: ComicDictionaryUpdate): Promise<ComicDictionaryEntry[]>;
  sortDictionary(owner: string, domain: ComicDictionaryDomain, keys: string[]): Promise<ComicDictionaryEntry[]>;
}

export type StoredComicMedia = ComicMedia & { owner: string; storageKey: string; thumbnailKey: string | null };

export interface ComicLibraryRepository {
  media(owner: string, id: string): Promise<StoredComicMedia | undefined>;
  file(key: string): Promise<{ id: string; owner: string } | undefined>;
  listCharacters(owner: string, input: ComicCharacterSearch): Promise<ComicLibraryPage<ComicCharacter>>;
  getCharacter(owner: string, id: string): Promise<ComicCharacterDetail>;
  createCharacter(owner: string, input: ComicCharacterInput): Promise<string>;
  editCharacter(owner: string, id: string, input: ComicCharacterInput): Promise<void>;
  archiveCharacter(owner: string, id: string): Promise<void>;
  addOutfit(owner: string, id: string, name: string): Promise<ComicOutfit>;
  renameOutfit?(owner: string, characterId: string, outfitId: string, name: string): Promise<ComicOutfit>;
  reorderOutfits?(owner: string, characterId: string, outfitIds: string[]): Promise<ComicOutfit[]>;
  deleteOutfit?(owner: string, characterId: string, outfitId: string): Promise<void>;
  validateCharacterAsset(owner: string, id: string, input: ComicCharacterUpload): Promise<void>;
  addCharacterAsset(owner: string, id: string, input: ComicCharacterUpload, media: StoredComicMedia): Promise<number>;
  deleteCharacterAsset?(owner: string, id: string, input: ComicCharacterUpload): Promise<void>;
  characterVersions(owner: string, id: string, input: ComicCharacterUpload): Promise<ComicMediaVersion[]>;
  listMaterials(owner: string, input: ComicMaterialSearch): Promise<ComicLibraryPage<ComicMaterial>>;
  materialInput(owner: string, id: string): Promise<ComicMaterialInput>;
  addMaterial(owner: string, input: ComicMaterialInput, media: StoredComicMedia): Promise<string>;
  addMaterialFromMedia?(owner: string, input: ComicMaterialInput, mediaId: string): Promise<string>;
  editMaterial?(owner: string, id: string, input: ComicMaterialUpdate): Promise<void>;
  replaceMaterial(owner: string, id: string, media: StoredComicMedia): Promise<number>;
  materialVersions(owner: string, id: string): Promise<ComicMediaVersion[]>;
  archiveMaterial(owner: string, id: string): Promise<void>;
  unarchiveMaterial?(owner: string, id: string): Promise<void>;
  deleteMaterial?(owner: string, id: string): Promise<void>;
}
