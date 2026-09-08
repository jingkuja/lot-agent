import { describe, it, expect } from "vitest";
import {
  DEFAULT_INSTALLED_AGENT_IDS,
  GENERAL_AGENT_ID,
  nextSortOrder,
  promotedSortOrder,
} from "./install-order.js";

describe("install-order", () => {
  it("keeps the independent digital-employee module out of user Agent installs", () => {
    expect(DEFAULT_INSTALLED_AGENT_IDS).toEqual(["image", "video"]);
    expect(DEFAULT_INSTALLED_AGENT_IDS).not.toContain("digital_employee");
    expect(DEFAULT_INSTALLED_AGENT_IDS).not.toContain(GENERAL_AGENT_ID);
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
