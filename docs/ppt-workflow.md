# PPT 生成与修改流程

本次改进围绕三个目标：清楚的叙事、稳定的版面、用户确认与最终导出一致。

## 使用流程

1. 助手先阅读素材，识别受众、表达目标、时长、页数与素材处理方式。仅对会影响结果的缺失信息提问；原文保留、提炼与创作分别处理。
2. `propose_outline` 展示完整逐页内容、当前假设、主题及上传设计。用户可修改标题、正文、数据、来源和备注，也可调整页序或删除页面。
3. 点击确认后，服务端按卡片中的确切数据导出，不再调用模型重新组织内容。普通文字确认仍由 PPT Agent 调用生成工具。
4. 输出提供 PPTX 下载、实际渲染的页面缩略图和逐页编辑入口。字段修改可以直接重新导出；叙事、版式等修改可继续用自然语言提出。

每页围绕一个观点组织。数量变化采用可编辑的原生图表，独立指标采用数字卡片，对比与步骤分别采用双栏和时间线。长说明放入备注前需尊重用户的原文保留要求。数字图表必须提供单位、来源及等长数值数组，空值不会自动变成零。

## 实现边界

- `packages/core/src/presentation/` 提供浏览器与服务端共用的数据类型、工具 schema、容量校验、叙事建议和消息协议。
- `skills/ppt-authoring.md` 定义需求澄清、叙事组织、信息版式与修改规则；`propose_outline` 继续通过 `endsTurn` 等待用户。
- 前端确认携带完整文稿与设计设置。`AgentService` 在已认证的聊天入口识别确认协议，检查 Agent 工具权限后直接调用生成工具；沿用会话租约、取消信号和历史持久化。
- 上传素材继续校验用户归属。模板无法容纳图表、来源、备注等内容时，提取其配色/字体并用原生版式排版，结果卡片说明这一变化。
- 文本按中英文宽度估算容量，并在导出前调整字号。超限内容必须修改、拆页或按约定转入备注，不能截断。
- 生成结果的工具消息保存文稿与缩略图地址，刷新聊天后仍能编辑。导出失败时清理本次生成的文件；预览转换失败不影响 PPTX 下载。

当前编辑器用于修改内容和主题，不是自由拖拽的幻灯片画布。重新导出会重建整份 PPTX，未修改页面的数据保持原样。预览并不等于自动完成视觉审稿，也不保证与所有版本的 PowerPoint 字体渲染完全一致。付费 AI 配图、专业模板素材库和模板 manifest 不在本次实现范围内。

## 缩略图运行要求

服务端通过 LibreOffice 将 PPTX 转成 PDF，再用 `pdftoppm` 生成 PNG。Dockerfile 已加入 `libreoffice-impress`、`poppler-utils` 和 `fonts-noto-cjk`；部署需重新构建镜像。

本地开发需要这两个命令可用；可用 `PPT_SOFFICE_PATH` 和 `PPT_PDFTOPPM_PATH` 指定可执行文件路径。默认开启预览，设置 `PPT_PREVIEW=0` 可关闭。转换器缺失、超时或忙碌时，界面会提示缩略图不可用，仍可下载并修改文稿。

转换使用独立的临时目录和 Office 配置，注册项目已有的中文字体，仅影响子进程。每个服务进程同时最多一个转换任务；超过 40 页或 30 MB 的输入不做预览。含外部关系、宏或非原生图表工作簿嵌入内容的模板跳过转换。此检查是输入过滤，不是独立的操作系统沙箱。

## 验证

先构建共享入口，再运行相关测试：

```bash
pnpm --filter @lot-agent/core build
pnpm exec vitest run packages/core/src/presentation packages/server/src/ppt packages/server/src/tools/ppt-tool.test.ts packages/server/src/tools/propose-outline-tool.test.ts packages/server/src/services/ppt-confirmation.test.ts packages/server/src/services/agent-service.ppt.test.ts
```

视觉样例覆盖五套主题及全部 11 种版式，另有中英文密集文字、六卡片、四指标与折线/饼图样例，共 67 页。所有数据都明确标记为测试示例，不调用模型或外部生成服务：

```bash
pnpm --filter @lot-agent/server exec node --import tsx/esm scripts/check-ppt.ts /tmp/lot-ppt-quality
```

检查每套主题输出的 `sample.pptx` 和 `slide-*.png`，关注中文字体、长标题、来源、六阶段时间线及深色主题对比度。代码测试另覆盖图表工作簿、数据校验、精确确认、权限、文件清理、取消与可选预览。

## 方案参考

结合项目升级文档，优先落地排版质量与预览修改闭环。参考的是以下产品已公开的流程，不将其视为市场份额排名：

- [Gamma 的素材导入与处理方式](https://help.gamma.app/en/articles/11047840-how-can-i-import-slides-or-content-into-gamma)：明确保留、提炼或生成内容的意图，并提供结构调整阶段。
- [Microsoft Copilot 的演示准备流程](https://support.microsoft.com/en-us/office/prepare-your-presentation-with-copilot-for-microsoft-365-7f06429e-c0c2-4819-8119-b519ad599796)：先明确演示目标与组织结构。
- [Presenton 的模板与主题](https://docs.presenton.ai/guide/generate-presentation-with-templates-and-themes)：区分内容布局和视觉主题，保留后续编辑能力。

本项目采用可编辑的原生 PPTX 图表、文字与矢量元素，使用户能在确认前和下载后继续修改。
