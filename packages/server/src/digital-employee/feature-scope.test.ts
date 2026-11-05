import { describe, expect, it } from "vitest";
import { newConversationFeatureScope, parseDigitalEmployeeFeatureScope, readConversationFeatureScope } from "./feature-scope.js";

describe("digital employee feature scope", () => {
  it("accepts the four workspace scopes and the employee scope", () => {
    expect(parseDigitalEmployeeFeatureScope("employee")).toBe("employee");
    expect(parseDigitalEmployeeFeatureScope("customer-profile")).toBe("customer-profile");
    expect(parseDigitalEmployeeFeatureScope("opportunity-advisor")).toBe("opportunity-advisor");
    expect(parseDigitalEmployeeFeatureScope("customer-acquisition")).toBe("customer-acquisition");
    expect(parseDigitalEmployeeFeatureScope("marketing-materials")).toBe("marketing-materials");
  });

  it("rejects missing, blank, or unknown values", () => {
    expect(parseDigitalEmployeeFeatureScope(undefined)).toBeUndefined();
    expect(parseDigitalEmployeeFeatureScope("")).toBeUndefined();
    expect(parseDigitalEmployeeFeatureScope("all")).toBeUndefined();
    expect(parseDigitalEmployeeFeatureScope("customer-profile ")).toBeUndefined();
  });

  it("only the server chooses employee for a new conversation", () => {
    expect(newConversationFeatureScope("customer-profile", false)).toBe("customer-profile");
    expect(newConversationFeatureScope("employee", false)).toBeUndefined();
    expect(newConversationFeatureScope(undefined, false)).toBeUndefined();
    expect(newConversationFeatureScope("customer-profile", true)).toBe("employee");
    expect(newConversationFeatureScope(undefined, true)).toBe("employee");
  });

  it("reads the persisted conversation metadata field", () => {
    expect(readConversationFeatureScope({ digitalEmployeeFeatureScope: "opportunity-advisor" }))
      .toBe("opportunity-advisor");
    expect(readConversationFeatureScope({ digitalEmployeeFeatureScope: "all" })).toBeUndefined();
    expect(readConversationFeatureScope({})).toBeUndefined();
  });
});
