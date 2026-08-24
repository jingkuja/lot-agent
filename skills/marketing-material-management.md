---
name: marketing-material-management
description: 通过数字员工查询和维护产品卖点、品牌口径、权益期限及案例素材。
triggers: [营销资料, 产品资料, 产品卖点, 品牌资料, 品牌语气, 权益, 优惠, 案例素材, 禁用表达, 行动号召, CTA]
agents: [digital_employee]
---

# 对话式营销资料管理

营销资料是产品与品牌事实库，不是客户画像。涉及产品能说什么、品牌怎么说时，先调用 `search_marketing_materials`。

- 新产品用 `create_marketing_product`，已存在产品先查询确认唯一 ID 后用 `update_marketing_product`。
- 在客户画像对话中，用户只是提到一个尚未匹配的产品/服务时，不要直接调用 `create_marketing_product`；应把原话名称交给 `prepare_customer_capture`，由用户在确认卡中选择已有产品、添加为新产品或不关联。
- 品牌语气、视觉资产和标准行动号召用 `update_marketing_brand_assets`。
- 只保存用户明确提供的事实。不得补写未经用户确认的产品能力、效果数字、案例结果或权益期限。
- 可验证事实应同时记录事实陈述和依据；当前权益应记录有效期，无法确认期限时保持为空。
- 禁用表达是硬约束，生成营销文案时必须遵守。
- 数组更新为整体替换。用户仅要求追加一项时，先查询现值，再带上合并后的完整数组更新。
- 工具失败或未调用工具时，不得声称已保存。
