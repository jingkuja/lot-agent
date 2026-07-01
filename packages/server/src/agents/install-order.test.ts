import { describe, it, expect } from "vitest";
import {
  DEFAULT_INSTALLED_AGENT_IDS,
  GENERAL_AGENT_ID,
  nextSortOrder,
  promotedSortOrder,
} from "./install-order.js";

describe("install-order", () => {
  it("default set installs general/image/video with general first", () => {
    expect(DEFAULT_INSTALLED_AGENT_IDS).toEqual(["general", "image", "video"]);
    expect(DEFAULT_INSTALLED_AGENT_IDS[0]).toBe(GENERAL_AGENT_ID);
  });

  it("nextSortOrder appends after current max", () => {
    expect(nextSortOrder([])).toBe(0);
    expect(nextSortOrder([0, 1, 2])).toBe(3);
    expect(nextSortOrder([-1, 5])).toBe(6);
  });

  it("promotedSortOrder moves ahead of current min", () => {
    expect(promotedSortOrder([])).toBe(-1);
    expect(promotedSortOrder([1, 2, 3])).toBe(0);
    expect(promotedSortOrder([-2, 4])).toBe(-3);
  });
});
