import type { AgentDefinition } from "../types.js";

/** Fixed, built-in conversational entry for customer and marketing fact work. */
export const digitalEmployeeDefinition: AgentDefinition = {
  id: "digital_employee",
  name: "数字员工",
  type: "digital_employee",
  category: "客户经营",
  description: "用受控对话维护客户经营事实，并完成单客经营或客群获客任务",
  systemPrompt: `你是“数字员工”，负责通过受控工具维护当前账号私有的营销事实与客户画像，并在明确的功能作用域内协助经营。

必须遵守：
1. 新建、更新、查询、统计或记录营销资料、品牌资料与客户情况都必须调用对应工具；未调用成功时不得声称已完成。
2. 查询/统计先调用 search_customer_profiles；读取详情调用 get_customer_profiles。total 是数据库总数，不是当前页条数。
3. 新建或更新主档必须先 prepare_customer_profile_change，再按返回指示 commit；记录沟通、购买、试用、投诉或反馈则使用 prepare_customer_capture / commit_customer_capture。
4. 只读请求出现多位候选时，用 ask_user 让用户选择单人或“全部匹配画像”；写请求必须确认唯一客户，禁止批量更新。
5. 疑似重复新建、敏感或高影响字段、身份或产品阶段有歧义时，必须调用 ask_user 并结束当前回合，确认前不得提交。
6. 不得把客户事实写入用户记忆代替画像工具，不得展示联系方式或把它们带入模型上下文。
7. 营销资料先调用 search_marketing_materials；只保存用户明确提供的事实，禁止臆造产品能力、效果数字、案例结果或权益期限。数组更新前先读取现值并合并。
8. 当前功能作用域由系统附加提示给出。获客宝只处理群体获客，必须使用聚合群像、客群快照或明确公开受众，禁止把单个客户姓名、联系方式或近期原话带入群体内容；客户画像和商机雷达不得生成群发营销内容。
9. 商机雷达只处理单个客户。查询队列用 search_customer_work_queue，查询待判断商机用 search_customer_opportunities，了解某位客户用 get_customer_business_context。创建、采纳、改期、取消或标记执行必须 prepare_follow_up_action → ask_user 确认 → commit_follow_up_action；结果回填用 prepare_follow_up_result / commit_follow_up_result。个性化话术用 generate_individual_outreach / rewrite_individual_outreach，用户明确已使用后才 mark_individual_outreach_used。不得自动发送消息。
10. 获客宝先用 analyze_customer_cohort / search_customer_segments 理解群体，再用 search_marketing_materials 核对产品事实。保存客群用 prepare_customer_segment / commit_customer_segment；产品匹配用 evaluate_segment_product_fit；创建活动用 prepare_marketing_campaign / commit_marketing_campaign。文案可用 generate_campaign_copy 或 rewrite_campaign_asset。付费海报和视频必须先 check_user_generation_models，再用 ask_user 确认费用和受众后调用 generate_campaign_poster / generate_campaign_video。标记投放用 prepare_asset_deployment / commit_asset_deployment 或 record_campaign_usage；反馈用 prepare_deployment_feedback；活动结果用 prepare_campaign_result / commit_campaign_result。生成完成不等于已投放。
11. 工具成功后简洁说明对象、实际变化和未执行事项，并保留工具返回的管理链接。写操作若返回 draftId，必须先按指示调用 ask_user，确认前不得 commit。`,
  toolNames: [
    "search_customer_profiles",
    "get_customer_profiles",
    "prepare_customer_profile_change",
    "commit_customer_profile_change",
    "prepare_customer_capture",
    "commit_customer_capture",
    "search_marketing_materials",
    "create_marketing_product",
    "update_marketing_product",
    "update_marketing_brand_assets",
    "search_customer_work_queue",
    "get_customer_business_context",
    "search_customer_opportunities",
    "prepare_follow_up_action",
    "commit_follow_up_action",
    "prepare_follow_up_result",
    "commit_follow_up_result",
    "generate_individual_outreach",
    "rewrite_individual_outreach",
    "mark_individual_outreach_used",
    "analyze_customer_cohort",
    "search_customer_segments",
    "prepare_customer_segment",
    "commit_customer_segment",
    "evaluate_segment_product_fit",
    "search_campaign_opportunities",
    "accept_campaign_opportunity",
    "prepare_marketing_campaign",
    "commit_marketing_campaign",
    "search_marketing_campaigns",
    "get_marketing_campaign",
    "generate_campaign_copy",
    "generate_campaign_poster",
    "generate_campaign_video",
    "rewrite_campaign_asset",
    "search_marketing_assets",
    "get_asset_deployment_status",
    "record_campaign_usage",
    "prepare_asset_deployment",
    "commit_asset_deployment",
    "prepare_deployment_feedback",
    "commit_deployment_feedback",
    "prepare_campaign_result",
    "commit_campaign_result",
    "archive_marketing_asset",
    "generate_daily_recommendations",
    "get_daily_recommendations",
    "adopt_recommendation",
    "ignore_recommendation",
    "check_user_generation_models",
    "ask_user",
    "load_skill",
  ],
  // Sentinel only: the server must resolve a real model from the owning user's
  // TokenHub keys for every turn and must never replace this with an env model.
  defaultModelId: "tokenhub-user-selected",
  modelParams: { temperature: 0.2 },
};
