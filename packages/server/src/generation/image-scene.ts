/**
 * E-commerce image scenes (白底图 / 主副图 / 产品套图). Before a paid image is
 * submitted, a cheap text model checks that the request fits the chosen scene
 * and rewrites it into one professional prompt per image. 自由创作 ("free")
 * skips this step and sends the user's text unchanged.
 */

export const IMAGE_SCENES = ["free", "white_background", "main_images", "product_set", "product_scene"] as const;
export type ImageScene = typeof IMAGE_SCENES[number];
export type GuidedImageScene = Exclude<ImageScene, "free">;

export function parseImageScene(value: unknown): ImageScene | null {
  if (value === undefined || value === null || value === "") return "free";
  return IMAGE_SCENES.includes(value as ImageScene) ? value as ImageScene : null;
}

/** Scenes that only work on the user's own product photo: without a reference image nothing is sent. */
export function imageSceneNeedsReference(scene: ImageScene): boolean {
  return scene === "product_scene";
}

/** Scenes whose images each play a different role, so every image gets its own prompt. */
export function imageSceneUsesSet(scene: ImageScene): boolean {
  return scene === "main_images" || scene === "product_set";
}

const SCENE_BRIEFS: Record<GuidedImageScene, { name: string; fits: string; style: string; roles?: string[] }> = {
  white_background: {
    name: "white-background product image (白底图)",
    fits: "a single product or a small product bundle shown on its own, as a marketplace listing photo",
    style: [
      "Pure white seamless background (#FFFFFF) edge to edge, no gradient, no props, no scene, no text, no watermark, no border.",
      "The product centered, filling about 80-85% of the frame, shot as a professional studio packshot.",
      "Soft, even softbox lighting, accurate true-to-life color and material, crisp clean edges,",
      "and only a faint natural contact shadow under the product. Every image is the same product in the same white-background style.",
    ].join(" "),
  },
  product_scene: {
    name: "product photo placed in a new scene (产品图换场景)",
    fits: "the user's own product photo, to be shown in a new background, setting or lifestyle scene",
    style: [
      "Photorealistic commercial product photography. The product is the one in the reference image, unchanged; only the background",
      "and surroundings are new. Blend it in naturally: matching perspective and scale, consistent light direction and color temperature,",
      "realistic contact shadows and reflections. Props and setting support the product and never cover or outshine it.",
      "No text, logo or watermark unless the user asks for it.",
    ].join(" "),
  },
  main_images: {
    name: "marketplace main and secondary images (主副图)",
    fits: "a product to be shown in the image carousel of a marketplace listing",
    style: [
      "Clean, premium commercial product photography for a marketplace listing carousel.",
      "The same product, colors and visual style in every image. Keep text minimal: no text at all unless the user asks for it.",
    ].join(" "),
    roles: [
      "Main image: the hero shot that wins the click. The product large and centered on a clean light or softly colored background "
        + "that suits it, flattering studio light, strong first-glance appeal.",
      "Secondary image: the product from another angle (side, back or three-quarter view) on a matching clean background.",
      "Secondary image: a close-up of the most important detail, material or craftsmanship, sharp macro-style focus.",
      "Secondary image: the product in a realistic lifestyle or usage scene that shows who it is for, natural light.",
    ],
  },
  product_set: {
    name: "product image set (产品套图)",
    fits: "a product to be presented with a coordinated set of marketing images",
    style: [
      "A coordinated e-commerce image set with one consistent color palette, lighting and design language.",
      "Short headline text may be rendered in the image; keep every text element short, large and legible.",
    ].join(" "),
    roles: [
      "Cover image: the product as the hero with one short headline stating its core benefit, polished commercial layout.",
      "Selling-point image: the product with two or three key benefits, each as a short label with a simple icon, clean infographic layout.",
      "Usage-scene image: the product in a realistic scene where it is used, showing the experience it offers.",
      "Detail image: a close-up of material, structure or craftsmanship, optionally with one short label naming the detail.",
    ],
  },
};

export function imageSceneRoleCount(scene: GuidedImageScene, count: number): number {
  const roles = SCENE_BRIEFS[scene].roles;
  return roles ? Math.min(count, roles.length) : 1;
}

/** System prompt for the scene check and rewrite. Model-facing text stays English; replies to the user follow their language. */
export function imageSceneSystemPrompt(scene: GuidedImageScene, count: number, referenceImages: number): string {
  const brief = SCENE_BRIEFS[scene];
  const prompts = brief.roles ? imageSceneRoleCount(scene, count) : 1;
  const references = referenceImages > 0
    ? `The user attached ${referenceImages} reference image(s), which you cannot see. Treat them as the user's actual product: every prompt must `
      + "say to keep the product from the reference image exactly as it is (shape, color, proportions, logo, printed text and material) "
      + "and change only the background, angle, scene or layout."
    : "No reference image is attached, so describe the product concretely from the user's text.";
  const roles = brief.roles
    ? `Write exactly ${prompts} prompt(s), one per image, in this order:\n${brief.roles.slice(0, prompts).map((role, i) => `${i + 1}. ${role}`).join("\n")}`
    : "Write exactly 1 prompt.";
  return [
    `You prepare prompts for an image model that makes a ${brief.name}. The scene is meant for ${brief.fits}.`,
    "",
    "Step 1: decide whether the user's request fits this scene. Be lenient: users write short, loose or messy requests,",
    "and a product name alone, a vague request, or a request that relies on the reference image all fit.",
    "Only reject when the request clearly asks for something this scene cannot be, such as a landscape, a portrait of a person,",
    "a meme, an illustration or poster with no product, or (for a white-background image) a busy scene or colored background.",
    "",
    "Step 2: if it fits, rewrite it into professional image prompts.",
    `Scene style: ${brief.style}`,
    references,
    roles,
    "Each prompt is sent to the image model on its own, so make each one self-contained: restate the product and the shared style in every prompt.",
    "Write prompts in English, at most 900 characters each. Any text to appear inside an image must be in the language of the user's request,",
    "quoted exactly. Keep what the user asked for (product, colors, selling points, scene, audience). Never invent prices, discounts, sales numbers,",
    "awards, certifications or brand names the user did not give.",
    "Proper names stay in the user's own words: copy every brand name, product or series name, model number, shop name, character name,",
    "place name and slogan from the request into the English prompt exactly as the user wrote it, in its original language and script",
    "(for example 小米, 华为 Mate 70, 老干妈, Indomie, Kopi Kenangan). Do not translate, transliterate, romanize or replace them with an",
    "English equivalent; only the surrounding description is in English.",
    "",
    "Reply with JSON only, no code fence and no text before or after it. Inside a prompt, put any text that appears in the image",
    "in single quotes ('…'), never double quotes, so the JSON stays valid:",
    '{"fits": true, "prompts": ["..."]}',
    "or, when the request does not fit:",
    '{"fits": false, "message": "..."}',
    "The message is written in the language of the user's request, at most 120 characters: say briefly why the request does not fit this scene",
    "and give one example request that would.",
  ].join("\n");
}

export type ImageScenePlan = { fits: true; prompts: string[] } | { fits: false; message: string };

/** Why a reply could not be used: empty, not JSON, JSON of the wrong shape, or fewer prompts than images. */
export type ImageSceneFailure = "empty_reply" | "not_json" | "bad_shape" | "few_prompts";

export class ImageSceneError extends Error {
  constructor(readonly reason: ImageSceneFailure, readonly replyLength: number) {
    super(`invalid image scene plan (${reason})`);
    this.name = "ImageSceneError";
  }
}

/** The reply as JSON. Models sometimes wrap it in a code fence or a sentence, so fall back to the outermost braces. */
function replyJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next reading.
    }
  }
  throw new ImageSceneError(trimmed ? "not_json" : "empty_reply", trimmed.length);
}

/** Parse the model's JSON. Anything malformed is an error: no paid image is sent from a broken plan. */
export function parseImageScenePlan(text: string, expected: number): ImageScenePlan {
  const plan = replyJson(text) as { fits?: unknown; prompts?: unknown; message?: unknown };
  const fail = (reason: ImageSceneFailure) => new ImageSceneError(reason, text.trim().length);
  if (!plan || typeof plan !== "object") throw fail("bad_shape");
  if (plan.fits === false) {
    const message = typeof plan.message === "string" ? plan.message.trim().slice(0, 300) : "";
    if (!message) throw fail("bad_shape");
    return { fits: false, message };
  }
  if (plan.fits !== true || !Array.isArray(plan.prompts)) throw fail("bad_shape");
  const prompts = plan.prompts
    .filter((prompt): prompt is string => typeof prompt === "string" && !!prompt.trim())
    .map((prompt) => prompt.trim().slice(0, 1500));
  if (prompts.length < expected) throw fail("few_prompts");
  return { fits: true, prompts: prompts.slice(0, expected) };
}

export interface PlanImageSceneInput {
  scene: GuidedImageScene;
  prompt: string;
  /** Requested image count (1–4). */
  count: number;
  referenceImages: number;
}

/** Check and rewrite one request. `complete` runs the text model and returns its raw reply. */
export async function planImageScene(
  input: PlanImageSceneInput,
  complete: (system: string, user: string) => Promise<string>
): Promise<ImageScenePlan> {
  const expected = SCENE_BRIEFS[input.scene].roles ? imageSceneRoleCount(input.scene, input.count) : 1;
  const system = imageSceneSystemPrompt(input.scene, input.count, input.referenceImages);
  return parseImageScenePlan(await complete(system, input.prompt), expected);
}
