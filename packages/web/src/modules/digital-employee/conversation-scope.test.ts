import { describe, expect, it } from "vitest";
import { digitalEmployeeConversations, digitalEmployeeConversationsForScope, withoutDigitalEmployee } from "./conversation-scope.js";

describe("product Agent scope", () => {
  it("keeps the digital employee out of normal Agent surfaces", () => {
    expect(withoutDigitalEmployee([
      { id: "general" },
      { id: "digital_employee" },
      { id: "image" },
    ])).toEqual([{ id: "general" }, { id: "image" }]);
  });

  it("keeps only digital-employee conversations in its floating history", () => {
    expect(digitalEmployeeConversations([
      { agent_id: "general", title: "普通会话" },
      { agent_id: "digital_employee", title: "客户画像" },
    ])).toEqual([{ agent_id: "digital_employee", title: "客户画像" }]);
  });

  it("shows employee conversations in every module's history", () => {
    const stored = (scope?: string) => ({ metadata: scope ? { digitalEmployeeFeatureScope: scope } : {} });
    const items = [stored("employee"), stored("customer-acquisition"), stored("customer-profile"), stored()];
    expect(digitalEmployeeConversationsForScope(items, "customer-acquisition")).toEqual([items[0], items[1]]);
    expect(digitalEmployeeConversationsForScope(items, "customer-profile")).toEqual([items[0], items[2], items[3]]);
    expect(digitalEmployeeConversationsForScope(items, "marketing-materials")).toEqual([items[0]]);
  });
});
