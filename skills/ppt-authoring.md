---
name: ppt-authoring
description: PPT 制作 Agent 的叙事结构与版式选择工艺
agents:
  - ppt
---

你在制作可下载的 .pptx 演示文稿。素材盘点、提问、出大纲、生成、修改的流程如下。

## 输入盘点
用户消息里可能含：
- `[PPT模版已上传: 文件名 (templateAssetId: xxx)]` —— 记下 templateAssetId，生成时原样传给 generate_ppt；
- `[PPT背景图已上传: 文件名 (backgroundAssetId: xxx)]` —— 记下 backgroundAssetId，作为 generate_ppt 的 backgrounds 素材；
- `[附件: …]` 包裹的正文 —— 撰写素材；
- 用户的文字描述。

## 补齐信息
缺少「主题 / 受众 / 篇幅」等影响成稿的关键信息时用 ask_user 提问（一次一个）。
**没有模版也没有背景图时**，用 ask_user 让用户选内置主题，options 固定为：
["商务蓝", "科技深色", "暖橙创意", "极简黑白", "学术绿"]，
对应 generate_ppt 的 themePreset：business / tech-dark / warm / mono / academic。
能合理推断的不要问（篇幅默认 8-12 页）。

## 叙事骨架
cover → agenda（目录）→ 2-4 个章节（每章 section 分隔 + 2-3 页正文）→ closing（结尾/致谢）。

## 版式选择（硬规则，避免通篇 bullet）
- 连续 content 页不超过 2 页；
- 有数字/百分比/指标 → **stats**（每个 item 的 value 必须来自用户素材，禁止编造）；
- 方案/新旧/竞品对比 → **compare**；
- 阶段/步骤/里程碑/时间 → **timeline**；
- 金句/定位语/愿景 → **quote**；
- 并列的要点、优势、模块（成组）→ **keypoints**；
- 只有线性要点时才用 **content**。

## 文案规范
- bullets 每条 ≤ 20 字，观点先行；
- keypoints/timeline 的 desc 一句话；
- stats 的 value 简短（如 65%、3x、2.1w）。

## 流程
1. 盘点输入；2. ask_user 补关键信息（无风格来源时选主题）；
3. 调 **propose_outline** 出结构化大纲，等用户确认或修改；
4. 用户认可后调 **generate_ppt**（把 templateAssetId / backgrounds / themePreset 按盘点结果传入），把下载链接交给用户；
5. 修改时只改对应页，重新 propose_outline 再 generate_ppt。

不要编造 templateAssetId / backgroundAssetId；没有对应标记就不传该参数。不要向用户展示 assetId 等内部细节。
