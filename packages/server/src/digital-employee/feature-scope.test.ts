import { describe, expect, it } from "vitest";
import { parseDigitalEmployeeFeatureScope, readConversationFeatureScope } from "./feature-scope.js";

describe("digital employee feature scope", () => {
  it("accepts only the four workspace scopes", () => {
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

  it("reads the persisted conversation metadata field", () => {
    expect(readConversationFeatureScope({ digitalEmployeeFeatureScope: "opportunity-advisor" }))
      .toBe("opportunity-advisor");
    expect(readConversationFeatureScope({ digitalEmployeeFeatureScope: "all" })).toBeUndefined();
    expect(readConversationFeatureScope({})).toBeUndefined();
  });
});
