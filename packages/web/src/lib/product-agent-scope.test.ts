import { describe, expect, it } from "vitest";
import { digitalEmployeeConversations, withoutDigitalEmployee } from "./product-agent-scope.js";

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
});
