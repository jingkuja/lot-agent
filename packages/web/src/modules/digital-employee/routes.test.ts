import { describe, expect, it } from "vitest";
import { employeePath, normalizeEmployeePath, parseEmployeePath } from "./routes.js";

describe("employee routes", () => {
  it("reads each page from its path", () => {
    expect(parseEmployeePath("/digital-employee/today").view).toBe("today");
    expect(parseEmployeePath("/digital-employee/chat/c1")).toMatchObject({ view: "chat", conversationId: "c1" });
    expect(parseEmployeePath("/digital-employee/customers/segments")).toMatchObject({ view: "customers", tab: "segments", profileId: null });
    expect(parseEmployeePath("/digital-employee/customers/p1")).toMatchObject({ view: "customers", tab: null, profileId: "p1" });
    expect(parseEmployeePath("/digital-employee/marketing/assets")).toMatchObject({ view: "marketing", tab: "assets" });
    expect(parseEmployeePath("/digital-employee/work-log/snoozed")).toMatchObject({ view: "work-log", tab: "snoozed" });
  });

  it("treats an unknown page as today", () => {
    expect(parseEmployeePath("/digital-employee/anything").view).toBe("today");
  });

  it("escapes what goes into a path", () => {
    expect(employeePath("chat", "a/b")).toBe("/digital-employee/chat/a%2Fb");
    expect(parseEmployeePath(employeePath("chat", "a/b")).conversationId).toBe("a/b");
  });

  it.each([
    ["/digital-employee", "/digital-employee/today"],
    ["/digital-employee/customer-profile", "/digital-employee/today"],
    ["/digital-employee/marketing-materials/manage", "/digital-employee/materials"],
    ["/digital-employee/profiles", "/digital-employee/customers"],
    ["/digital-employee/profiles/p1", "/digital-employee/customers/p1"],
    ["/digital-employee/acquisition/chat", "/digital-employee/today"],
    ["/digital-employee/follow-ups", "/digital-employee/today"],
    ["/digital-employee/copy", "/digital-employee/marketing"],
    ["/digital-employee/copy/chat", "/digital-employee/chat"],
  ])("sends %s to its new place", (old, next) => {
    expect(normalizeEmployeePath(old)).toBe(next);
  });

  it("leaves paths that already fit alone", () => {
    expect(normalizeEmployeePath("/digital-employee/today")).toBe("/digital-employee/today");
    expect(normalizeEmployeePath("/digital-employee/customers/p1")).toBe("/digital-employee/customers/p1");
    expect(normalizeEmployeePath("/assistant")).toBe("/assistant");
  });

  it("does not confuse paths that only share a prefix", () => {
    expect(normalizeEmployeePath("/digital-employee-other")).toBe("/digital-employee-other");
    expect(normalizeEmployeePath("/digital-employee/copyright")).toBe("/digital-employee/copyright");
  });
});
