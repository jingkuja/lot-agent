import { afterEach, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { renderPptPreview } from "./preview.js";

afterEach(() => vi.unstubAllEnvs());
it("skips disabled, excessive and invalid previews without affecting export", async () => {
  vi.stubEnv("PPT_PREVIEW", "0");
  expect(await renderPptPreview(Buffer.from("not a pptx"), 1)).toBeNull();
  vi.stubEnv("PPT_PREVIEW", "1");
  expect(await renderPptPreview(Buffer.from("not a pptx"), 41)).toBeNull();
  expect(await renderPptPreview(Buffer.from("not a pptx"), 1)).toBeNull();
});
it("does not feed externally linked or active template content to a converter", async () => {
  const zip = new JSZip();
  zip.file("ppt/_rels/presentation.xml.rels", '<Relationship TargetMode="External" Target="http://127.0.0.1/secret"/>');
  expect(await renderPptPreview(await zip.generateAsync({ type: "nodebuffer" }), 1)).toBeNull();
  zip.remove("ppt/_rels/presentation.xml.rels");
  zip.file("ppt/vbaProject.bin", "macro");
  expect(await renderPptPreview(await zip.generateAsync({ type: "nodebuffer" }), 1)).toBeNull();
});
it("propagates cancellation instead of claiming preview unavailability", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(renderPptPreview(Buffer.from("test"), 1, controller.signal)).rejects.toThrow();
});
