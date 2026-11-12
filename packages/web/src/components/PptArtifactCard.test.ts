// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parsePptApproval, type PptDeck } from "@lot-agent/core/presentation";
import { PptArtifactCard } from "./PptArtifactCard.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); });

const deck: PptDeck = {
  title: "经营复盘",
  brief: { targetSlides: 2, audience: "店长" },
  themePreset: "business",
  slides: [
    { layout: "table", title: "进度", table: { columns: ["门店", "状态"], rows: [["门店一", "待复核"]] }, notes: "确认后向店长汇报" },
    { layout: "chart", title: "收入", bullets: ["第二季度增加"], chart: {
      type: "bar", categories: ["Q1", "Q2"], series: [{ name: "收入", values: [0, 12] }], unit: "万元", source: "季度报表",
    } },
  ],
};

function renderCard(onReply: (text: string) => void | Promise<void>, currentDeck = deck) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(PptArtifactCard, {
    artifact: { version: 1, deck: currentDeck, warnings: [] },
    download: { url: "/example.pptx", filename: "example.pptx" },
    onReply,
  })));
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

it("re-exports the displayed deck once when a theme thumbnail is clicked", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const onReply = vi.fn((_text: string) => pending);
  renderCard(onReply, { ...deck, templateAssetId: "template", backgrounds: [{ assetId: "background" }] });
  expect(document.querySelectorAll(".ppt-theme-option img")).toHaveLength(5);
  act(() => { button("科技深色").click(); button("暖橙创意").click(); });
  expect(onReply).toHaveBeenCalledTimes(1);
  expect(parsePptApproval(onReply.mock.calls[0][0])).toEqual({ ...deck, themePreset: "tech-dark" });
  expect(document.querySelector<HTMLFieldSetElement>(".ppt-theme-picker")?.disabled).toBe(true);
  await act(async () => { finish(); });
  expect(document.querySelector<HTMLFieldSetElement>(".ppt-theme-picker")?.disabled).toBe(false);
});

it("edits a table cell while retaining the chart takeaways, notes and theme", async () => {
  const onReply = vi.fn<(text: string) => Promise<void>>().mockRejectedValueOnce(new Error("dispatch failed")).mockResolvedValue(undefined);
  renderCard(onReply);
  act(() => button("逐页查看与修改").click());
  const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="第 1 行，第 2 列"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "已复核");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("按修改内容重新导出").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("导出失败，请重试。");
  await act(async () => button("按修改内容重新导出").click());
  expect(onReply.mock.calls[1][0]).toBe(onReply.mock.calls[0][0]);
  expect(parsePptApproval(onReply.mock.calls[1][0])).toEqual({
    ...deck, slides: [
      { ...deck.slides[0], table: { ...deck.slides[0].table, rows: [["门店一", "已复核"]] } }, deck.slides[1],
    ],
  });
});
