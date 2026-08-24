---
name: customer-profile-capture
description: 通过数字员工安全新建、更新、查询客户画像，并记录客户动态。
triggers: [客户, 客户画像, 潜客, 新建, 更新, 查询, 获取, 统计, 联系, 咨询, 感兴趣, 产品, 购买, 试用, 投诉, 反馈, 跟进, 续费, 流失]
agents: [digital_employee]
---

# 对话式客户画像

先判断用户意图：查询或统计使用 `search_customer_profiles`；读取详情使用 `get_customer_profiles`；新建/更新主档使用 `prepare_customer_profile_change` / `commit_customer_profile_change`；沟通、购买、试用、投诉和反馈使用采集工具。

- 数量回答必须使用搜索结果的 `total`，不能使用当前页 `items.length`。
- 只读多匹配可让用户选择单人或“全部匹配画像”；读取最多 6 条。
- 更新多匹配必须逐人选择，不提供“全部更新”，确认前不提交。
- 唯一读取、用户选择或写入成功后，服务端会记录当前客户；后续“她 / 他 / 刚才那位”可以复用，但画像归档或上下文清除后必须重新查询。
- 联系方式、归档和人工锁定交给输入框上方的“客户画像管理”精准维护。
- 工具失败或没有调用工具时，不得声称已经查到、新建或修改画像。

当用户陈述某位客户、潜客的沟通结果、需求、购买/试用、交付、投诉、反馈、续费或流失情况时，使用客户画像工具保存业务事实。不要把这些事实写入用户记忆，也不要只在回复中总结。

1. 从用户原话识别客户称呼、事件类型、产品和明确事实；调用 `prepare_customer_capture`。原始文本、当前用户和来源消息由服务端提供，绝不自行编造或重写。
   - “咨询 X / 了解 X / 对 X 感兴趣 / 想试用或购买 X / 因 X 的价格、金额、门槛或风险犹豫”中的 X 是产品或服务对象，必须作为 `productName` 传入。产品名可中英混合，例如 `agent代销`。
   - 客户表达犹豫、异议或负面态度，仍然说明存在该产品关系；应记录异议或风险，不能因此省略 `productName`。
   - 先调用 `search_marketing_materials` 查询产品。唯一匹配时同时传规范 `productName` 和 `marketingProductId`；没有匹配或无法唯一确认时，仍传用户原话中的 `productName`，不要填写或猜测 `marketingProductId`。
   - 只有原话确实没有可识别的产品/服务对象时，才允许省略 `productName`。例如“张老师今天咨询 agent代销，表示很感兴趣，但对于入场金额太高犹豫了”必须识别 `productName=agent代销`，不能当作无产品的“其他备注”。
2. 返回 `ready` 时，立刻调用 `commit_customer_capture`，只传草稿 ID。
3. 返回 `needs_clarification` 时，严格按工具结果中给出的 `question` 和 `options` 调用一次 `ask_user`。收到回答后，才调用 `commit_customer_capture`：
   - 身份歧义：将工具结果中的候选 `profileId` 与用户选项对应。
   - 新客户：用户确认新建时传 `createProfile`；若拒绝新建，不提交草稿。
   - 产品关联歧义：严格展示服务端候选，且 `allowFreeText=false`。选择已有产品时传对应 `marketingProductId`；选择“将…添加为新产品”时传 `createMarketingProduct=true`；选择“不关联产品”时传 `skipProduct=true`。没有收到用户选择前，不得自行跳过产品关联。
   - 产品阶段歧义：把明确回答转成 `confirmedJourneyStage`，例如“已购买正在使用”→`using`、“正在试用”→`trial`、“仍在评估”→`evaluating`、“已经放弃购买”→`lost`。

规则：

- 一次只确认一个真正影响写入的问题。
- 负面反馈不等于未购买或流失。已知正在使用时，优先记录满意度、问题和风险；不能擅自把阶段改为 `lost`。
- 联系方式、身份字段、人工锁定字段、已验证交易和历史原文都不能由模型自动覆盖。
- 提交成功后用一句简短回执说明已记录到哪位客户、更新了什么；不得声称已经创建跟进任务或对外联系客户。
