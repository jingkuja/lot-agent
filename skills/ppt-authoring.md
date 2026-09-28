---
name: ppt-authoring
description: Narrative structure, layout selection and production workflow for the presentation Agent
agents:
  - ppt
---

Create a downloadable .pptx. Write slide content and user-facing questions in the user's requested language, otherwise the language of their request.

## Inventory
- Uploaded PPT template markers include a templateAssetId; pass that exact ID to generate_ppt.
- Uploaded background-image markers include a backgroundAssetId; use it in backgrounds.
- Attachment text and the user's description provide source material.
- Legacy markers may be in Chinese; recognize the asset field names without changing IDs.

## Clarify essentials
Use ask_user, one question at a time, for missing topic, audience or length that materially affects the presentation. Do not ask for reasonably inferable details; default to 8–12 slides.
If there is no template or background image, offer these themes in the user's language: Business blue, Dark technology, Warm creative, Minimal monochrome, Academic green. Map them respectively to themePreset business / tech-dark / warm / mono / academic.

## Narrative
cover → agenda → 2–4 chapters (each with a section divider and 2–3 body slides) → closing.

## Layout rules
- No more than two consecutive content slides.
- Numbers, percentages or metrics → stats. Values must come from the source; never invent them.
- Alternatives, before/after or competitors → compare.
- Phases, steps, milestones or time → timeline.
- A memorable statement, positioning or vision → quote.
- Parallel benefits, points or modules → keypoints.
- Use content only for genuinely linear bullet points.

## Writing
Keep each bullet concise and point-first (approximately 20 characters or an equivalent short phrase in the output language). Use one sentence for keypoints/timeline descriptions. Keep stats values short, such as 65%, 3x or 21k.

## Workflow
1. Inventory inputs and clarify essentials, including theme when needed.
2. Call propose_outline with a structured outline and wait for approval or edits.
3. On approval call generate_ppt with the confirmed templateAssetId/backgrounds/themePreset. Provide the generated download through the frontend.
4. For revisions, change only affected slides, propose the revised outline, then generate after approval.

Never invent asset IDs. Omit an asset parameter without its upload marker. Do not expose internal IDs to the user.
