import { describe, expect, it } from "vitest";
import { digitalEmployeeConversations } from "./conversation-scope.js";

describe("digital employee conversations", () => {
  it("keeps conversations of every scope, older ones included", () => {
    const items = [
      { agent_id: "digital_employee", metadata: { digitalEmployeeFeatureScope: "employee" } },
      { agent_id: "digital_employee", metadata: { digitalEmployeeFeatureScope: "customer-acquisition" } },
      { agent_id: "digital_employee" },
      { agent_id: "general" },
    ];
    expect(digitalEmployeeConversations(items)).toEqual(items.slice(0, 3));
  });
});
