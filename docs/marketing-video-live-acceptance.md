# 公网音频、Linux 与小红书 ASR 验收

2026-10-15。本轮按用户确认在本机执行：`https://aigc.todoucloud.com` 映射到本机 API，不是另一台生产服务器。用户提供一条小红书视频；抖音、B 站改由用户后续手动验证。本轮未部署、未更改 Docker 主机安全策略。

## 验收结果

| 项目 | 实际结果 | 边界 |
| --- | --- | --- |
| 公网音频 URL | 通过：有效凭证返回 200、`audio/wav`、正确长度、匹配 SHA-256、`private, no-store`；删除后同一 URL 返回 404 | 从本机通过公网域名访问；后续真实 ASR 成功也验证了网关读取该路由 |
| Linux namespace 前置条件 | 未通过：两个本机 Linux 镜像均返回 `unshare failed: Operation not permitted` | 非 root、`cap_drop=ALL`、`no-new-privileges`；不能据此认定完整 bubblewrap 文件/网络隔离通过 |
| Linux bubblewrap 镜像 | 受阻：Docker 内 Debian 包仓库 HTTPS 证书校验失败，未构建出测试镜像 | 未关闭 TLS 校验，未使用 privileged 或无沙箱回退；未运行正式媒体 Worker 镜像 |
| 小红书下载与音频提取 | 通过：18,035,982 字节，37,100 ms，76 个候选帧；macOS 隔离解码得到 1,187,454 字节 16 kHz 单声道 WAV | 此样本包含可用内嵌音轨，不证明独立音轨下载能力 |
| 小红书真实 ASR | 通过：118 字，输入 521 / 输出 84 tokens，完整回执 | 操作员环境凭证，1 次实际 ASR 请求；不是跨账号生产 Worker 验收 |
| 语音进入真实摘要 | 通过：摘要与营销解读引用 `a0001`，时间线不引用无时间戳的语音 | 2 帧 OCR、2 帧画面观察，仅验证证据传递，保留采样缺口，不作为完整视觉质量验收 |
| 重新读取 ASR | 通过：重新提取同源音频并轮换短时 URL 后复用相同响应 ID，仍只有一个账本意图 | 未发起第二次 ASR 请求，未知请求保护保持不变 |
| 浏览器展示 | 通过：实际转写文本加载进 React/Chrome，中英文、暗色、窄屏与恢复断言通过 | 其余接口使用 UI 夹具，不把模拟草稿视为真实创作结果 |

## 实际发现并修复

网关 `/api/agent-market/models` 把 `qwen-audio-3.1-asr-flash` 放在 `audio` 分组；原代码丢弃该分组且只检查 `llm/asr`，会错误提示模型不可用。现在 `TokenhubClient.listModels` 保留可选 `audio`，运行时仍按当前用户目录、固定模型 ID 判断权限。测试覆盖目录传递和另一用户不可越权使用该模型。

修改后 `pnpm build` 五包通过；`pnpm test --maxWorkers=4 --minWorkers=1` 为 2,308 通过、80 条件跳过（298 文件通过、14 跳过）。core/server 严格检查输出与修复前一致，仍为历史 12/237 项，新增验收脚本的定向类型诊断为零。全量结果包含工作区同期已有的 Responses 修改，本轮未改动这两份文件。

初次探测在模型目录检查时停止，尚未生成付费意图。修复后才提交真实 ASR；没有重试未知调用，没有改动账号允许列表或使用共享回退凭证。

## 回执与证据

ASR 响应 ID：`1cf02d3c-07b0-9335-acec-8a4d56204ee1`。转写内容为四川人品尝粤菜白切鸡的评价，与原片首帧可见文字和菜品相符；未进行逐字人工听校，也不宣称有逐字时间对齐。

本轮新增付费调用共 5 次：ASR 1 次、OCR 2 次、画面理解 1 次、摘要 1 次。每次都有 completed 回执、响应 ID 和真实用量；金额未估算。摘要包含 7 条事实/解读、2 条视觉时间线、3 条营销解读。4 条摘要和 3 条营销解读引用语音，时间线只引用画面/文字证据。

原始链接（含访问参数）、下载元数据、转写、快照与回执保存在 Git 忽略目录 `data/marketing-analysis-probes/acceptance-xhs-20261015/`：

- `download.json`、`frames.json`：下载与选帧结果。
- `asr/result.json`、`asr/receipts/`：转写、用量和可复用意图。
- `analysis-2-2/report.json`、`analysis-2-2/receipts/`：带语音的真实摘要与视觉步骤回执。

短时公网 WAV 在请求后删除；验收报告不收录访问令牌、带参数来源链接或密钥。真实素材和账本为后续核对保留，不应提交 Git。

## 复现入口与剩余门禁

无模型调用的公网探测：

```sh
pnpm check:marketing-analysis:audio-url
```

本机素材探测使用 `MARKETING_ANALYSIS_LOCAL_DIR` 指向专用私有目录，按 `pnpm check:marketing-analysis:local download`、`speech`、`analyze` 执行。后两步要求 `MARKETING_ANALYSIS_LOCAL_MODEL_CALLS=1`；新目录会产生真实调用，已有目录只能复用同输入的已知回执。`analyze` 的抽帧数由 `MARKETING_ANALYSIS_LOCAL_MAX_OCR` / `MARKETING_ANALYSIS_LOCAL_MAX_VISUAL` 控制，本次均为 2。

Linux 前置条件复现（只读、一次性容器）：

```sh
docker run --rm --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 32 --memory 128m --user 65534:65534 debian:trixie-slim \
  unshare --user --map-root-user --net --pid --fork true
```

本机 Docker Desktop 内核为 `6.12.76-linuxkit`，`user.max_user_namespaces=31733`，但上述命令仍被拒绝；具体是哪层运行策略拒绝尚未确定。另一已有 Ubuntu Noble 镜像同样拒绝。应在允许非特权 namespace 且包仓库证书链有效的 Linux 环境，继续用正式 `Dockerfile.media-analysis` 验证进程启动、任务目录外读写拒绝、解码器断网、下载出口约束、取消与资源上限；当前不满足发布门禁。

抖音、B 站按用户决定不再自动测试。生产任务 PG/Redis 归属、草稿原子回填沿用既有回归，本轮没有用真实视频创建生产账号任务、生成新视频或验证逐字音画对齐。
