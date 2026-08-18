import { describe, expect, it, vi } from "vitest";
import { createCustomerCaptureTools } from "./customer-capture-tools.js";

describe("customer capture tools", () => {
  it("uses trusted ToolContext provenance rather than model input for prepare", async () => {
    const service = {
      prepareCustomerCapture: vi.fn(async () => ({
        draftId: "draft-1", status: "ready", profile: { id: "p1", displayName: "李姐" }, candidates: [], ambiguities: [],
      })),
      commitCustomerCapture: vi.fn(),
    } as any;
    const [prepare] = createCustomerCaptureTools(service);
    const result = await prepare.execute(
      { customerMention: "李姐", eventType: "requirement", productName: "边缘算力" },
      {
        workingDirectory: "/tmp", userId: "u1", conversationId: "c1", sourceMessageId: "m1",
        sourceText: "李姐想了解边缘算力", modelId: "model-a",
      }
    );

    expect(result.isError).toBeUndefined();
    expect(service.prepareCustomerCapture).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ customerMention: "李姐" }),
      expect.objectContaining({ sourceText: "李姐想了解边缘算力", sourceMessageId: "m1" })
    );
    expect(result.content).toContain("commit_customer_capture");
  });
});
