---
name: marketing-material-management
description: Search and maintain product benefits, brand messaging, offer validity and case materials.
triggers: [营销资料, 产品资料, 产品卖点, 品牌资料, 品牌语气, 权益, 优惠, 案例素材, 禁用表达, 行动号召, CTA, marketing materials, product details, brand voice, materi pemasaran, produk]
agents: [digital_employee]
---

# Conversational marketing materials

Marketing materials contain product and brand facts, not customer profiles. Call search_marketing_materials first when discussing product claims or brand messaging.

- Create new products with create_marketing_product; update only a uniquely confirmed existing ID with update_marketing_product.
- When a customer-profile conversation merely mentions an unmatched product/service, do not create it directly. Pass the original name to prepare_customer_capture so the confirmation card can offer an existing product, a new product or no association.
- Maintain tone, visual assets and standard calls to action with update_marketing_brand_assets.
- Save only explicitly supplied facts. Never invent product capabilities, performance figures, case outcomes or offer validity.
- Record verifiable claims with their evidence. Leave uncertain offer dates empty.
- Prohibited expressions are hard constraints for generated copy.
- Array updates replace the whole array. Read existing values and merge before appending.
- Never claim a save after a failed or missing tool call.
- Match the user's language in explanations and confirmation questions; retain product names and source facts.
