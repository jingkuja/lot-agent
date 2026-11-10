import { describe, expect, it, vi } from "vitest";
import { imageSceneSystemPrompt, ImageSceneError, parseImageScene, parseImageScenePlan, planImageScene } from "./image-scene.js";

describe("image scenes", () => {
  it("defaults to free creation and rejects unknown scenes", () => {
    expect(parseImageScene(undefined)).toBe("free");
    expect(parseImageScene("white_background")).toBe("white_background");
    expect(parseImageScene("poster")).toBeNull();
  });

  it("asks for one prompt per set role, and one prompt for white background", () => {
    expect(imageSceneSystemPrompt("product_set", 3, 0)).toContain("Write exactly 3 prompt(s)");
    expect(imageSceneSystemPrompt("main_images", 9, 1)).toContain("Write exactly 4 prompt(s)");
    const white = imageSceneSystemPrompt("white_background", 4, 2);
    expect(white).toContain("Write exactly 1 prompt.");
    expect(white).toContain("2 reference image(s)");
  });

  it("tells the model to keep proper names in the user's own language and script", () => {
    const system = imageSceneSystemPrompt("product_set", 4, 0);
    expect(system).toContain("exactly as the user wrote it, in its original language and script");
    expect(system).toContain("Do not translate, transliterate, romanize");
  });

  it("returns the user-facing message when the request does not fit", async () => {
    const complete = vi.fn(async () => '{"fits": false, "message": "这是风景画，不是商品白底图。可以试试：红色运动鞋白底图"}');
    const plan = await planImageScene({ scene: "white_background", prompt: "夕阳下的海边", count: 1, referenceImages: 0 }, complete);
    expect(plan).toEqual({ fits: false, message: "这是风景画，不是商品白底图。可以试试：红色运动鞋白底图" });
  });

  it("keeps exactly the prompts the set needs, tolerating a code fence", () => {
    const text = '```json\n{"fits": true, "prompts": ["a", "b", "c"]}\n```';
    expect(parseImageScenePlan(text, 2)).toEqual({ fits: true, prompts: ["a", "b"] });
  });

  it("treats malformed or short plans as errors so no image is paid for", () => {
    expect(() => parseImageScenePlan("not json", 1)).toThrow(ImageSceneError);
    expect(() => parseImageScenePlan('{"fits": true, "prompts": ["only one"]}', 2)).toThrow(ImageSceneError);
    expect(() => parseImageScenePlan('{"fits": false}', 1)).toThrow(ImageSceneError);
  });

  it("reads a plan the model wrapped in a sentence or a fence, and says why a reply is unusable", () => {
    const wrapped = 'Here is the plan:\n```json\n{"fits": true, "prompts": ["main", "side"]}\n```\nHope this helps.';
    expect(parseImageScenePlan(wrapped, 2)).toEqual({ fits: true, prompts: ["main", "side"] });
    const reason = (text: string, expected: number) => {
      try { parseImageScenePlan(text, expected); } catch (error) { return (error as ImageSceneError).reason; }
      return "parsed";
    };
    expect(reason("", 1)).toBe("empty_reply");
    expect(reason('{"fits": true, "prompts": ["a "broken" quote"]}', 1)).toBe("not_json");
    expect(reason('{"fits": true}', 1)).toBe("bad_shape");
    expect(reason('{"fits": true, "prompts": ["only one"]}', 2)).toBe("few_prompts");
  });
});
