import { randomUUID } from "node:crypto";
import type { DB } from "../db/database.js";
import type { JobQueue } from "@lot-agent/core";
import { ConflictError, InputError, NotFoundError, QuotaError } from "./errors.js";
import {
  CAMPAIGN_IMAGE_MODEL,
  CAMPAIGN_VIDEO_MODEL,
  type AssetListFilters,
  type CampaignContentGenerator,
  type CampaignModelResolver,
  type CampaignRecommendationDraft,
  type CreateCampaignAssetInput,
  type DeploymentInput,
  type FeedbackInput,
  type SegmentCriteria,
  type SegmentInput,
  type SegmentMetrics,
} from "./acquisition-types.js";

const CREATION_PROMPT_VERSION = "customer-acquisition-creative/v1";

interface SegmentMemberRow {
  id: string;
  display_name: string;
  relationship_stage: string;
  overall_health: string;
  customer_region: string | null;
  tags: string[];
  last_observed_at: string | Date | null;
  last_contact_at: string | Date | null;
  updated_at: string | Date;
  product_states: Array<{
    productName?: string;
    journeyStage?: string;
    health?: string;
    needs?: unknown[];
    objections?: unknown[];
  }>;
}

/** Business service for 获客宝. All model inputs are aggregate cohort metrics
 * plus approved marketing facts; individual profile names never leave here. */
export class CustomerAcquisitionService {
  constructor(
    private readonly db: DB,
    private readonly queue?: JobQueue,
    private readonly contentGenerator?: CampaignContentGenerator,
    private readonly modelResolver?: CampaignModelResolver,
  ) {}

  async listSegments(userId: string) {
    const { rows } = await this.db.pool.query(
      `SELECT segment.*,
              snapshot.id AS snapshot_id, snapshot.metrics AS snapshot_metrics,
              snapshot.sampled_at AS snapshot_sampled_at
       FROM de_customer_segments segment
       LEFT JOIN LATERAL (
         SELECT id, metrics, sampled_at FROM de_customer_segment_snapshots
         WHERE user_id = segment.user_id AND segment_id = segment.id
         ORDER BY created_at DESC LIMIT 1
       ) snapshot ON true
       WHERE segment.user_id = $1 AND segment.status = 'active'
       ORDER BY segment.updated_at DESC, segment.id DESC`,
      [userId]
    );
    return rows.map(toSegment);
  }

  async createSegment(userId: string, input: SegmentInput) {
    const id = randomUUID();
    try {
      const { rows } = await this.db.pool.query(
        `INSERT INTO de_customer_segments (id,user_id,name,description,criteria)
         VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
        [id, userId, input.name, input.description ?? "", JSON.stringify(input.criteria)]
      );
      const snapshot = await this.snapshotSegment(userId, id);
      return { ...toSegment(rows[0]), latestSnapshot: snapshot };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError("已有同名客群");
      throw error;
    }
  }

  async previewSegment(userId: string, criteria: SegmentCriteria) {
    const { included, excluded } = await this.selectMembers(userId, criteria);
    return cohortView(included, excluded);
  }

  async snapshotSegment(userId: string, segmentId: string) {
    const segment = await this.getSegment(userId, segmentId);
    const { included, excluded } = await this.selectMembers(userId, segment.criteria);
    const view = cohortView(included, excluded);
    const id = randomUUID();
    const { rows } = await this.db.pool.query(
      `INSERT INTO de_customer_segment_snapshots
         (id,user_id,segment_id,audience_description,criteria,profile_ids,excluded_profile_ids,metrics)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::uuid[],$7::uuid[],$8::jsonb) RETURNING *`,
      [
        id, userId, segmentId, segment.description || segment.name,
        JSON.stringify(segment.criteria), included.map((row) => row.id), excluded.map((row) => row.id),
        JSON.stringify(view.metrics),
      ]
    );
    return { ...toSnapshot(rows[0]), memberPreview: view.memberPreview };
  }

  async getCohortInsights(userId: string) {
    const [snapshot, segments] = await Promise.all([
      this.db.pool.query(
        `SELECT snapshot_date,summary,metrics,generated_at,generation_method,model_id
         FROM de_customer_cohort_snapshots WHERE user_id=$1 ORDER BY snapshot_date DESC LIMIT 1`,
        [userId]
      ),
      this.listSegments(userId),
    ]);
    return {
      overall: snapshot.rows[0] ? {
        snapshotDate: dateOnly(snapshot.rows[0].snapshot_date), summary: snapshot.rows[0].summary,
        metrics: snapshot.rows[0].metrics ?? {}, generatedAt: iso(snapshot.rows[0].generated_at),
        generationMethod: snapshot.rows[0].generation_method ?? "logic", modelId: snapshot.rows[0].model_id ?? null,
      } : null,
      segments,
    };
  }

  async listRecommendations(userId: string, status?: string) {
    await this.db.pool.query(
      `UPDATE de_daily_recommendations SET status='expired'
       WHERE user_id=$1 AND status='pending' AND expires_at <= now()`, [userId]
    );
    const params: unknown[] = [userId];
    const where = ["recommendation.user_id=$1"];
    if (status) { params.push(status); where.push(`recommendation.status=$${params.length}`); }
    const [{ rows }, latest] = await Promise.all([this.db.pool.query(
      `SELECT recommendation.*, segment.name AS segment_name, product.name AS product_name
       FROM de_daily_recommendations recommendation
       LEFT JOIN de_customer_segments segment ON segment.id=recommendation.segment_id AND segment.user_id=recommendation.user_id
       LEFT JOIN marketing_products product ON product.id=recommendation.product_id AND product.user_id=recommendation.user_id
       WHERE ${where.join(" AND ")}
       ORDER BY recommendation.recommendation_date DESC, recommendation.generated_at DESC`, params
    ), this.db.pool.query(`SELECT max(generated_at) AS generated_at FROM de_daily_recommendations WHERE user_id=$1`, [userId])]);
    return { items: rows.map(toRecommendation), generatedAt: latest.rows[0]?.generated_at ? iso(latest.rows[0].generated_at) : null };
  }

  async refreshRecommendations(userId: string) {
    const [insights, productsResult, brandResult] = await Promise.all([
      this.getCohortInsights(userId),
      this.db.pool.query(
        `SELECT id,name,positioning,core_values,verifiable_facts,current_benefits,common_objections,prohibited_expressions,version
         FROM marketing_products WHERE user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 20`, [userId]
      ),
      this.db.pool.query(`SELECT tone,standard_calls_to_action,version FROM marketing_brand_assets WHERE user_id=$1`, [userId]),
    ]);
    if (!productsResult.rows.length) throw new InputError("请先在营销资料中维护至少一个有效产品");
    const safeSegments = insights.segments.map((segment) => ({
      id: segment.id, name: segment.name, description: segment.description,
      metrics: segment.latestSnapshot?.metrics ?? {},
    }));
    const safeProducts = productsResult.rows.map(marketingProductSnapshot);
    let drafts: CampaignRecommendationDraft[];
    if (this.contentGenerator) {
      try {
        const generated = await this.contentGenerator.recommend({
          userId,
          cohort: insights.overall ? { summary: insights.overall.summary, metrics: insights.overall.metrics } : {},
          segments: safeSegments,
          products: safeProducts,
          brand: brandResult.rows[0] ?? null,
        });
        drafts = generated.recommendations;
      } catch {
        drafts = fallbackRecommendations(safeSegments, safeProducts);
      }
    } else {
      drafts = fallbackRecommendations(safeSegments, safeProducts);
    }
    drafts = normalizeRecommendationMix(drafts).slice(0, 7);
    if (!drafts.length) drafts = fallbackRecommendations(safeSegments, safeProducts);
    const recommendationDate = shanghaiDate(new Date());
    for (const draft of drafts) {
      const segmentId = safeSegments.some((item) => item.id === draft.segmentId) ? draft.segmentId : null;
      const productId = safeProducts.some((item) => item.id === draft.productId) ? draft.productId : safeProducts[0]?.id ?? null;
      await this.db.pool.query(
        `INSERT INTO de_daily_recommendations
           (id,user_id,recommendation_date,recommendation_type,segment_id,product_id,target_segment_description,
            theme,core_points,suggested_channels,reasoning,creative_direction,duration_seconds,status,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,'pending',now()+interval '7 days')
         ON CONFLICT (user_id,recommendation_date,recommendation_type,theme) DO UPDATE SET
           segment_id=EXCLUDED.segment_id, product_id=EXCLUDED.product_id,
           target_segment_description=EXCLUDED.target_segment_description, core_points=EXCLUDED.core_points,
           suggested_channels=EXCLUDED.suggested_channels, reasoning=EXCLUDED.reasoning,
           creative_direction=EXCLUDED.creative_direction, duration_seconds=EXCLUDED.duration_seconds,
           status='pending', generated_at=now(), expires_at=now()+interval '7 days'`,
        [
          randomUUID(), userId, recommendationDate, draft.type, segmentId, productId,
          draft.targetSegmentDescription, draft.theme, JSON.stringify(draft.corePoints),
          JSON.stringify(draft.suggestedChannels), JSON.stringify(draft.reasoning),
          draft.creativeDirection ?? "", draft.durationSeconds ?? null,
        ]
      );
    }
    return this.listRecommendations(userId, "pending");
  }

  async updateRecommendation(userId: string, id: string, status: "adopted" | "ignored") {
    const { rows } = await this.db.pool.query(
      `UPDATE de_daily_recommendations SET status=$3
       WHERE id=$1 AND user_id=$2 AND status='pending' AND expires_at>now() RETURNING *`,
      [id, userId, status]
    );
    if (!rows[0]) throw new NotFoundError("推荐不存在或已处理");
    return toRecommendation(rows[0]);
  }

  async getModelAvailability(userId: string) {
    return this.modelResolver?.get(userId) ?? {
      image: false, video: false, imageModelId: null, videoModelId: null,
      configurationUrl: "https://tokenhub.todoucloud.com",
    };
  }

  async createAsset(userId: string, input: CreateCampaignAssetInput) {
    const productResult = await this.db.pool.query(
      `SELECT * FROM marketing_products WHERE id=$1 AND user_id=$2 AND status='active'`,
      [input.productId, userId]
    );
    const product = productResult.rows[0];
    if (!product) throw new NotFoundError("未找到可用的产品资料");
    if (input.parentAssetId) {
      const parent = await this.db.pool.query(
        `SELECT id FROM de_marketing_asset_library WHERE id=$1 AND user_id=$2 AND status<>'archived'`,
        [input.parentAssetId, userId]
      );
      if (!parent.rows[0]) throw new NotFoundError("未找到可复用的营销资产");
    }
    const isPoster = input.assetType === "poster";
    let mediaModelId: string | null = null;
    if (input.assetType !== "copy") {
      if (!this.queue) throw new InputError("生成任务队列不可用");
      const availability = await this.getModelAvailability(userId);
      if (isPoster && !availability.image) throw new InputError(`请先在灵渠 TokenHub 配置 ${CAMPAIGN_IMAGE_MODEL}`);
      if (!isPoster && !availability.video) throw new InputError(`请先在灵渠 TokenHub 配置 ${CAMPAIGN_VIDEO_MODEL}`);
      mediaModelId = isPoster ? availability.imageModelId! : availability.videoModelId!;
      const quota = await this.modelResolver?.checkQuota?.({
        userId,
        mediaType: isPoster ? "image" : "video",
        modelId: mediaModelId,
        outputCount: isPoster ? 1 : input.durationSeconds ?? 15,
      });
      if (quota && !quota.ok) throw new QuotaError(quota.reason);
    }
    const snapshot = await this.resolveSnapshot(userId, input);
    const brand = (await this.db.pool.query(`SELECT * FROM marketing_brand_assets WHERE user_id=$1`, [userId])).rows[0] ?? null;
    const campaignId = input.campaignId
      ? await this.assertCampaign(userId, input.campaignId)
      : await this.createCampaign(userId, input, snapshot.id, product.id);
    const brief = buildBrief(input, snapshot, product, brand);
    await this.upsertBrief(userId, campaignId, brief, Number(product.version));

    const source = input.parentAssetId ? "reuse" : input.recommendationId ? "recommendation" : "workspace";
    const title = input.title || `${product.name} · ${input.assetType === "copy" ? "营销文案" : input.assetType === "poster" ? "营销海报" : "营销视频"}`;
    if (input.assetType === "copy") {
      let generated = {
        title,
        content: fallbackCopy(input, snapshot, product),
        modelId: "logic-fallback",
      };
      if (this.contentGenerator) {
        try {
          generated = await this.contentGenerator.createCopy({ userId, prompt: input.prompt, brief });
        } catch {
          // A usable, fact-bound draft is preferable to losing the whole brief.
        }
      }
      const assetId = randomUUID();
      await this.db.pool.query(
        `INSERT INTO de_marketing_asset_library
           (id,user_id,campaign_id,segment_snapshot_id,parent_asset_id,asset_type,title,content,source,model_id,generation_status,status)
         VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9,'ready','ready')`,
        [assetId, userId, campaignId, snapshot.id, input.parentAssetId ?? null, generated.title || title, generated.content, source, generated.modelId]
      );
      await this.db.pool.query(
        `INSERT INTO de_campaign_generation_runs
           (id,user_id,campaign_id,asset_id,model_id,input_snapshot,prompt_version,status,finished_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'succeeded',now())`,
        [randomUUID(), userId, campaignId, assetId, generated.modelId, JSON.stringify(brief), CREATION_PROMPT_VERSION]
      );
      await this.adoptIfNeeded(userId, input.recommendationId);
      return this.getAsset(userId, assetId);
    }

    const modelId = mediaModelId!;
    const mediaPrompt = campaignMediaPrompt(input, snapshot, product, brand, isPoster ? "poster" : "video");
    const taskId = await this.queue.enqueue(
      isPoster ? "image.generate" : "video.generate",
      isPoster
        ? { prompt: mediaPrompt, modelId, size: "1024x1024", n: 1, featureScope: "customer-acquisition", campaignId }
        : { prompt: mediaPrompt, modelId, durationSec: input.durationSeconds ?? 15, ratio: "16:9", featureScope: "customer-acquisition", campaignId },
      userId
    );
    const assetId = randomUUID();
    await this.db.pool.query(
      `INSERT INTO de_marketing_asset_library
         (id,user_id,campaign_id,segment_snapshot_id,parent_asset_id,task_id,asset_type,title,source,model_id,generation_status,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending','draft')`,
      [assetId, userId, campaignId, snapshot.id, input.parentAssetId ?? null, taskId, isPoster ? "poster" : "video", title, source, modelId]
    );
    await this.db.pool.query(
      `INSERT INTO de_campaign_generation_runs
         (id,user_id,campaign_id,asset_id,task_id,model_id,input_snapshot,prompt_version,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'running')`,
      [randomUUID(), userId, campaignId, assetId, taskId, modelId, JSON.stringify(brief), CREATION_PROMPT_VERSION]
    );
    await this.adoptIfNeeded(userId, input.recommendationId);
    return this.getAsset(userId, assetId);
  }

  async listAssets(userId: string, filters: AssetListFilters) {
    await this.syncGeneratedAssets(userId);
    const params: unknown[] = [userId];
    const where = ["asset.user_id=$1", "asset.status<>'archived'"];
    const days = filters.range === "3d" ? 3 : filters.range === "7d" ? 7 : filters.range === "30d" ? 30 : null;
    if (days) { params.push(days); where.push(`asset.created_at >= now() - make_interval(days => $${params.length}::int)`); }
    if (filters.assetType) { params.push(filters.assetType); where.push(`asset.asset_type=$${params.length}`); }
    const whereSql = where.join(" AND ");
    const count = await this.db.pool.query(`SELECT count(*)::int AS total FROM de_marketing_asset_library asset WHERE ${whereSql}`, params);
    params.push(filters.limit, (filters.page - 1) * filters.limit);
    const { rows } = await this.db.pool.query(
      `${assetSelect()} WHERE ${whereSql}
       ORDER BY asset.created_at DESC, asset.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return {
      items: rows.map(toAsset), total: Number(count.rows[0]?.total ?? 0),
      page: filters.page, limit: filters.limit,
    };
  }

  async getAsset(userId: string, assetId: string) {
    await this.syncGeneratedAssets(userId, assetId);
    const { rows } = await this.db.pool.query(
      `${assetSelect()} WHERE asset.id=$1 AND asset.user_id=$2`, [assetId, userId]
    );
    if (!rows[0]) throw new NotFoundError("未找到营销资产");
    return toAsset(rows[0]);
  }

  async archiveAsset(userId: string, assetId: string) {
    const { rows } = await this.db.pool.query(
      `UPDATE de_marketing_asset_library SET status='archived'
       WHERE id=$1 AND user_id=$2 AND status<>'archived' RETURNING id,task_id,generation_status`, [assetId, userId]
    );
    if (!rows[0]) throw new NotFoundError("未找到营销资产");
    if (rows[0].task_id && ["pending", "running"].includes(rows[0].generation_status)) {
      await this.queue?.cancel(rows[0].task_id).catch(() => false);
    }
    return { assetId, status: "archived" as const };
  }

  async saveDeployment(userId: string, assetId: string, input: DeploymentInput) {
    await this.getAsset(userId, assetId);
    const custom = input.platform === "other" ? input.customPlatform ?? "" : "";
    const { rows } = await this.db.pool.query(
      `INSERT INTO de_asset_deployments
         (id,user_id,asset_id,platform,custom_platform,deployed_at,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$2)
       ON CONFLICT (user_id,asset_id,platform,custom_platform) DO UPDATE SET
         deployed_at=EXCLUDED.deployed_at,status=EXCLUDED.status
       RETURNING *`,
      [randomUUID(), userId, assetId, input.platform, custom, input.deployedAt ?? null, input.status]
    );
    return toDeployment(rows[0]);
  }

  async addFeedback(userId: string, deploymentId: string, input: FeedbackInput) {
    const deployment = await this.db.pool.query(
      `SELECT id FROM de_asset_deployments WHERE id=$1 AND user_id=$2`, [deploymentId, userId]
    );
    if (!deployment.rows[0]) throw new NotFoundError("未找到投放记录");
    const { rows } = await this.db.pool.query(
      `INSERT INTO de_deployment_feedback
         (id,user_id,deployment_id,impressions,interactions,conversions,feedback_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), userId, deploymentId, input.impressions ?? null, input.interactions ?? null,
        input.conversions ?? null, input.feedbackText ?? ""]
    );
    return toFeedback(rows[0]);
  }

  async analytics(userId: string) {
    await this.syncGeneratedAssets(userId);
    const [assets, deployment, platform] = await Promise.all([
      this.db.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE asset_type='text')::int AS text,
                count(*) FILTER (WHERE asset_type IN ('poster','image'))::int AS image,
                count(*) FILTER (WHERE asset_type='video')::int AS video,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM de_asset_deployments d WHERE d.asset_id=a.id AND d.status IN ('deployed','ended')))::int AS deployed
         FROM de_marketing_asset_library a WHERE user_id=$1 AND status<>'archived'`, [userId]
      ),
      this.db.pool.query(
        `SELECT COALESCE(sum(f.impressions),0)::bigint AS impressions,
                COALESCE(sum(f.interactions),0)::bigint AS interactions,
                COALESCE(sum(f.conversions),0)::bigint AS conversions,
                count(DISTINCT d.id)::int AS deployments,
                count(DISTINCT f.id)::int AS feedback_count
         FROM de_asset_deployments d LEFT JOIN de_deployment_feedback f ON f.deployment_id=d.id
         WHERE d.user_id=$1`, [userId]
      ),
      this.db.pool.query(
        `SELECT d.platform,d.custom_platform,count(DISTINCT d.id)::int AS deployments,
                COALESCE(sum(f.impressions),0)::bigint AS impressions,
                COALESCE(sum(f.interactions),0)::bigint AS interactions,
                COALESCE(sum(f.conversions),0)::bigint AS conversions
         FROM de_asset_deployments d LEFT JOIN de_deployment_feedback f ON f.deployment_id=d.id
         WHERE d.user_id=$1 GROUP BY d.platform,d.custom_platform ORDER BY conversions DESC,impressions DESC`, [userId]
      ),
    ]);
    const a = assets.rows[0] ?? {};
    const d = deployment.rows[0] ?? {};
    return {
      assets: { total: Number(a.total ?? 0), text: Number(a.text ?? 0), image: Number(a.image ?? 0), video: Number(a.video ?? 0), deployed: Number(a.deployed ?? 0) },
      totals: { deployments: Number(d.deployments ?? 0), feedbackCount: Number(d.feedback_count ?? 0), impressions: Number(d.impressions ?? 0), interactions: Number(d.interactions ?? 0), conversions: Number(d.conversions ?? 0) },
      platforms: platform.rows.map((row) => ({
        platform: row.platform, customPlatform: row.custom_platform || null,
        deployments: Number(row.deployments), impressions: Number(row.impressions),
        interactions: Number(row.interactions), conversions: Number(row.conversions),
      })),
    };
  }

  private async getSegment(userId: string, id: string) {
    const { rows } = await this.db.pool.query(
      `SELECT * FROM de_customer_segments WHERE id=$1 AND user_id=$2 AND status='active'`, [id, userId]
    );
    if (!rows[0]) throw new NotFoundError("未找到该客群");
    return toSegment(rows[0]);
  }

  private async selectMembers(userId: string, criteria: SegmentCriteria) {
    const { rows } = await this.db.pool.query(
      `SELECT profile.id,profile.display_name,profile.relationship_stage,profile.overall_health,
              profile.customer_region,profile.tags,profile.last_observed_at,profile.last_contact_at,profile.updated_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'productName',state.product_name,'journeyStage',state.journey_stage,'health',state.health,
                'needs',state.needs,'objections',state.objections
              )) FILTER (WHERE state.id IS NOT NULL),'[]'::jsonb) AS product_states
       FROM de_customer_profiles profile
       LEFT JOIN de_customer_product_states state ON state.profile_id=profile.id AND state.user_id=profile.user_id
       WHERE profile.user_id=$1 AND profile.status='active'
       GROUP BY profile.id`, [userId]
    );
    const included: SegmentMemberRow[] = [];
    const excluded: SegmentMemberRow[] = [];
    for (const row of rows as SegmentMemberRow[]) {
      if (!matchesCriteria(row, criteria)) continue;
      if (excludedBySafety(row, criteria)) excluded.push(row);
      else included.push(row);
    }
    return { included, excluded };
  }

  private async resolveSnapshot(userId: string, input: CreateCampaignAssetInput) {
    if (input.segmentSnapshotId) {
      const { rows } = await this.db.pool.query(
        `SELECT * FROM de_customer_segment_snapshots WHERE id=$1 AND user_id=$2`, [input.segmentSnapshotId, userId]
      );
      if (!rows[0]) throw new NotFoundError("未找到客群快照");
      return toSnapshot(rows[0]);
    }
    if (input.segmentId) return this.snapshotSegment(userId, input.segmentId);
    const id = randomUUID();
    const metrics: SegmentMetrics = {
      totalProfiles: 0, excludedProfiles: 0, relationshipStages: [], health: [], regions: [], journeyStages: [],
      commonNeeds: [], commonObjections: [], topTags: [], warnings: ["公开受众未绑定客户名单，请在投放前人工确认受众范围。"],
    };
    const { rows } = await this.db.pool.query(
      `INSERT INTO de_customer_segment_snapshots (id,user_id,audience_description,criteria,metrics)
       VALUES ($1,$2,$3,'{}'::jsonb,$4::jsonb) RETURNING *`,
      [id, userId, input.publicAudience!, JSON.stringify(metrics)]
    );
    return toSnapshot(rows[0]);
  }

  private async createCampaign(userId: string, input: CreateCampaignAssetInput, snapshotId: string, productId: string) {
    const id = randomUUID();
    await this.db.pool.query(
      `INSERT INTO de_marketing_campaigns
         (id,user_id,segment_snapshot_id,product_id,name,objective,channels,call_to_action)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, userId, snapshotId, productId, input.title || input.prompt.slice(0, 80), input.objective, input.channels, input.callToAction]
    );
    return id;
  }

  private async assertCampaign(userId: string, campaignId: string) {
    const result = await this.db.pool.query(`SELECT id FROM de_marketing_campaigns WHERE id=$1 AND user_id=$2`, [campaignId, userId]);
    if (!result.rows[0]) throw new NotFoundError("未找到营销活动");
    return campaignId;
  }

  private async upsertBrief(userId: string, campaignId: string, brief: Record<string, unknown>, productVersion: number) {
    await this.db.pool.query(
      `INSERT INTO de_campaign_briefs (id,user_id,campaign_id,snapshot,product_version,brief)
       VALUES ($1,$2,$3,$4::jsonb,$5,$4::jsonb)
       ON CONFLICT (campaign_id) DO UPDATE SET brief=EXCLUDED.brief,snapshot=EXCLUDED.snapshot,
         product_version=EXCLUDED.product_version,version=de_campaign_briefs.version+1`,
      [randomUUID(), userId, campaignId, JSON.stringify(brief), productVersion]
    );
  }

  private async adoptIfNeeded(userId: string, recommendationId?: string) {
    if (!recommendationId) return;
    await this.db.pool.query(
      `UPDATE de_daily_recommendations SET status='adopted'
       WHERE id=$1 AND user_id=$2 AND status='pending'`, [recommendationId, userId]
    );
  }

  private async syncGeneratedAssets(userId: string, assetId?: string) {
    const params: unknown[] = [userId];
    const target = assetId ? (params.push(assetId), ` AND asset.id=$${params.length}`) : "";
    await this.db.pool.query(
      `UPDATE de_marketing_asset_library asset SET
         generation_status=CASE
           WHEN task.status='succeeded' AND COALESCE((task.output->>'downloadFailed')::boolean,false)=false THEN 'ready'
           WHEN task.status='succeeded' OR task.status='failed' THEN 'failed'
           WHEN task.status='cancelled' THEN 'cancelled'
           WHEN task.status='running' THEN 'running'
           ELSE asset.generation_status END,
         status=CASE
           WHEN task.status='succeeded' AND COALESCE((task.output->>'downloadFailed')::boolean,false)=false THEN 'ready'
           ELSE asset.status END,
         file_url=COALESCE(task.output #>> '{assets,0,url}',asset.file_url)
       FROM tasks task
       WHERE asset.task_id=task.id AND asset.user_id=$1${target}`, params
    );
    await this.db.pool.query(
      `UPDATE de_campaign_generation_runs run SET
         status=CASE WHEN task.status='succeeded' AND COALESCE((task.output->>'downloadFailed')::boolean,false)=false THEN 'succeeded'
                     WHEN task.status='cancelled' THEN 'cancelled'
                     WHEN task.status IN ('succeeded','failed') THEN 'failed' ELSE run.status END,
         error=CASE WHEN task.status='failed' THEN task.error
                    WHEN COALESCE((task.output->>'downloadFailed')::boolean,false) THEN task.output->>'error' ELSE run.error END,
         finished_at=CASE WHEN task.status IN ('succeeded','failed','cancelled') THEN COALESCE(run.finished_at,now()) ELSE run.finished_at END
       FROM tasks task WHERE run.task_id=task.id AND run.user_id=$1`, [userId]
    );
  }
}

function matchesCriteria(row: SegmentMemberRow, criteria: SegmentCriteria): boolean {
  if (criteria.relationshipStages?.length && !criteria.relationshipStages.includes(row.relationship_stage)) return false;
  if (criteria.health?.length && !criteria.health.includes(row.overall_health)) return false;
  if (criteria.regions?.length && !criteria.regions.some((region) => row.customer_region?.includes(region))) return false;
  if (criteria.tags?.length && !criteria.tags.every((tag) => row.tags.includes(tag))) return false;
  if (criteria.journeyStages?.length && !row.product_states.some((state) => state.journeyStage && criteria.journeyStages!.includes(state.journeyStage))) return false;
  if (criteria.productName && !row.product_states.some((state) => state.productName?.includes(criteria.productName!))) return false;
  if (criteria.activeWithinDays) {
    const activity = new Date(row.last_observed_at ?? row.updated_at).getTime();
    if (activity < Date.now() - criteria.activeWithinDays * 86_400_000) return false;
  }
  return true;
}

function excludedBySafety(row: SegmentMemberRow, criteria: SegmentCriteria): boolean {
  if (criteria.excludeAtRisk && (row.overall_health === "at_risk" || row.product_states.some((state) => state.health === "at_risk"))) return true;
  if (criteria.excludeRecentlyContactedDays && row.last_contact_at) {
    return new Date(row.last_contact_at).getTime() >= Date.now() - criteria.excludeRecentlyContactedDays * 86_400_000;
  }
  return false;
}

function cohortView(included: SegmentMemberRow[], excluded: SegmentMemberRow[]) {
  const relationshipStages = counts(included.map((row) => row.relationship_stage));
  const health = counts(included.map((row) => row.overall_health));
  const regions = counts(included.map((row) => row.customer_region).filter(Boolean) as string[]);
  const journeyStages = counts(included.flatMap((row) => row.product_states.map((state) => state.journeyStage).filter(Boolean) as string[]));
  const needs = counts(included.flatMap((row) => row.product_states.flatMap((state) => strings(state.needs))));
  const objections = counts(included.flatMap((row) => row.product_states.flatMap((state) => strings(state.objections))));
  const tags = counts(included.flatMap((row) => row.tags));
  const warnings: string[] = [];
  if (included.length < 3) warnings.push("样本少于3人，群像结论可能不稳定。");
  if (included.length > 3 && (relationshipStages[0]?.count ?? 0) / included.length < 0.5) warnings.push("客群差异较大，建议按关系阶段拆分后再创作。");
  if (excluded.length) warnings.push(`已按风险与触达频率规则排除 ${excluded.length} 人。`);
  const metrics: SegmentMetrics = {
    totalProfiles: included.length, excludedProfiles: excluded.length,
    relationshipStages, health, regions, journeyStages,
    commonNeeds: needs.slice(0, 8), commonObjections: objections.slice(0, 8), topTags: tags.slice(0, 8), warnings,
  };
  return {
    metrics,
    memberPreview: included.slice(0, 8).map((row) => ({
      id: row.id, displayName: row.display_name, relationshipStage: row.relationship_stage,
      health: row.overall_health, region: row.customer_region,
    })),
  };
}

function counts(values: string[]) {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return [...map.entries()].map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, "zh-CN"));
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" ? [item] : item && typeof item === "object" && "label" in item && typeof item.label === "string" ? [item.label] : []);
}

function toSegment(row: any) {
  return {
    id: row.id, name: row.name, description: row.description ?? "", criteria: row.criteria ?? {}, status: row.status,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    latestSnapshot: row.snapshot_id ? { id: row.snapshot_id, metrics: row.snapshot_metrics ?? {}, sampledAt: iso(row.snapshot_sampled_at) } : undefined,
  };
}

function toSnapshot(row: any) {
  return {
    id: row.id, segmentId: row.segment_id ?? null, audienceDescription: row.audience_description ?? "",
    criteria: row.criteria ?? {}, profileIds: row.profile_ids ?? [], excludedProfileIds: row.excluded_profile_ids ?? [],
    metrics: row.metrics ?? {}, sampledAt: iso(row.sampled_at), createdAt: iso(row.created_at),
  };
}

function toRecommendation(row: any) {
  return {
    id: row.id, type: row.recommendation_type, segmentId: row.segment_id ?? null, segmentName: row.segment_name ?? null,
    productId: row.product_id ?? null, productName: row.product_name ?? null,
    targetSegmentDescription: row.target_segment_description, theme: row.theme, corePoints: row.core_points ?? [],
    suggestedChannels: row.suggested_channels ?? [], reasoning: row.reasoning ?? [],
    creativeDirection: row.creative_direction ?? "", durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    status: row.status, generatedAt: iso(row.generated_at), expiresAt: iso(row.expires_at),
  };
}

function assetSelect() {
  return `SELECT asset.*, campaign.name AS campaign_name, segment.name AS segment_name,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id',deployment.id,'platform',deployment.platform,'customPlatform',NULLIF(deployment.custom_platform,''),
            'status',deployment.status,'deployedAt',deployment.deployed_at,
            'feedback',COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'id',feedback.id,'impressions',feedback.impressions,'interactions',feedback.interactions,
              'conversions',feedback.conversions,'feedbackText',feedback.feedback_text,'recordedAt',feedback.recorded_at
            ) ORDER BY feedback.recorded_at DESC) FROM de_deployment_feedback feedback
              WHERE feedback.deployment_id=deployment.id),'[]'::jsonb)
          ) ORDER BY deployment.created_at DESC) FROM de_asset_deployments deployment
            WHERE deployment.asset_id=asset.id),'[]'::jsonb) AS deployments
          FROM de_marketing_asset_library asset
          LEFT JOIN de_marketing_campaigns campaign ON campaign.id=asset.campaign_id AND campaign.user_id=asset.user_id
          LEFT JOIN de_customer_segment_snapshots snapshot ON snapshot.id=asset.segment_snapshot_id AND snapshot.user_id=asset.user_id
          LEFT JOIN de_customer_segments segment ON segment.id=snapshot.segment_id AND segment.user_id=asset.user_id`;
}

function toAsset(row: any) {
  return {
    id: row.id, campaignId: row.campaign_id ?? null, campaignName: row.campaign_name ?? null,
    segmentSnapshotId: row.segment_snapshot_id ?? null, segmentName: row.segment_name ?? null,
    parentAssetId: row.parent_asset_id ?? null,
    assetType: row.asset_type, title: row.title, content: row.content ?? "", fileUrl: row.file_url ?? null,
    source: row.source, modelId: row.model_id ?? null, taskId: row.task_id ?? null,
    generationStatus: row.generation_status, status: row.status, version: Number(row.version),
    deployments: Array.isArray(row.deployments) ? row.deployments.map((item: any) => ({
      ...item,
      deployedAt: item.deployedAt ? iso(item.deployedAt) : null,
      feedback: Array.isArray(item.feedback) ? item.feedback.map((feedback: any) => ({ ...feedback, recordedAt: iso(feedback.recordedAt) })) : [],
    })) : [],
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function toDeployment(row: any) {
  return { id: row.id, assetId: row.asset_id, platform: row.platform, customPlatform: row.custom_platform || null, status: row.status, deployedAt: row.deployed_at ? iso(row.deployed_at) : null, feedback: [] };
}

function toFeedback(row: any) {
  return { id: row.id, deploymentId: row.deployment_id, impressions: row.impressions == null ? null : Number(row.impressions), interactions: row.interactions == null ? null : Number(row.interactions), conversions: row.conversions == null ? null : Number(row.conversions), feedbackText: row.feedback_text ?? "", recordedAt: iso(row.recorded_at) };
}

function marketingProductSnapshot(row: any) {
  const now = Date.now();
  const validBenefits = (row.current_benefits ?? []).filter((item: any) =>
    !item?.validUntil || Number.isNaN(new Date(item.validUntil).getTime()) || new Date(item.validUntil).getTime() >= now
  );
  return {
    id: row.id, name: row.name, positioning: row.positioning ?? "", coreValues: row.core_values ?? [],
    verifiableFacts: row.verifiable_facts ?? [], currentBenefits: validBenefits,
    commonObjections: row.common_objections ?? [], prohibitedExpressions: row.prohibited_expressions ?? [],
    version: Number(row.version),
  };
}

function buildBrief(input: CreateCampaignAssetInput, snapshot: any, product: any, brand: any): Record<string, unknown> {
  return {
    audience: { description: snapshot.audienceDescription, metrics: snapshot.metrics, sampledAt: snapshot.sampledAt },
    product: marketingProductSnapshot(product),
    brand: brand ? { tone: brand.tone ?? [], standardCallsToAction: brand.standard_calls_to_action ?? [], version: Number(brand.version) } : null,
    campaign: { objective: input.objective, channels: input.channels, callToAction: input.callToAction },
    request: input.prompt,
    privacyRule: "只面向聚合客群表达，不得出现单个客户身份或联系方式",
  };
}

function fallbackCopy(input: CreateCampaignAssetInput, snapshot: any, product: any): string {
  const value = (product.core_values ?? [])[0] || product.positioning || product.name;
  const audience = snapshot.audienceDescription || "目标客群";
  return `${input.title || product.name}\n\n面向${audience}，本次内容聚焦“${value}”。${input.prompt}\n\n${input.callToAction}`;
}

function campaignMediaPrompt(input: CreateCampaignAssetInput, snapshot: any, product: any, brand: any, kind: "poster" | "video") {
  const facts = (product.verifiable_facts ?? []).map((item: any) => item.statement).filter(Boolean).slice(0, 4);
  const forbidden = product.prohibited_expressions ?? [];
  return [
    kind === "poster" ? "生成一张专业营销海报，不要绘制任何真实客户或个人身份信息。" : `生成${input.durationSeconds ?? 15}秒营销视频，画面不得包含真实客户身份。`,
    `目标客群：${snapshot.audienceDescription || "已确认客群快照"}（仅作为聚合受众描述）`,
    `产品：${product.name}`, `定位：${product.positioning || "未填写"}`,
    `已确认价值：${(product.core_values ?? []).join("；") || "无"}`,
    `可信事实：${facts.join("；") || "无，不得虚构数字或案例"}`,
    `活动目标：${input.objective}`, `行动号召：${input.callToAction}`,
    `品牌语气：${(brand?.tone ?? []).join("、") || "专业、克制"}`,
    `禁用表述：${forbidden.join("、") || "无；仍禁止夸大承诺"}`,
    `创作要求：${input.prompt}`,
    kind === "poster" ? "确保核心标题、价值点和行动号召清晰，中文文字准确可读。" : "保持主题、价值点与行动号召一致，给出完整可播放成片。",
  ].join("\n");
}

function fallbackRecommendations(segments: Array<any>, products: Array<any>): CampaignRecommendationDraft[] {
  const segment = segments[0];
  const product = products[0];
  const audience = segment?.name ?? "当前整体客户群";
  const theme = product?.coreValues?.[0] || product?.positioning || product?.name || "产品价值";
  const base = { segmentId: segment?.id ?? null, productId: product?.id ?? null, targetSegmentDescription: audience, corePoints: (product?.coreValues ?? []).slice(0, 3), reasoning: ["基于当前客群聚合画像与已确认产品资料生成", "投放前请确认客群差异、权益期限和排除项"] };
  return [
    { ...base, type: "copy", theme: `${theme}：客群营销文案`, suggestedChannels: ["朋友圈", "公众号"] },
    { ...base, type: "copy", theme: `${product?.name ?? "产品"}场景价值解读`, suggestedChannels: ["私域群", "公众号"] },
    { ...base, type: "poster", theme: `${theme}主视觉海报`, suggestedChannels: ["朋友圈", "公众号"], creativeDirection: "克制留白，用一个核心价值和明确CTA完成表达" },
    { ...base, type: "video_script", theme: `${theme} 15秒短视频`, suggestedChannels: ["视频号", "抖音/快手"], creativeDirection: "问题场景—价值证明—行动号召", durationSeconds: 15 },
  ];
}

function normalizeRecommendationMix(value: CampaignRecommendationDraft[]) {
  const limits = { copy: 3, poster: 2, video_script: 2 };
  const used = { copy: 0, poster: 0, video_script: 0 };
  return value.filter((item) => {
    if (!item || !(item.type in limits) || !item.theme?.trim() || !item.targetSegmentDescription?.trim()) return false;
    if (used[item.type] >= limits[item.type]) return false;
    used[item.type] += 1;
    item.corePoints = Array.isArray(item.corePoints) ? item.corePoints.filter((x) => typeof x === "string").slice(0, 5) : [];
    item.suggestedChannels = Array.isArray(item.suggestedChannels) ? item.suggestedChannels.filter((x) => typeof x === "string").slice(0, 5) : [];
    item.reasoning = Array.isArray(item.reasoning) ? item.reasoning.filter((x) => typeof x === "string").slice(0, 5) : [];
    return true;
  });
}

function iso(value: string | Date): string { return new Date(value).toISOString(); }
function dateOnly(value: string | Date): string { return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10); }
function shanghaiDate(value: Date) { return new Date(value.getTime() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10); }
function isUniqueViolation(error: unknown) { return Boolean(error && typeof error === "object" && "code" in error && (error as any).code === "23505"); }
