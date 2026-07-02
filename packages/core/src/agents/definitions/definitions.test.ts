import { describe, it, expect } from "vitest";
import { pptDefinition, contractDefinition, imageDefinition } from "./index.js";

describe("agent definitions", () => {
  it("ppt is a real office agent with ask_user + generate_ppt", () => {
    expect(pptDefinition.id).toBe("ppt");
    expect(pptDefinition.type).toBe("ppt");
    expect(pptDefinition.category).toBe("办公");
    expect(pptDefinition.toolNames).toEqual(["ask_user", "generate_ppt"]);
    expect(pptDefinition.systemPrompt).toContain("templateAssetId");
    expect(pptDefinition.systemPrompt).not.toContain("占位");
  });

  it("contract is a review stub agent", () => {
    expect(contractDefinition.id).toBe("contract");
    expect(contractDefinition.type).toBe("contract");
    expect(contractDefinition.category).toBe("审核");
  });

  it("existing agents carry a category", () => {
    expect(imageDefinition.category).toBe("创作");
  });
});
