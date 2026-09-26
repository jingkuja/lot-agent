import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { AskUserCard } from "./AskUserCard.js";

afterEach(() => vi.unstubAllGlobals());
it("renders invalid persisted tool input without throwing or disabling free text", () => {
  vi.stubGlobal("React", React);
  for (const input of [null, "bad", { question: 123, options: {} }, { question: "Choose?", options: [{ label: "bad" }, "valid"] }]) {
    expect(() => renderToStaticMarkup(React.createElement(AskUserCard, { input, interactive: true }))).not.toThrow();
  }
});

it("renders malformed outlines safely during tool validation and history replay", async () => {
  vi.stubGlobal("React", React);
  const { OutlineCard } = await import("./OutlineCard.js");
  for (const input of [{ title: {}, slides: {} }, { slides: [null, { layout: {}, title: {}, bullets: [null, {}], items: [{ label: {} }] }] }]) {
    expect(() => renderToStaticMarkup(React.createElement(OutlineCard, { input, interactive: false }))).not.toThrow();
  }
});
