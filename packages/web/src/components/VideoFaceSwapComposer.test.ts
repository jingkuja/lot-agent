// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel.js";
import { VIDEO_FACE_SWAP_MODEL } from "../lib/model-filter.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderVideoPanel(onSend = vi.fn(async () => "accepted" as const)) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(ChatPanel, {
      messages: [],
      onSend,
      onStop: vi.fn(),
      isStreaming: false,
      activeConversationId: null,
      agent: {
        id: "video",
        name: "视频生成",
        type: "video",
        description: "生成短视频",
        defaultModelId: "doubao-seedance-2-0",
        toolNames: [],
      },
      modelCatalog: {
        llm: [],
        image: [],
        video: [{ id: "doubao-seedance-2-0", type: "video", provider: "openai-video" }],
      },
      selectedModel: "doubao-seedance-2-0",
      onModelChange: vi.fn(),
    }));
  });
  return { onSend };
}

function setFileInput(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("video mode tabs and face-swap composer", () => {
  it("removes the Seedance 2.5 banner and defaults to 快速生成 above the input box", () => {
    renderVideoPanel();
    expect(document.querySelector(".input-seedance-hint")).toBeNull();
    expect(document.body.textContent).not.toContain("Seedance 2.5");
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["快速生成", "视频换脸"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(document.querySelector("textarea")).not.toBeNull();
    expect(document.querySelector(".face-swap-photo-hint")).toBeNull();
  });

  it("switches to 视频换脸 with two required inputs and 默认(720p) / 质量(1080p) setting", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { onSend } = renderVideoPanel();

    const faceSwapTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.trim() === "视频换脸",
    )!;
    act(() => faceSwapTab.click());

    expect(document.querySelector("textarea")).toBeNull();
    const photoHint = document.querySelector(".face-swap-photo-hint");
    expect(photoHint?.nextElementSibling?.classList.contains("input-box--face-swap")).toBe(true);
    expect(photoHint?.textContent).toContain("建议上传单人、清晰、光线均匀的人物照片，尽量完整展示身体，避免遮挡或裁切。");
    expect(photoHint?.textContent).toContain("人物姿态、拍摄角度和身材比例越接近原视频，生成效果通常越好。");
    const imageInput = document.querySelector<HTMLInputElement>('input[aria-label="人物图片"]')!;
    const videoInput = document.querySelector<HTMLInputElement>('input[aria-label="原始视频"]')!;
    expect(imageInput).not.toBeNull();
    expect(videoInput).not.toBeNull();

    const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map((item) => item.textContent?.trim())).toEqual(["默认", "质量"]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");

    const submit = () => document.querySelector<HTMLButtonElement>(".btn-send")!;
    expect(submit().disabled).toBe(true);

    const portrait = new File(["img"], "character.jpeg", { type: "image/jpeg" });
    const sourceVideo = new File(["vid"], "performance.mp4", { type: "video/mp4" });
    act(() => setFileInput(imageInput, portrait));
    expect(submit().disabled).toBe(true);

    act(() => setFileInput(videoInput, sourceVideo));
    expect(submit().disabled).toBe(false);

    await act(async () => {
      submit().click();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(
      "视频换脸（默认）",
      [
        { file: portrait, slot: "video_reference_image" },
        { file: sourceVideo, slot: "video_reference_video" },
      ],
      { resolution: "720p" },
      undefined,
      undefined,
      VIDEO_FACE_SWAP_MODEL,
    );

    // Switch to 质量 (1080p) and verify the submitted resolution and cleanup.
    act(() => radios[1].click());
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    act(() => setFileInput(imageInput, portrait));
    act(() => setFileInput(videoInput, sourceVideo));
    await act(async () => {
      submit().click();
    });
    expect(onSend).toHaveBeenLastCalledWith(
      "视频换脸（质量）",
      [
        { file: portrait, slot: "video_reference_image" },
        { file: sourceVideo, slot: "video_reference_video" },
      ],
      { resolution: "1080p" },
      undefined,
      undefined,
      VIDEO_FACE_SWAP_MODEL,
    );
    expect(createUrl).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalled();
  });

  it("rejects mismatched file types with an inline alert", () => {
    renderVideoPanel();
    const faceSwapTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.trim() === "视频换脸",
    )!;
    act(() => faceSwapTab.click());

    const imageInput = document.querySelector<HTMLInputElement>('input[aria-label="人物图片"]')!;
    const badFile = new File(["txt"], "notes.txt", { type: "text/plain" });
    act(() => setFileInput(imageInput, badFile));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("人物图片");
    expect(document.querySelector<HTMLButtonElement>(".btn-send")!.disabled).toBe(true);
  });
});
