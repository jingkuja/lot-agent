import { describe, it, expect } from "vitest";
import { resolveConversationModel } from "./agent-service.js";

describe("resolveConversationModel", () => {
  it("prefers explicit modelId, then conversation model, then agent default", () => {
    expect(resolveConversationModel("m-explicit", "m-conv", "m-default")).toBe("m-explicit");
    expect(resolveConversationModel(undefined, "m-conv", "m-default")).toBe("m-conv");
    expect(resolveConversationModel(undefined, null, "m-default")).toBe("m-default");
  });
});
