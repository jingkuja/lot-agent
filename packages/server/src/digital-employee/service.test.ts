import { describe, expect, it, vi } from "vitest";
import { SecretBox } from "../auth/secret-box.js";
import { DigitalEmployeeService } from "./service.js";

function serviceWith(
  repository: Record<string, unknown>,
  db: Record<string, unknown> = {},
  cohortSummaryGenerator?: { generate: (input: any) => Promise<{ summary: string; modelId: string }> }
) {
  const service = new DigitalEmployeeService({ pool: {}, ...db } as any, new SecretBox(), cohortSummaryGenerator);
  (service as any).repository = repository;
  return service;
}

function draft(row: any) {
  return {
    ...row,
    operation: row.operation,
    status: row.status,
    risks: row.risks,
  };
}

describe("DigitalEmployeeService acquisition lead return", () => {
  it("replays an identical lead payload without creating another profile", async () => {
    const insertManualAction = vi.fn();
    const getAction = vi.fn(async () => ({ id: "a1", profileId: "p1", title: "跟进李静的活动咨询" }));
    const client = { query: vi.fn(async () => ({ rows: [{ id: "a1" }] })) };
    const service = serviceWith({
      transaction: vi.fn(async (operation: (c: typeof client) => Promise<unknown>) => operation(client)),
      getObservationBySource: vi.fn(async () => ({ id: "obs1", profileId: "p1" })),
      getProfile: vi.fn(async () => ({
        id: "p1", displayName: "李静", aliases: [], customerKind: "person", organization: null,
        department: null, title: null, customerRegion: null, contactCiphertext: null, source: "获客宝",
        relationshipStage: "lead", overallHealth: "healthy", tags: [], customFields: {}, summary: "",
        summaryVersion: 1, manualLockFields: [], lastObservedAt: null, lastContactAt: null, nextFollowUpAt: null,
        version: 1, status: "active", archivedAt: null, createdAt: "", updatedAt: "", userId: "u1", ownerUserId: "u1",
      })),
      createProfile: vi.fn(),
    });
    (service as any).opportunities = { insertManualAction, getAction };

    const first = await service.returnAcquisitionLead("u1", { displayName: "李静", sourceCampaign: "分享会", quote: "想看演示" });
    const second = await service.returnAcquisitionLead("u1", { displayName: "李静", sourceCampaign: "分享会", quote: "想看演示" });

    expect(first.alreadyApplied).toBe(true);
    expect(second.alreadyApplied).toBe(true);
    expect(first.profile.id).toBe("p1");
    expect(insertManualAction).not.toHaveBeenCalled();
    expect((service as any).repository.createProfile).not.toHaveBeenCalled();
  });
});

describe("DigitalEmployeeService archive", () => {
  const profile = {
    id: "p1", displayName: "李静", aliases: [], customerKind: "person", organization: null,
    department: null, title: null, customerRegion: null, contactCiphertext: null, source: null,
    relationshipStage: "lead", overallHealth: "healthy", tags: [], customFields: {}, summary: "",
    summaryVersion: 1, manualLockFields: [], lastObservedAt: null, lastContactAt: null, nextFollowUpAt: null,
    version: 1, status: "active", archivedAt: null, createdAt: "", updatedAt: "", userId: "u1", ownerUserId: "u1",
  };

  it("refuses to archive when open tasks exist and cancel/keep was not chosen", async () => {
    const cancelOpenWorkForProfile = vi.fn();
    const archiveProfile = vi.fn(async () => ({ ...profile, status: "archived", version: 2 }));
    const service = serviceWith({
      getProfile: vi.fn(async () => profile),
      transaction: vi.fn(async (operation: (c: unknown) => Promise<unknown>) => operation({})),
      archiveProfile,
    });
    (service as any).opportunities = { countOpenTasks: vi.fn(async () => 2), cancelOpenWorkForProfile };

    await expect(service.archiveProfile("u1", "p1", 1)).rejects.toMatchObject({
      code: "open_tasks",
      openTaskCount: 2,
    });
    expect(cancelOpenWorkForProfile).not.toHaveBeenCalled();
  });

  it("cancels open follow-ups when archiving with onOpenTasks=cancel", async () => {
    const cancelOpenWorkForProfile = vi.fn();
    const service = serviceWith({
      getProfile: vi.fn(async () => profile),
      transaction: vi.fn(async (operation: (c: unknown) => Promise<unknown>) => operation({ tag: "tx" })),
      archiveProfile: vi.fn(async () => ({ ...profile, status: "archived", version: 2 })),
    });
    (service as any).opportunities = { countOpenTasks: vi.fn(async () => 1), cancelOpenWorkForProfile };

    const result = await service.archiveProfile("u1", "p1", 1, "cancel");

    expect(result.status).toBe("archived");
    expect(cancelOpenWorkForProfile).toHaveBeenCalledWith("u1", "p1", { tag: "tx" });
  });

  it("keeps open follow-ups when archiving with onOpenTasks=keep", async () => {
    const cancelOpenWorkForProfile = vi.fn();
    const service = serviceWith({
      getProfile: vi.fn(async () => profile),
      transaction: vi.fn(async (operation: (c: unknown) => Promise<unknown>) => operation({})),
      archiveProfile: vi.fn(async () => ({ ...profile, status: "archived", version: 2 })),
    });
    (service as any).opportunities = { countOpenTasks: vi.fn(async () => 1), cancelOpenWorkForProfile };

    await service.archiveProfile("u1", "p1", 1, "keep");
    expect(cancelOpenWorkForProfile).not.toHaveBeenCalled();
  });

  it("archives without a task choice when the customer has no open follow-ups", async () => {
    const cancelOpenWorkForProfile = vi.fn();
    const service = serviceWith({
      getProfile: vi.fn(async () => profile),
      transaction: vi.fn(async (operation: (c: unknown) => Promise<unknown>) => operation({})),
      archiveProfile: vi.fn(async () => ({ ...profile, status: "archived", version: 2 })),
    });
    (service as any).opportunities = { countOpenTasks: vi.fn(async () => 0), cancelOpenWorkForProfile };

    await expect(service.archiveProfile("u1", "p1", 1)).resolves.toMatchObject({ status: "archived" });
    expect(cancelOpenWorkForProfile).not.toHaveBeenCalled();
  });
});

describe("DigitalEmployeeService product relationships", () => {
  const profile = {
    id: "p1", displayName: "李静", aliases: [], customerKind: "person", organization: null,
    department: null, title: null, customerRegion: null, contactCiphertext: null, source: null,
    relationshipStage: "lead", overallHealth: "healthy", tags: [], customFields: {}, summary: "",
    summaryVersion: 1, manualLockFields: [], lastObservedAt: null, lastContactAt: null, nextFollowUpAt: null,
    version: 1, status: "active", archivedAt: null, createdAt: "", updatedAt: "", userId: "u1", ownerUserId: "u1",
  };
  const marketingProductId = "00000000-0000-0000-0000-000000000123";

  it("stores the owned marketing product id and canonical product name", async () => {
    const createProductState = vi.fn(async (row) => ({
      ...row, version: 1, createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z",
      lastObservationId: null, lastConfirmedAt: null,
    }));
    const service = serviceWith({
      transaction: vi.fn(async (operation: (client: unknown) => Promise<unknown>) => operation({})),
      getProfile: vi.fn(async () => profile),
      getProductState: vi.fn(async () => null),
      getProductStateByMarketingProduct: vi.fn(async () => null),
      createProductState,
      listProductStates: vi.fn(async () => []),
      saveProfile: vi.fn(async (_userId, next) => ({ ...next, version: 2 })),
      createStateChange: vi.fn(async () => undefined),
    });
    (service as any).marketingMaterials = {
      getProduct: vi.fn(async () => ({ id: marketingProductId, name: "营销资料标准名称", status: "active" })),
    };

    await service.updateProductState("u1", "p1", `marketing:${marketingProductId}`, {
      marketingProductId,
      productName: "模型猜测的名称",
      journeyStage: "evaluating",
    });

    expect(createProductState).toHaveBeenCalledWith(expect.objectContaining({
      marketingProductId,
      productName: "营销资料标准名称",
    }), expect.anything());
  });

  it("does not create a free-text-only product relationship", async () => {
    const service = serviceWith({
      transaction: vi.fn(async (operation: (client: unknown) => Promise<unknown>) => operation({})),
      getProfile: vi.fn(async () => profile),
      getProductState: vi.fn(async () => null),
    });
    await expect(service.updateProductState("u1", "p1", "free-text", { productName: "自由文本产品" }))
      .rejects.toThrow("请选择营销资料中的产品");
  });

  it("asks for confirmation when the conversation product cannot be matched exactly", async () => {
    const createDraft = vi.fn(async (row) => row);
    const service = serviceWith({
      findProfilesByExactMention: vi.fn(async () => [profile]),
      getProductState: vi.fn(async () => null),
      createDraft,
    });
    (service as any).marketingMaterials = {
      findActiveProductByName: vi.fn(async () => null),
      listProducts: vi.fn(async () => ({
        items: [
          { id: marketingProductId, name: "中转站", status: "active" },
          { id: "00000000-0000-0000-0000-000000000124", name: "会员版", status: "active" },
        ],
        page: 1, limit: 100, total: 2,
      })),
    };

    const result = await service.prepareCustomerCapture(
      "u1",
      { customerMention: "李静", eventType: "note", productName: "中转站增强版" },
      { sourceText: "把李静关联到中转站增强版" }
    );

    expect(result.status).toBe("needs_clarification");
    expect(result.clarification).toMatchObject({ kind: "marketing_product" });
    expect(result.clarification?.options).toEqual([
      "中转站", "会员版", "将“中转站增强版”添加为新产品", "本次不关联产品",
    ]);
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({
      ambiguities: expect.arrayContaining(["marketing_product"]),
      proposedObservation: expect.objectContaining({
        productCandidates: expect.arrayContaining([expect.objectContaining({ id: marketingProductId })]),
      }),
    }));
  });

  it("automatically links an exact marketing-product name", async () => {
    const createDraft = vi.fn(async (row) => row);
    const getProductStateByMarketingProduct = vi.fn(async () => null);
    const service = serviceWith({
      findProfilesByExactMention: vi.fn(async () => [profile]),
      getProductStateByMarketingProduct,
      createDraft,
    });
    (service as any).marketingMaterials = {
      findActiveProductByName: vi.fn(async () => ({ id: marketingProductId, name: "中转站", status: "active" })),
      listProducts: vi.fn(),
    };

    const result = await service.prepareCustomerCapture(
      "u1",
      { customerMention: "李静", eventType: "note", productName: " 中转站 " },
      { sourceText: "把李静关联到中转站" }
    );

    expect(result.status).toBe("ready");
    expect((service as any).marketingMaterials.listProducts).not.toHaveBeenCalled();
    expect(getProductStateByMarketingProduct).toHaveBeenCalledWith("u1", "p1", marketingProductId);
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({
      proposedObservation: expect.objectContaining({
        capture: expect.objectContaining({ marketingProductId, productName: "中转站" }),
      }),
    }));
  });

  it("recovers an explicitly mentioned catalog product when the model omitted productName", async () => {
    const createDraft = vi.fn(async (row) => row);
    const getProductStateByMarketingProduct = vi.fn(async () => null);
    const service = serviceWith({
      findProfilesByExactMention: vi.fn(async () => [profile]),
      getProductStateByMarketingProduct,
      createDraft,
    });
    (service as any).marketingMaterials = {
      findActiveProductsMentionedInText: vi.fn(async () => [{
        id: marketingProductId, name: "agent代销", status: "active",
      }]),
      getProduct: vi.fn(async () => ({ id: marketingProductId, name: "agent代销", status: "active" })),
    };

    const result = await service.prepareCustomerCapture(
      "u1",
      { customerMention: "张老师", eventType: "purchase_intent" },
      { sourceText: "张老师今天咨询 agent代销，表示很感兴趣，但对于入场金额太高犹豫了" }
    );

    expect(result.status).toBe("ready");
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({
      proposedObservation: expect.objectContaining({
        capture: expect.objectContaining({ productName: "agent代销", marketingProductId }),
      }),
    }));
  });

  it("infers a consultation object and asks for confirmation when it is not in marketing materials", async () => {
    const createDraft = vi.fn(async (row) => row);
    const service = serviceWith({
      findProfilesByExactMention: vi.fn(async () => [profile]),
      getProductState: vi.fn(async () => null),
      createDraft,
    });
    (service as any).marketingMaterials = {
      findActiveProductsMentionedInText: vi.fn(async () => []),
      findActiveProductByName: vi.fn(async () => null),
      listProducts: vi.fn(async () => ({
        items: [{ id: marketingProductId, name: "中转站", status: "active" }],
        page: 1, limit: 100, total: 1,
      })),
    };

    const result = await service.prepareCustomerCapture(
      "u1",
      { customerMention: "张老师", eventType: "purchase_intent" },
      { sourceText: "张老师今天咨询 agent代销，表示很感兴趣，但对于入场金额太高犹豫了" }
    );

    expect(result.clarification).toMatchObject({
      kind: "marketing_product",
      question: "“agent代销”要关联到哪个营销产品？",
    });
    expect(result.clarification?.options).toContain("将“agent代销”添加为新产品");
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({
      proposedObservation: expect.objectContaining({
        capture: expect.objectContaining({ productName: "agent代销" }),
      }),
    }));
  });

  function captureCommitService() {
    const applyObservation = vi.fn(async (_client, _userId, args) => ({
      profile: args.profile,
      observation: { id: "o1" },
      extraction: { id: "e1" },
      products: [], appliedFields: [], skippedFields: [],
    }));
    const repository = {
      transaction: vi.fn(async (operation: (client: unknown) => Promise<unknown>) => operation({ tx: true })),
      getDraft: vi.fn(async () => ({
        id: "d1", status: "awaiting_confirmation", expiresAt: "2999-01-01T00:00:00.000Z",
        candidateProfileIds: ["p1"], appliedProfileId: null, appliedObservationId: null,
        proposedObservation: {
          capture: { customerMention: "李静", eventType: "note", productName: "中转站增强版" },
          profileId: "p1",
          productCandidates: [{ id: marketingProductId, name: "中转站" }],
        },
        ambiguities: ["marketing_product"], conversationId: null, sourceMessageId: null,
      })),
      getProfile: vi.fn(async () => profile),
      markDraftApplied: vi.fn(async () => ({})),
    };
    const service = serviceWith(repository);
    (service as any).applyObservation = applyObservation;
    return { service, applyObservation };
  }

  it("commits a user-selected existing marketing product", async () => {
    const { service, applyObservation } = captureCommitService();
    (service as any).marketingMaterials = {
      getProduct: vi.fn(async () => ({ id: marketingProductId, name: "中转站", status: "active" })),
    };

    await service.commitCustomerCapture("u1", { draftId: "d1", marketingProductId });

    expect(applyObservation).toHaveBeenCalledWith(expect.anything(), "u1", expect.objectContaining({
      input: expect.objectContaining({ marketingProductId, productName: "中转站" }),
    }));
  });

  it("creates a new marketing product from the confirmed original name", async () => {
    const { service, applyObservation } = captureCommitService();
    const createProduct = vi.fn(async () => ({
      id: "00000000-0000-0000-0000-000000000125", name: "中转站增强版", status: "active",
    }));
    (service as any).marketingMaterials = { createProduct };

    await service.commitCustomerCapture("u1", { draftId: "d1", createMarketingProduct: true });

    expect(createProduct).toHaveBeenCalledWith("u1", { name: "中转站增强版" }, { tx: true });
    expect(applyObservation).toHaveBeenCalledWith(expect.anything(), "u1", expect.objectContaining({
      input: expect.objectContaining({
        marketingProductId: "00000000-0000-0000-0000-000000000125",
        productName: "中转站增强版",
      }),
    }));
  });

  it("can save the observation without a product when the user chooses so", async () => {
    const { service, applyObservation } = captureCommitService();
    (service as any).marketingMaterials = {};

    await service.commitCustomerCapture("u1", { draftId: "d1", skipProduct: true });

    const appliedInput = applyObservation.mock.calls[0]?.[2].input;
    expect(appliedInput).not.toHaveProperty("productName");
    expect(appliedInput).not.toHaveProperty("marketingProductId");
  });
});

describe("DigitalEmployeeService profile changes", () => {
  it("allows a unique low-risk create to commit in the same agent turn", async () => {
    const service = serviceWith({
      findProfilesByExactMention: vi.fn(async () => []),
      createProfileChangeDraft: vi.fn(async (row) => draft(row)),
    });
    const result = await service.prepareProfileChange(
      "u1",
      { operation: "create", displayName: "李静", customerRegion: "深圳南山区" },
      { sourceMessageId: "00000000-0000-0000-0000-000000000001" }
    );
    expect(result.status).toBe("ready");
    expect(result.risks).toEqual([]);
  });

  it("never treats a single fuzzy candidate as authorization to update", async () => {
    const service = serviceWith({
      findProfilesByExactMention: vi.fn(async () => []),
      listProfiles: vi.fn(async () => ({
        items: [{
          id: "00000000-0000-0000-0000-000000000002",
          displayName: "李静",
          customerRegion: "深圳南山区",
          version: 3,
        }],
        total: 1,
      })),
      createProfileChangeDraft: vi.fn(async (row) => draft(row)),
    });
    const result = await service.prepareProfileChange(
      "u1",
      { operation: "update", customerMention: "李姐", tags: ["重点客户"] },
      { sourceMessageId: "00000000-0000-0000-0000-000000000003" }
    );
    expect(result.status).toBe("needs_confirmation");
    expect(result.risks).toContain("identity_ambiguous");
    expect(result.options).toEqual(["李静（深圳南山区）"]);
  });

  it("resolves a pronoun only through the user-scoped conversation context", async () => {
    const findProfilesByExactMention = vi.fn();
    const service = serviceWith({
      findProfilesByExactMention,
      getProfile: vi.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000002",
        displayName: "李静",
        customerRegion: "深圳南山区",
        status: "active",
        version: 4,
      })),
      createProfileChangeDraft: vi.fn(async (row) => draft(row)),
    }, {
      getConversationCustomerContext: vi.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000002",
        displayName: "李静",
      })),
    });
    const result = await service.prepareProfileChange(
      "u1",
      { operation: "update", customerMention: "她", tags: ["重点客户"] },
      { conversationId: "00000000-0000-0000-0000-000000000010" }
    );
    expect(result.status).toBe("ready");
    expect(findProfilesByExactMention).not.toHaveBeenCalled();
  });
});

describe("DigitalEmployeeService cohort overview", () => {
  it("uses a live aggregate until the first nightly snapshot exists", async () => {
    const recent = [{
      id: "p1", userId: "u1", ownerUserId: "u1", displayName: "李静", aliases: [],
      customerKind: "person", organization: null, department: null, title: null,
      customerRegion: null, contactCiphertext: null, source: null, relationshipStage: "lead",
      overallHealth: "healthy", tags: [], customFields: {}, summary: "", summaryVersion: 1,
      manualLockFields: [], lastObservedAt: null, lastContactAt: null, nextFollowUpAt: null,
      version: 1, status: "active", archivedAt: null, createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    }];
    const service = serviceWith({
      listProfiles: vi.fn(async () => ({ items: recent, page: 1, limit: 5, total: 1 })),
      getLatestCohortSnapshot: vi.fn(async () => null),
      listActiveProfilesForCohort: vi.fn(async () => recent),
    });

    const overview = await service.getOverview("u1", new Date("2026-08-18T12:00:00.000Z"));
    expect(overview.totalProfiles).toBe(1);
    expect(overview.cohort.source).toBe("live");
    expect(overview.cohort.metrics.totalProfiles).toBe(1);
    expect(overview.schedule).toMatchObject({ localTime: "23:00", timeZone: "Asia/Shanghai" });
  });

  it("persists only users missing today's snapshot inside the nightly window", async () => {
    const upsertCohortSnapshot = vi.fn(async () => {});
    const service = serviceWith({
      listUsersMissingCohortSnapshot: vi.fn(async () => ["u1"]),
      listActiveProfilesForCohort: vi.fn(async () => []),
      upsertCohortSnapshot,
    });

    expect(await service.runNightlyCohortSummaries(new Date("2026-08-18T14:59:00.000Z"))).toBe(0);
    expect(await service.runNightlyCohortSummaries(new Date("2026-08-18T15:01:00.000Z"))).toBe(1);
    expect(upsertCohortSnapshot).toHaveBeenCalledWith("u1", expect.objectContaining({ snapshotDate: "2026-08-18" }));
    expect(upsertCohortSnapshot).toHaveBeenCalledWith("u1", expect.objectContaining({ generationMethod: "logic", modelId: null }));
  });

  it("prefers a valid LLM summary and records the model used", async () => {
    const upsertCohortSnapshot = vi.fn(async () => {});
    const generate = vi.fn(async () => ({
      summary: "客户整体活跃度保持稳定，潜客仍是当前主体。建议先处理到期跟进，并持续观察风险客户的变化。",
      modelId: "llm-primary",
    }));
    const service = serviceWith({
      listUsersMissingCohortSnapshot: vi.fn(async () => ["u1"]),
      listActiveProfilesForCohort: vi.fn(async () => []),
      upsertCohortSnapshot,
    }, {}, { generate });

    await service.runNightlyCohortSummaries(new Date("2026-08-18T15:01:00.000Z"));

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", snapshotDate: "2026-08-18" }));
    expect(upsertCohortSnapshot).toHaveBeenCalledWith("u1", expect.objectContaining({
      generationMethod: "llm",
      modelId: "llm-primary",
      summary: expect.stringContaining("到期跟进"),
    }));
  });

  it("immediately refreshes the cohort with the explicitly selected model", async () => {
    const upsertCohortSnapshot = vi.fn(async () => {});
    const generate = vi.fn(async () => ({
      summary: "当前客户整体活跃度稳定，潜客仍是主体。建议优先处理到期跟进，并持续观察风险变化。",
      modelId: "model-from-input",
    }));
    const service = serviceWith({
      listActiveProfilesForCohort: vi.fn(async () => []),
      upsertCohortSnapshot,
    }, {}, { generate });

    const cohort = await service.refreshCohortSummary(
      "u1",
      "model-from-input",
      new Date("2026-08-18T08:00:00.000Z")
    );

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      snapshotDate: "2026-08-18",
      modelId: "model-from-input",
    }));
    expect(upsertCohortSnapshot).toHaveBeenCalledWith("u1", expect.objectContaining({
      generationMethod: "llm",
      modelId: "model-from-input",
    }));
    expect(cohort).toMatchObject({ source: "nightly", modelId: "model-from-input" });
  });

  it("persists the deterministic summary when the LLM fails", async () => {
    const upsertCohortSnapshot = vi.fn(async () => {});
    const service = serviceWith({
      listUsersMissingCohortSnapshot: vi.fn(async () => ["u1"]),
      listActiveProfilesForCohort: vi.fn(async () => []),
      upsertCohortSnapshot,
    }, {}, { generate: vi.fn(async () => { throw new Error("upstream timeout"); }) });

    expect(await service.runNightlyCohortSummaries(new Date("2026-08-18T15:01:00.000Z"))).toBe(1);
    expect(upsertCohortSnapshot).toHaveBeenCalledWith("u1", expect.objectContaining({
      generationMethod: "logic",
      modelId: null,
      summary: expect.stringContaining("暂时还没有客户画像"),
    }));
  });
});
