import { describe, it, expect } from "vitest";
import { pptDefinition, contractDefinition, imageDefinition, digitalEmployeeDefinition } from "./index.js";

describe("agent definitions", () => {
  it("ppt is a real office agent with ask_user + generate_ppt", () => {
    expect(pptDefinition.id).toBe("ppt");
    expect(pptDefinition.type).toBe("ppt");
    expect(pptDefinition.category).toBe("办公");
    expect(pptDefinition.toolNames).toEqual(["ask_user", "propose_outline", "generate_ppt"]);
    expect(pptDefinition.systemPrompt).toContain("templateAssetId");
    expect(pptDefinition.systemPrompt).not.toContain("占位");
  });

  it("contract is a real comparison agent with ask_user + generate_document", () => {
    expect(contractDefinition.id).toBe("contract");
    expect(contractDefinition.type).toBe("contract");
    expect(contractDefinition.category).toBe("审核");
    expect(contractDefinition.name).toBe("合同对比");
    expect(contractDefinition.toolNames).toEqual(["ask_user", "generate_document"]);
    expect(contractDefinition.systemPrompt).toContain("[旧版合同:");
    expect(contractDefinition.systemPrompt).toContain("[新版合同:");
    expect(contractDefinition.systemPrompt).toContain("generate_document");
    expect(contractDefinition.systemPrompt).not.toContain("占位");
  });

  it("existing agents carry a category", () => {
    expect(imageDefinition.category).toBe("创作");
  });

  it("digital employee exposes only controlled customer-profile tools", () => {
    expect(digitalEmployeeDefinition.type).toBe("digital_employee");
    expect(digitalEmployeeDefinition.toolNames).toContain("search_customer_profiles");
    expect(digitalEmployeeDefinition.toolNames).toContain("commit_customer_profile_change");
    expect(digitalEmployeeDefinition.toolNames).not.toContain("execute_command");
    expect(digitalEmployeeDefinition.systemPrompt).toContain("不得声称已完成");
  });
});
