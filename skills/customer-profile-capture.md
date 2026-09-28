---
name: customer-profile-capture
description: Safely create, update and search customer profiles and record customer activity.
triggers: [客户, 客户画像, 潜客, 新建, 更新, 查询, 获取, 统计, 联系, 咨询, 感兴趣, 产品, 购买, 试用, 投诉, 反馈, 跟进, 续费, 流失, customer, profile, purchase, trial, feedback, follow-up, pelanggan, profil]
agents: [digital_employee]
---

# Conversational customer profiles

Classify intent first: search/count with search_customer_profiles; read details with get_customer_profiles; create/update master records with prepare_customer_profile_change / commit_customer_profile_change; use capture tools for communications, purchases, trials, complaints and feedback.

- Counts must use total, not items.length.
- Multiple read matches allow selecting one or explicitly all matching profiles, up to six.
- Multiple write matches require selecting one customer; never offer bulk updates or commit before confirmation.
- After a unique read, selection or successful write, the server records the current customer. Pronouns may reuse it until archiving or context clearing, after which search again.
- Use profile management above the composer for contact details, archiving and manual locks.
- Never claim successful search/creation/update without a successful tool result.

Save customer/prospect communications, needs, purchase/trial, delivery, complaint, feedback, renewal or churn facts with profile tools. Do not substitute user memory or merely summarize in chat.

1. Extract the customer's reference, event type, product and explicit facts into prepare_customer_capture. The server supplies original text, current user and source message; never invent or rewrite them.
   - Inquiry about, interest in, trial/purchase of, or hesitation over the price, entry amount, threshold or risk of X requires productName=X. Preserve the actual name, including mixed-language names.
   - Negative sentiment still indicates a product relationship. Record objections/risks; do not omit productName.
   - Search marketing materials first. On a unique match pass the canonical productName and marketingProductId. Otherwise retain the original name without guessing an ID.
   - Omit productName only if no product/service is identifiable. A teacher interested in Agent Distribution but hesitant about its entry cost must still be linked to that named product, not treated as an unrelated note.
2. If ready, immediately call commit_customer_capture with only the draft ID.
3. If needs_clarification, ask exactly the provided question and choices through ask_user. Localize display wording to the user's language while preserving each choice's meaning and candidate mapping. Commit only after the answer:
   - Identity: map the selected choice to its returned profileId.
   - New customer: pass createProfile only after approval; do not commit if refused.
   - Product association: show exactly the server candidates with allowFreeText=false. Pass the selected marketingProductId, createMarketingProduct=true for a new product, or skipProduct=true for explicitly no association. Never skip before selection.
   - Stage: map an explicit answer to confirmedJourneyStage, such as purchased/in use → using, trial → trial, evaluating → evaluating, abandoned purchase → lost.

Ask only one write-critical question at a time. Negative feedback does not imply no purchase or churn; for an existing user record satisfaction/issues/risks without changing the stage to lost on your own. Never automatically overwrite contact details, identity fields, manually locked fields, verified transactions or original historical text.

After success, briefly state whose record changed and what was recorded in the user's language. Do not claim to have created follow-up tasks or contacted the customer unless the appropriate tools actually did so.
