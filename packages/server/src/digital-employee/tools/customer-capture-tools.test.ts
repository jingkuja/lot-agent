import { describe, expect, it, vi } from "vitest";
import { createCustomerCaptureTools } from "./customer-capture-tools.js";
import { ProductSelectionRequiredError } from "../errors.js";

describe("customer capture tools", () => {
  it("uses trusted ToolContext provenance rather than model input for prepare", async () => {
    const service = {
      prepareCustomerCapture: vi.fn(async () => ({
        draftId: "draft-1", status: "ready", profile: { id: "p1", displayName: "李姐" }, candidates: [], ambiguities: [],
      })),
      commitCustomerCapture: vi.fn(),
    } as any;
    const [prepare] = createCustomerCaptureTools(service);
    expect(JSON.stringify(prepare.parameters)).toContain("即使营销资料未匹配也不能省略");
    const result = await prepare.execute(
      {
        customerMention: "李姐",
        eventType: "requirement",
        productName: "边缘算力",
        marketingProductId: "00000000-0000-0000-0000-000000000123",
      },
      {
        workingDirectory: "/tmp", userId: "u1", conversationId: "c1", sourceMessageId: "m1",
        sourceText: "李姐想了解边缘算力", modelId: "model-a",
      }
    );

    expect(result.isError).toBeUndefined();
    expect(service.prepareCustomerCapture).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        customerMention: "李姐",
        marketingProductId: "00000000-0000-0000-0000-000000000123",
      }),
      expect.objectContaining({ sourceText: "李姐想了解边缘算力", sourceMessageId: "m1" })
    );
    expect(result.content).toContain("commit_customer_capture");
  });

  it("maps an unmatched product confirmation to safe commit fields", async () => {
    const service = {
      prepareCustomerCapture: vi.fn(async () => ({
        draftId: "00000000-0000-0000-0000-000000000010",
        status: "needs_clarification",
        candidates: [], ambiguities: ["marketing_product"],
        productCandidates: [{ id: "00000000-0000-0000-0000-000000000123", name: "中转站" }],
        clarification: {
          kind: "marketing_product",
          question: "“中转站增强版”要关联到哪个营销产品？",
          options: ["中转站", "将“中转站增强版”添加为新产品", "本次不关联产品"],
        },
      })),
    } as any;
    const [prepare] = createCustomerCaptureTools(service);

    const result = await prepare.execute(
      { customerMention: "李姐", eventType: "note", productName: "中转站增强版" },
      { workingDirectory: "/tmp", userId: "u1", sourceText: "关联中转站增强版" }
    );

    expect(result.content).toContain("marketingProductId: 00000000-0000-0000-0000-000000000123");
    expect(result.content).toContain("createMarketingProduct=true");
    expect(result.content).toContain("skipProduct=true");
  });

  it("requests product confirmation after a prior customer confirmation", async () => {
    const commitCustomerCapture = vi.fn(async () => {
      throw new ProductSelectionRequiredError("中转站增强版", [
        { id: "00000000-0000-0000-0000-000000000123", name: "中转站" },
      ]);
    });
    const service = { commitCustomerCapture } as any;
    const [, commit] = createCustomerCaptureTools(service);

    const result = await commit.execute(
      {
        draftId: "00000000-0000-0000-0000-000000000010",
        profileId: "00000000-0000-0000-0000-000000000020",
      },
      { workingDirectory: "/tmp", userId: "u1" }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("请调用 ask_user");
    expect(result.content).toContain("中转站");
    expect(result.content).toContain("再次带上同一个 profileId 或 createProfile");
  });
});
