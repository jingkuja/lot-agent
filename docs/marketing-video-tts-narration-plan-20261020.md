# 营销影像：TTS 配音替换模型原生配音 实施计划

日期：2026-10-20。状态：已于 2026-10-21 实施为「数字分身旁白」配音方式（见下方[实施记录](#实施记录2026-10-21)），步骤 1 的网关实测尚未进行。上位方案见 [配音、字幕与对口型方案](marketing-video-audio-subtitle-plan-20261020.md)，本文只覆盖其中「TTS 配音替换视频模型配音」一项。

## 目标与范围

新提交的营销视频不再让视频模型朗读台词：视频片段一律无声生成，旁白由 TTS 按分镜逐镜合成，在本地合成时替换片段音轨。用户在付费生成视频前可以试听全部配音，并按实测配音时长校准分镜时长。

| 本期做 | 本期不做 |
| --- | --- |
| 逐镜 TTS 合成、试听、按实测时长校准分镜 | 整段 TTS 母带、字词时间戳、强制对齐 |
| 音色来源：数字分身已复刻音色、系统预设音色 | 未复刻的上传音色样例直接用于 TTS |
| 合成时用 TTS 音轨替换片段音轨，继续混入 BGM | 本地 SRT / ASS 字幕、字幕烧录（R2） |
| 视频提示词改为「画外旁白、人物不说话」 | 对口型 / 音频驱动视频（R1 口型部分） |
| 冻结任务版本 4，旧任务按原 `generate_audio` 恢复 | 局部重配、多家 TTS 供应商切换 |

本期完成后，人物不再出现和台词对不上的嘴型，音色在全片保持一致；但人物不开口说话，字幕仍由视频模型绘制且不与配音逐字同步。这两点在界面和文档中如实说明，不宣称 R1 / R2 已关闭。

## 现状

- 视频提示词：`server/marketing-video/prompt.ts` 在 `generateAudio=true` 时要求模型逐字朗读 `confirmedShot.script`；选了参考视频时 `generate_audio=false`，整片没有旁白。
- 提交：`routes.ts` 的 `POST /:id/generate` 写入 `generate_audio: !draft.assets.video` 和 `reference_audio`（上传音色样例）；Kling 在 `run.ts` 中先创建自定义音色。
- 合成：`media.ts → composeMarketingVideo` 逐镜规范化时取片段自带音轨，无音轨时补 `anullsrc`，再 concat、混 BGM，视频流 `-c:v copy`。
- TTS 能力（提交 `878632d` 已接入）：`core/providers/tts.ts` 的 `OpenAISpeechProvider` 调 `OPENAI_BASE_URL/audio/speech`，用户本人 New API Key，网关计费、不重试；`digital-twin/voices.ts` 的 `TwinVoices.speak` 只从 `digital_twin_voices` 读取音色 ID 和绑定模型（默认 `qwen-audio-3.0-tts-plus`）。
- 素材：数字分身音色选入营销草稿时，`DigitalTwinPicker` 把原件复制为 `assets.voice` 上传素材，草稿里没有知识条目 ID，因此拿不到已复刻的音色 ID。

## 方案要点

1. **逐镜合成，不做整段切分。** 现有 `/audio/speech` 只返回音频、没有时间戳，整段合成后无法可靠切到分镜边界。逐镜合成固定同一模型、音色、语速和语气说明，保证音色一致；镜间语气衔接弱于整段合成，作为已知限制。
2. **配音先于视频付费。** 在制作步骤点「生成配音」后同步合成并保存；`/generate` 只接受与当前草稿匹配、且全部成功的配音，把配音资产冻结进任务输入。Worker 不调用 TTS。
3. **实测时长决定分镜时长。** 每镜最短时长改为 `ceil(配音秒数 + 0.4)`，复用 `allocateShotDurations` 在目标时长至 +5 秒、单镜上限内重排；放不下时提示精简文案或调快语速，不自动大幅变速，也不截断配音。
4. **视频片段一律无声。** 新任务 `generate_audio=false`、不发 `reference_audio`，Kling 不再创建自定义音色；提示词明确人物不对镜头说话、嘴部自然闭合或微笑，旁白在后期加入。
5. **合成时替换音轨。** 规范化每镜时以对应配音为音频输入（补静音到镜长），忽略片段自带音轨，其余拼接与 BGM 流程不变。
6. **计费沿用网关。** TTS 用当前用户 Key 调网关，由网关账号计费，本地不新增计量；视频额度预检不变。

## 数据与接口

### 草稿字段

`core/marketing-video/index.ts` 的 `MarketingDraftSchema` 新增可选对象（旧草稿缺省即可读取）：

```ts
narration: z.object({
  source: z.enum(["preset", "twin"]),
  /** preset：服务端配置的系统音色键；twin：数字分身声音条目 ID。 */
  preset: z.string().max(40).optional(),
  twinItemId: z.string().uuid().optional(),
  speed: z.number().min(0.8).max(1.25).default(1),
  /** 语气说明，沿用 TwinSpeechInputSchema 的 200 字上限。 */
  instructions: z.string().trim().max(200).default(""),
}).strict().optional()
```

- `draft.voice`（旁白风格）在 TTS 路径作为 `instructions` 的默认值，不再进入视频提示词。
- `assets.voice` 上传样例在新路径不参与生成；界面提示「先在数字分身中复刻音色」。旧草稿保留该字段，不自动删除。
- `narration` 属于制作配置，进入 `renderKey`，提交后不可修改，与其他制作字段一致。

### 系统预设音色

预设音色 ID 与 `qwen-audio-3.0-tts-plus` 绑定，需按千问文档和网关阿里渠道实测核对后写入，不在本文猜测。实现方式：`server/marketing-video/narration.ts` 内维护 `{ key, label, voiceId, model }` 列表，`GET /api/marketing-videos/capabilities` 只返回 `key / label`，不向前端暴露供应商 ID。列表为空时前端只显示数字分身音色入口。

### 配音记录表（新迁移 53）

`packages/server/src/db/migrations/0053-marketing-video-narrations.ts`，并在 `migrations/index.ts` 注册：

| 列 | 说明 |
| --- | --- |
| `owner_id`、`project_id`、`slot` | 归属与镜号；外键指向 `marketing_video_projects`，按用户隔离 |
| `narration_key` | `sha256(JSON[模型, 音色来源与 ID, 速度, 语气, 镜头台词, 格式])`；台词或音色任一变化即失效 |
| `status` | `running / succeeded / failed` |
| `asset_id`、`duration_ms` | 成功后的私有音频资产与 ffprobe 实测时长（整数毫秒） |
| `created_at`、`updated_at` | `running` 超过 120 秒视为未完成，可由用户显式重新合成 |

主键 `(owner_id, project_id, slot, narration_key)`。同一请求先插入 `running` 意图再调用网关；成功后在一个事务中写资产与记录。单次 TTS 费用很低，但仍不自动重发：失败或超时的镜由用户点击「重新生成该镜配音」触发。

### 接口

| 接口 | 说明 |
| --- | --- |
| `POST /api/marketing-videos/:id/narration` | 请求带 `version`，可选 `slots` 只重做指定镜。读取已保存草稿，校验归属、分镜完整、音色就绪；每镜复用已有成功记录，其余并发（上限 3）合成。返回每镜 `status / durationMs / previewUrl` 及建议分镜时长。加入 `server/index.ts` 的 `generationRateLimit` |
| `GET /api/marketing-videos/:id/narration` | 只读当前草稿对应的配音状态，不调用供应商 |
| `POST /:id/generate` | 新提交要求每镜都有与当前 `narration_key` 匹配的成功记录且时长不超过镜长减 0.2 秒，否则 409 并提示先生成配音 |

数字分身音色：`TwinVoices` 增加按 `(ownerId, itemId)` 合成指定格式的方法（复用 `speak` 的归属、状态与 Key 校验，格式改为参数，默认 `mp3` 保持试听接口不变）；营销路径请求 `wav`，避免反复 MP3 编解码。合成结果先过 `inspectMedia`，必须是音频且时长 0.3–15 秒。

音频资产写入现有存储并设 `is_private=true`，预览走现有所有者接口或 10 分钟临时令牌，不进入公开静态路径。

### 冻结输入（版本 4）

`MARKETING_INPUT_VERSION` 升为 4，新任务输入增加：

```ts
narration: { slot: number; assetId: string; durationMs: number; key: string }[]
generate_audio: false
reference_audio: undefined
```

`run.ts` 按 `marketingInputVersion >= 4 && narration` 走 TTS 路径；版本 1–3 任务继续按冻结的 `generate_audio` 与 `reference_audio` 恢复，Kling 音色链路保留给旧任务。

## 代码改动清单

| 位置 | 改动 |
| --- | --- |
| `core/marketing-video/index.ts` | `narration` 字段；版本号 4；导出 `narrationShotMinimum(durationMs)` 供前后端按实测时长计算单镜最短秒数，`allocateShotDurations` 增加可选的外部最短时长参数 |
| `server/marketing-video/narration.ts`（新） | 预设音色表、`narration_key` 计算、逐镜合成与记录读写、按实测时长给出建议分镜时长 |
| `server/marketing-video/narration-store.ts`（新） | `marketing_video_narrations` 的 PG 实现；接口定义放 core，不在 core 引入 `pg` |
| `server/digital-twin/voices.ts` | 合成方法支持 `format` 参数；供营销路径复用归属与就绪校验 |
| `server/marketing-video/routes.ts` | 新增配音接口；`/generate` 校验并冻结配音、写 `generate_audio:false`，新任务不再处理 `assets.voice` |
| `server/marketing-video/prompt.ts` | 新增「画外旁白」模式：`marketingSegmentPrompt` 与 `marketingPresenterRequirement` 允许画外旁白、要求人物不说话；`marketingPlanningContext` 和 `MARKETING_STORYBOARD_RULES` 告知规划模型旁白由后期配音完成，台词仍按每秒字数预算编写 |
| `server/marketing-video/run.ts` | 版本 4：跳过 Kling 音色准备；质量检查不再要求片段有音轨；合成前校验配音资产归属与时长，传入 `composeMarketingVideo` |
| `server/marketing-video/media.ts` | `composeMarketingVideo` 增加可选 `narration: string[]`；有配音时每镜以配音为音频输入、`apad` 补到镜长，忽略片段音轨；配音长于镜长直接报错，不截断 |
| `server/marketing-video/failure.ts`、core 失败码 | 新增 `NARRATION_INVALID`（配音缺失、过期或不可读），前端给出「重新生成配音」指引 |
| `web/.../ProductionStep.tsx` | 音色选择（预设 / 数字分身）、语速、语气；「生成配音」按钮、逐镜试听与时长对比、单镜重做；配音缺失或过期时作为生成阻塞原因；更新字幕说明文字 |
| `web/.../ProjectStudio.tsx`、`session.ts`、`api.ts` | 数字分身选择改为写入 `narration.twinItemId`（只列出复刻状态为 OK 的声音）；配音请求纳入单操作互斥；接受建议时长后保存草稿 |
| `web/src/modules/digital-twin/DigitalTwinPanel.tsx` | `DigitalTwinPicker` 增加按条目选择音色的模式，返回条目 ID 与复刻状态，不再复制原件 |
| `web/src/i18n/messages.ts` | 新增文案中英文；样式只用现有 CSS 变量，检查深色主题 |
| `docs/marketing-video.md`、`docs/agent-code-guide.md` | 更新配音与字幕说明、入口和迁移 53 |

## 实施步骤

1. **核对网关与预设音色。** 用测试账号确认网关阿里渠道对 `qwen-audio-3.0-tts-plus` 支持 `response_format=wav`、`speed`、`instructions`，记录可用系统音色 ID；确认已复刻音色经网关可合成。未通过则先停在这一步。
2. **core 与迁移。** 草稿字段、版本 4、配音存储接口、最短时长计算；迁移 53 及迁移测试计数更新。
3. **服务端配音。** `narration.ts`、存储实现、`TwinVoices` 格式参数、配音接口与限流；单元测试覆盖归属、过期键、并发上限、失败不自动重发、超时记录可显式重做。
4. **提交与 Worker。** `/generate` 校验与冻结；`prompt.ts` 画外旁白模式；`run.ts` 版本分支；`media.ts` 音轨替换。补充 `routes.test.ts`、`run.test.ts`、`prompt.test.ts`、`media.test.ts`。
5. **前端。** 制作步骤配音区、数字分身音色选择、阻塞原因、中英文案；更新 `check-marketing-video-ui.mjs`。
6. **文档。** 更新 `marketing-video.md` 与 `agent-code-guide.md`。

## 验收

自动化：

- `pnpm` 下 core 与 server 相关测试、server / web 构建通过。
- 旧版本 1–3 任务恢复仍按原 `generate_audio`，Kling 音色检查点不受影响。
- 合成测试：有配音时成片音轨来自配音，片段自带音轨被忽略；配音长于镜长时报错；成片时长等于各镜之和（误差 ≤0.3 秒）。
- 修改某镜台词、音色、语速或语气后，该镜配音失效且 `/generate` 返回 409。

真实样片（至少 10 条，覆盖 15 / 30 / 60 秒、Grok 与 Kling、有无参考视频、预设与复刻音色）：

- 全片音色一致，无漏读、截断或双重人声；品牌、价格、数字人工核对正确。
- 人物画面无明显说话嘴型；记录仍出现张嘴说话的比例，作为后续对口型的依据。
- 建议分镜时长被接受后，各镜配音不被截断，结尾静音不超过 1.5 秒。
- 记录每条视频的配音耗时与网关实际扣费。

## 风险

| 风险 | 应对 |
| --- | --- |
| 视频模型忽略「不说话」约束，仍生成说话嘴型 | 样片统计比例；比例高时优先推进上位方案的对口型阶段，不在本期反复调提示词 |
| 实测配音普遍长于字数预算，频繁触发重排 | 样片后校准 `speechUnits` 的每秒预算或默认语速 |
| 网关渠道与复刻账号不一致导致音色 ID 无效 | 沿用现有约束（同一千问账号），配音接口返回明确的配置错误 |
| 逐镜合成的镜间语气不连贯 | 固定语气说明；整段合成留待有时间戳能力后再做 |
| 字幕与配音节奏不同步 | 本期如实提示；本地字幕属于 R2 阶段 |

## 实施记录（2026-10-21）

按本计划实施，作为第 3 步的「数字分身旁白」配音方式；「AI 配音」保留为原来的模型配音（快速模式），不是所有新视频都改为无声片段。现行行为见 [营销视频制作：配音方式](marketing-video.md#配音方式)，评审记录见 [评审报告第八轮](marketing-video-review-20261019.html#fixes8)。与计划的差异：

| 计划 | 实际 |
| --- | --- |
| 音色来源含系统预设音色 | 未做。预设音色 ID 需按网关实测核对，本期只用已复刻的数字分身音色；`narration` 只有 `twinItemId`、显示名、语速、语气 |
| `narration.source` 区分 preset / twin | 无 `source` 字段；`narration` 存在即旁白模式 |
| `draft.voice` 作为语气默认值 | 旁白模式隐藏旁白风格，语气要求由用户填写 |
| 迁移 53 | 迁移 55（53、54 已被单镜重做和文案取消占用） |
| 记录表存资产 ID | 存 `storage_key`，文件放在 `data/marketing-narration/<草稿>/`，只经所有者接口读取，不进 `assets` 表和公开静态目录；冻结输入同时记录文件，重新生成不会替换已冻结的配音 |
| 提示词要求人物不说话、嘴部闭合 | 按 10-21 需求补充放宽：人物可以自然活动和有嘴部动作，只是不对着镜头念台词，避免居中口播特写 |
| 新增 `NARRATION_INVALID` | 已加；Worker 在付费提交片段前检查冻结的配音文件 |
| 单镜重做（G04，本计划之后加入） | `/revise` 为改过口播的镜头各合成一次新配音后冻结进新任务 |

仍待完成：步骤 1 的网关实测（`response_format=wav`、`speed`、`instructions`、已复刻音色经网关可用）和验收一节的 10 条真实样片；空间用量尚未计入配音文件。

