import { Hono } from "hono";
import { parseEmployeeName } from "./employee-name.js";
import { apiError, InputError } from "./errors.js";
import { parseFocusInput } from "./focus.js";
import type { DigitalEmployeeService } from "./service.js";
import {
  parseManualObservation,
  parseCreateProfile,
  parseProfileList,
  parseUpdateProductState,
  parseUpdateProfile,
  parseVersion,
  parseArchiveProfile,
  parseEntityId,
} from "./validators.js";
import { parseScheduleInput, parseScheduleVersion } from "./schedule-validators.js";
import { parsePreferredChannels, parseWorkTone } from "./work-preferences.js";
import {
  parseMarketingBrandAssets,
  parseMarketingProduct,
  parseMarketingProductList,
  parseMarketingProductUpdate,
  parseProductImportCommit,
  parseProductImportStart,
} from "./marketing-validators.js";
import {
  parseActionResult,
  parseActionUpdate,
  parseCreateAction,
  parseOpportunityDecision,
  parseOpportunityList,
  parseOpportunitySettings,
} from "./opportunity-validators.js";
import {
  parseAssetList,
  parseAcquisitionLead,
  parseCampaignList,
  parseCampaignUpdate,
  parseCreateCampaign,
  parseCreateCampaignAsset,
  parseDeployment,
  parseFeedback,
  parseRecommendationFilter,
  parseRecommendationStatus,
  parseSegmentInput,
} from "./acquisition-validators.js";

type Variables = { userId: string };

/** Browser-facing, authenticated customer-profile API. */
export function createDigitalEmployeeRoutes(service: DigitalEmployeeService): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/settings", async (c) => {
    try { return c.json(await service.settings.get(c.get("userId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.put("/settings", async (c) => {
    try {
      const payload = await body(c);
      return c.json(await service.settings.save(c.get("userId"), {
        employeeName: parseEmployeeName(payload.employeeName),
        feishuReminder: payload.feishuReminder === true,
        desktopReminder: payload.desktopReminder === true,
        workTone: parseWorkTone(payload.workTone),
        preferredChannels: parsePreferredChannels(payload.preferredChannels),
        version: settingsVersion(payload.version),
      }));
    } catch (error) { return respondError(c, error); }
  });

  app.get("/today", async (c) => {
    try { return c.json(await service.today.get(c.get("userId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.get("/today/summary", async (c) => {
    try { return c.json(await service.today.summary(c.get("userId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.post("/today/brief/:id/read", async (c) => {
    try {
      await service.briefs.markRead(c.get("userId"), parseEntityId(c.req.param("id"), "briefId"));
      return c.json({ ok: true });
    } catch (error) { return respondError(c, error); }
  });

  app.get("/work-log/conversations/:id", async (c) => {
    try {
      return c.json(await service.workLog.conversation(c.get("userId"), parseEntityId(c.req.param("id"), "conversationId")));
    } catch (error) { return respondError(c, error); }
  });

  app.get("/schedules", async (c) => {
    try { return c.json(await service.schedules.list(c.get("userId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.post("/schedules", async (c) => {
    try { return c.json(await service.schedules.create(c.get("userId"), parseScheduleInput(await body(c))), 201); }
    catch (error) { return respondError(c, error); }
  });

  app.put("/schedules/:id", async (c) => {
    try {
      const payload = await body(c);
      return c.json(await service.schedules.update(c.get("userId"), parseEntityId(c.req.param("id"), "scheduleId"), {
        ...parseScheduleInput(payload), version: parseScheduleVersion(payload.version),
      }));
    } catch (error) { return respondError(c, error); }
  });

  app.delete("/schedules/:id", async (c) => {
    try {
      await service.schedules.remove(c.get("userId"), parseEntityId(c.req.param("id"), "scheduleId"));
      return c.json({ ok: true });
    } catch (error) { return respondError(c, error); }
  });

  app.get("/schedule-runs/:id", async (c) => {
    try { return c.json(await service.schedules.getRun(c.get("userId"), parseEntityId(c.req.param("id"), "runId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.post("/schedule-runs/:id/acknowledge", async (c) => {
    try {
      await service.schedules.acknowledge(c.get("userId"), parseEntityId(c.req.param("id"), "runId"));
      return c.json({ ok: true });
    } catch (error) { return respondError(c, error); }
  });

  app.post("/proposals/:id/confirm", async (c) => {
    try { return c.json(await service.proposals.confirm(c.get("userId"), parseEntityId(c.req.param("id"), "proposalId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.post("/proposals/:id/dismiss", async (c) => {
    try { return c.json(await service.proposals.dismiss(c.get("userId"), parseEntityId(c.req.param("id"), "proposalId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.get("/acquisition/segments", async (c) => {
    try { return c.json({ items: await service.customerAcquisition.listSegments(c.get("userId")) }); }
    catch (error) { return respondError(c, error); }
  });

  app.post("/acquisition/segments", async (c) => {
    try { return c.json(await service.customerAcquisition.createSegment(c.get("userId"), parseSegmentInput(await body(c))), 201); }
    catch (error) { return respondError(c, error); }
  });

  app.post("/acquisition/segments/:id/snapshots", async (c) => {
    try {
      return c.json(await service.customerAcquisition.snapshotSegment(
        c.get("userId"), parseEntityId(c.req.param("id"), "segmentId")
      ), 201);
    } catch (error) { return respondError(c, error); }
  });

  app.get("/acquisition/insights", async (c) => {
    try { return c.json(await service.customerAcquisition.getCohortInsights(c.get("userId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.get("/acquisition/recommendations", async (c) => {
    try { return c.json(await service.customerAcquisition.listRecommendations(c.get("userId"), parseRecommendationFilter(c.req.query("status")))); }
    catch (error) { return respondError(c, error); }
  });

  app.patch("/acquisition/recommendations/:id", async (c) => {
    try {
      return c.json(await service.customerAcquisition.updateRecommendation(
        c.get("userId"), parseEntityId(c.req.param("id"), "recommendationId"), parseRecommendationStatus(await body(c))
      ));
    } catch (error) { return respondError(c, error); }
  });

  app.get("/acquisition/model-configuration", async (c) => {
    try { return c.json(await service.customerAcquisition.getModelAvailability(c.get("userId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.get("/acquisition/assets", async (c) => {
    try { return c.json(await service.customerAcquisition.listAssets(c.get("userId"), parseAssetList(c.req.query()))); }
    catch (error) { return respondError(c, error); }
  });

  app.post("/acquisition/assets", async (c) => {
    try { return c.json(await service.customerAcquisition.createAsset(c.get("userId"), parseCreateCampaignAsset(await body(c))), 201); }
    catch (error) { return respondError(c, error); }
  });

  app.get("/acquisition/assets/:id", async (c) => {
    try { return c.json(await service.customerAcquisition.getAsset(c.get("userId"), parseEntityId(c.req.param("id"), "assetId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.delete("/acquisition/assets/:id", async (c) => {
    try { return c.json(await service.customerAcquisition.archiveAsset(c.get("userId"), parseEntityId(c.req.param("id"), "assetId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.put("/acquisition/assets/:id/deployments", async (c) => {
    try {
      return c.json(await service.customerAcquisition.saveDeployment(
        c.get("userId"), parseEntityId(c.req.param("id"), "assetId"), parseDeployment(await body(c))
      ));
    } catch (error) { return respondError(c, error); }
  });

  app.post("/acquisition/deployments/:id/feedback", async (c) => {
    try {
      return c.json(await service.customerAcquisition.addFeedback(
        c.get("userId"), parseEntityId(c.req.param("id"), "deploymentId"), parseFeedback(await body(c))
      ), 201);
    } catch (error) { return respondError(c, error); }
  });

  app.get("/acquisition/analytics", async (c) => {
    try { return c.json(await service.customerAcquisition.analytics(c.get("userId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.post("/acquisition/leads", async (c) => {
    try {
      const result = await service.returnAcquisitionLead(c.get("userId"), parseAcquisitionLead(await body(c)));
      return c.json(result, result.alreadyApplied ? 200 : 201);
    } catch (error) { return respondError(c, error); }
  });

  app.get("/acquisition/campaigns", async (c) => {
    try { return c.json(await service.customerAcquisition.listCampaigns(c.get("userId"), parseCampaignList(c.req.query()))); }
    catch (error) { return respondError(c, error); }
  });

  app.post("/acquisition/campaigns", async (c) => {
    try { return c.json(await service.customerAcquisition.createMarketingCampaign(c.get("userId"), parseCreateCampaign(await body(c))), 201); }
    catch (error) { return respondError(c, error); }
  });

  app.get("/acquisition/campaigns/:id", async (c) => {
    try { return c.json(await service.customerAcquisition.getCampaign(c.get("userId"), parseEntityId(c.req.param("id"), "campaignId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.patch("/acquisition/campaigns/:id", async (c) => {
    try {
      return c.json(await service.customerAcquisition.updateCampaign(
        c.get("userId"), parseEntityId(c.req.param("id"), "campaignId"), parseCampaignUpdate(await body(c))
      ));
    } catch (error) { return respondError(c, error); }
  });

  app.get("/acquisition/campaign-opportunities", async (c) => {
    try { return c.json(await service.customerAcquisition.listCampaignOpportunities(c.get("userId"), c.req.query("status"))); }
    catch (error) { return respondError(c, error); }
  });

  app.post("/acquisition/campaign-opportunities/:id/accept", async (c) => {
    try {
      return c.json(await service.customerAcquisition.acceptCampaignOpportunity(
        c.get("userId"), parseEntityId(c.req.param("id"), "opportunityId")
      ), 201);
    } catch (error) { return respondError(c, error); }
  });

  app.post("/acquisition/campaign-opportunities/:id/dismiss", async (c) => {
    try {
      return c.json(await service.customerAcquisition.dismissCampaignOpportunity(
        c.get("userId"), parseEntityId(c.req.param("id"), "opportunityId")
      ));
    } catch (error) { return respondError(c, error); }
  });

  app.get("/opportunities", async (c) => {
    try {
      return c.json(await service.opportunities.list(c.get("userId"), parseOpportunityList(c.req.query())));
    } catch (error) { return respondError(c, error); }
  });

  app.post("/opportunities/discover", async (c) => {
    try {
      return c.json(await service.opportunities.requestDiscovery(c.get("userId")), 202);
    } catch (error) { return respondError(c, error); }
  });

  app.patch("/opportunities/:id", async (c) => {
    try {
      return c.json(await service.opportunities.decide(c.get("userId"), parseEntityId(c.req.param("id"), "opportunityId"), parseOpportunityDecision(await body(c))));
    } catch (error) { return respondError(c, error); }
  });

  app.post("/actions", async (c) => {
    try {
      return c.json(await service.opportunities.createAction(c.get("userId"), parseCreateAction(await body(c))), 201);
    } catch (error) { return respondError(c, error); }
  });

  app.get("/actions/:id", async (c) => {
    try {
      return c.json(await service.opportunities.getAction(c.get("userId"), parseEntityId(c.req.param("id"), "actionId")));
    } catch (error) { return respondError(c, error); }
  });

  app.patch("/actions/:id", async (c) => {
    try {
      return c.json(await service.opportunities.updateAction(c.get("userId"), parseEntityId(c.req.param("id"), "actionId"), parseActionUpdate(await body(c))));
    } catch (error) { return respondError(c, error); }
  });

  app.post("/actions/:id/results", async (c) => {
    try {
      return c.json(await service.opportunities.addResult(c.get("userId"), parseEntityId(c.req.param("id"), "actionId"), parseActionResult(await body(c))), 201);
    } catch (error) { return respondError(c, error); }
  });

  app.get("/opportunity-settings", async (c) => {
    try { return c.json(await service.opportunities.getSettings(c.get("userId"))); }
    catch (error) { return respondError(c, error); }
  });

  app.put("/opportunity-settings", async (c) => {
    try { return c.json(await service.opportunities.saveSettings(c.get("userId"), parseOpportunitySettings(await body(c)))); }
    catch (error) { return respondError(c, error); }
  });

  app.get("/marketing/products", async (c) => {
    try {
      return c.json(await service.marketingMaterials.listProducts(c.get("userId"), parseMarketingProductList(c.req.query())));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/marketing/products", async (c) => {
    try {
      return c.json(await service.marketingMaterials.createProduct(c.get("userId"), parseMarketingProduct(await body(c))), 201);
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/marketing/products/:id", async (c) => {
    try {
      return c.json(await service.marketingMaterials.getProduct(c.get("userId"), parseEntityId(c.req.param("id"), "productId")));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.patch("/marketing/products/:id", async (c) => {
    try {
      return c.json(await service.marketingMaterials.updateProduct(
        c.get("userId"),
        parseEntityId(c.req.param("id"), "productId"),
        parseMarketingProductUpdate(await body(c))
      ));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.delete("/marketing/products/:id", async (c) => {
    try {
      const payload = await body(c);
      return c.json(await service.marketingMaterials.archiveProduct(
        c.get("userId"),
        parseEntityId(c.req.param("id"), "productId"),
        parseVersion(payload.version)
      ));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/marketing/products/:id/documents", async (c) => {
    try {
      return c.json(await service.productDocuments.list(c.get("userId"), parseEntityId(c.req.param("id"), "productId")));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/marketing/products/:id/documents", async (c) => {
    try {
      const payload = await body(c);
      return c.json(await service.productDocuments.add(c.get("userId"), parseEntityId(c.req.param("id"), "productId"), {
        assetId: parseEntityId(payload.assetId, "assetId"),
        title: typeof payload.title === "string" ? payload.title : undefined,
      }), 201);
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/marketing/products/:id/documents/:documentId/retry", async (c) => {
    try {
      return c.json(await service.productDocuments.retry(
        c.get("userId"), parseEntityId(c.req.param("id"), "productId"), parseEntityId(c.req.param("documentId"), "documentId")
      ));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.delete("/marketing/products/:id/documents/:documentId", async (c) => {
    try {
      await service.productDocuments.remove(
        c.get("userId"), parseEntityId(c.req.param("id"), "productId"), parseEntityId(c.req.param("documentId"), "documentId")
      );
      return c.json({ ok: true });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/marketing/products/:id/documents/:documentId/import", async (c) => {
    try {
      return c.json(await service.productImports.startFromDocument(
        c.get("userId"), parseEntityId(c.req.param("id"), "productId"), parseEntityId(c.req.param("documentId"), "documentId")
      ), 202);
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/marketing/imports", async (c) => {
    try {
      return c.json({ items: await service.productImports.list(c.get("userId")) });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/marketing/imports", async (c) => {
    try {
      return c.json(await service.productImports.start(c.get("userId"), parseProductImportStart(await body(c))), 202);
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/marketing/imports/:id", async (c) => {
    try {
      return c.json(await service.productImports.review(c.get("userId"), parseEntityId(c.req.param("id"), "importId")));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/marketing/imports/:id/retry", async (c) => {
    try {
      return c.json(await service.productImports.retry(c.get("userId"), parseEntityId(c.req.param("id"), "importId")), 202);
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.delete("/marketing/imports/:id", async (c) => {
    try {
      await service.productImports.discard(c.get("userId"), parseEntityId(c.req.param("id"), "importId"));
      return c.json({ ok: true });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/marketing/imports/drafts/:draftId/commit", async (c) => {
    try {
      return c.json(await service.productImports.commit(
        c.get("userId"), parseEntityId(c.req.param("draftId"), "draftId"), parseProductImportCommit(await body(c))
      ));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/marketing/brand-assets", async (c) => {
    try {
      return c.json(await service.marketingMaterials.getBrandAssets(c.get("userId")));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.put("/marketing/brand-assets", async (c) => {
    try {
      return c.json(await service.marketingMaterials.saveBrandAssets(c.get("userId"), parseMarketingBrandAssets(await body(c))));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.put("/conversation-context/:conversationId", async (c) => {
    try {
      return c.json(await service.setConversationFocus(
        c.get("userId"),
        parseEntityId(c.req.param("conversationId"), "conversationId"),
        parseFocusInput(await body(c))
      ));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.delete("/conversation-context/:conversationId", async (c) => {
    try {
      await service.clearCurrentProfile(
        c.get("userId"),
        parseEntityId(c.req.param("conversationId"), "conversationId")
      );
      return c.json({ ok: true });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/overview", async (c) => {
    try {
      return c.json(await service.getOverview(c.get("userId")));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.put("/overview/schedule", async (c) => {
    try {
      const payload = await body(c);
      if (typeof payload.enabled !== "boolean") throw new InputError("enabled格式无效");
      if (typeof payload.version !== "number" || !Number.isInteger(payload.version) || payload.version < 0) {
        throw new InputError("version无效");
      }
      return c.json(await service.saveCohortSchedule(c.get("userId"), {
        enabled: payload.enabled,
        version: payload.version,
      }));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/profiles", async (c) => {
    try {
      return c.json(await service.listProfiles(c.get("userId"), parseProfileList(c.req.query())));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/profiles", async (c) => {
    try {
      return c.json(await service.createProfile(c.get("userId"), parseCreateProfile(await body(c))), 201);
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/profiles/:id/work", async (c) => {
    try {
      return c.json(await service.opportunities.getCustomerBusinessContext(c.get("userId"), parseEntityId(c.req.param("id"), "profileId")));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/profiles/:id/timeline", async (c) => {
    try {
      const profileId = parseEntityId(c.req.param("id"), "profileId");
      const [observations, changes] = await Promise.all([
        service.listObservations(c.get("userId"), profileId, 1, 50),
        service.listStateChanges(c.get("userId"), profileId, 1, 50),
      ]);
      return c.json({ observations: observations.items, changes: changes.items });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/profiles/:id/observations", async (c) => {
    try {
      return c.json(
        await service.listObservations(
          c.get("userId"),
          parseEntityId(c.req.param("id"), "profileId"),
          pagination(c.req.query("page"), "page", 1, 100_000, 1),
          pagination(c.req.query("limit"), "limit", 1, 100, 30)
        )
      );
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/profiles/:id/observations", async (c) => {
    try {
      return c.json(
        await service.addManualObservation(c.get("userId"), parseEntityId(c.req.param("id"), "profileId"), parseManualObservation(await body(c))),
        201
      );
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/profiles/:id/changes", async (c) => {
    try {
      return c.json(
        await service.listStateChanges(
          c.get("userId"),
          parseEntityId(c.req.param("id"), "profileId"),
          pagination(c.req.query("page"), "page", 1, 100_000, 1),
          pagination(c.req.query("limit"), "limit", 1, 100, 30)
        )
      );
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.patch("/profiles/:id/products/:productKey", async (c) => {
    try {
      const productKey = c.req.param("productKey").trim();
      if (!productKey || productKey.length > 160) throw new InputError("productKey无效");
      return c.json(
        await service.updateProductState(
          c.get("userId"),
          parseEntityId(c.req.param("id"), "profileId"),
          productKey,
          parseUpdateProductState(await body(c))
        )
      );
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.get("/profiles/:id", async (c) => {
    try {
      return c.json(await service.getProfile(c.get("userId"), parseEntityId(c.req.param("id"), "profileId")));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.patch("/profiles/:id", async (c) => {
    try {
      return c.json(
        await service.updateProfile(c.get("userId"), parseEntityId(c.req.param("id"), "profileId"), parseUpdateProfile(await body(c)))
      );
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.delete("/profiles/:id", async (c) => {
    try {
      const payload = parseArchiveProfile(await body(c));
      return c.json(await service.archiveProfile(
        c.get("userId"),
        parseEntityId(c.req.param("id"), "profileId"),
        payload.version,
        payload.onOpenTasks,
      ));
    } catch (error) {
      return respondError(c, error);
    }
  });

  return app;
}

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => {
    throw new InputError("请求体必须是JSON对象");
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("请求体必须是JSON对象");
  return value as Record<string, unknown>;
}

/** 0 is the version of settings that were never saved. */
function settingsVersion(value: unknown): number {
  return value === 0 ? 0 : parseVersion(value);
}

function pagination(value: string | undefined, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new InputError(`${label}无效`);
  return number;
}

function respondError(c: { json: (body: unknown, status?: number) => Response }, error: unknown): Response {
  const result = apiError(error);
  return c.json(result.body, result.status);
}
