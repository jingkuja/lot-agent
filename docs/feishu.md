# 飞书接入

账号菜单 →「飞书接入」→「连接飞书」。普通用户不需要到开发者后台创建应用、复制密钥或配置权限：

1. 用飞书扫描官方创建二维码，确认创建专属 Lot Agent 机器人。
2. 使用同一飞书账号确认用户授权，页面自动轮询并进入验证步骤。
3. 在 Agent 页面输入机器人私聊发来的六位验证码，完成绑定。验证码 10 分钟有效，最多尝试 5 次，不要提供给他人。

扫码时保持接入窗口打开，网页按飞书要求的间隔轮询授权结果，不需要设置回调地址。关闭窗口后重新打开可继续未过期的接入。绑定完成后，消息通道状态每 5 秒自动刷新；长连接尚在建立时显示“连接中”。

每个 Lot 用户在**通用 Agent 历史顶部只有一条置顶的「飞书」会话**。飞书发来的文字任务、命令、排队状态、结果、失败和取消都显示在这里；重新授权或断开后再接入仍使用同一条会话。会话内容自动刷新，网页端用于查看记录，任务和取消指令从飞书发送。不会在飞书客户端执行置顶操作。

## 服务端配置

必需：按 `.env.example` 的说明配置 `SECRET_MASTER_KEY`。用户应用密钥、设备码、待绑定凭证及 OAuth Token 全部在服务端加密保存。默认启用；`FEISHU_ENABLED=0` 可关闭集成。

`FEISHU_LONG_CONNECTION=1`（默认）开启机器人私聊。设为 `0` 仅保留扫码绑定和主动发送，不接收机器人任务。服务器需要出站访问 `accounts.feishu.cn`、`open.feishu.cn` 以及飞书 SDK 的 WebSocket 服务；无需公网事件回调或 OAuth 回调地址。

`FEISHU_APP_ID` / `FEISHU_APP_SECRET` 仅用于兼容迁移前已绑定的共享应用，新用户扫码接入不需要配置。原 `FEISHU_REDIRECT_URI` 已停用。旧公共 `/api/public/feishu/start`、`/callback` 返回 410；反向代理保留该路径不记录查询参数，避免旧授权链接进入日志。

正式部署需要更新并重启服务端；启动时应用迁移 `0038`。新迁移会合并旧版有效「飞书任务」会话，保留原消息 ID、运行记录和追踪关联。旧版未保存的命令结果明确标记“原版本未保存结果正文”，不会伪造历史输出。迁移前运行中的任务标记为结果待核实，不自动重放。

## 官方协议与边界

- `onboarding-client.ts` 实现官方 `PersonalAgent` 扫码创建协议：`POST https://accounts.feishu.cn/oauth/v1/app/registration` 的 `begin` / `poll`。
- 使用返回的 `verification_uri_complete` 机器人确认页；按官方 Node SDK 的格式传递 `createOnly=true`、应用名称和 gzip/base64url `addons`，预填最小机器人模板及消息权限/事件。不会自动改动用户已有的其他机器人。
- 应用身份权限：`im:message:send_as_bot`、`im:message.p2p_msg:readonly`；事件：`im.message.receive_v1`。用户身份权限：`im:message`、`im:message.send_as_user`，授权时请求 `offline_access`。
- 用户授权使用 `/oauth/v1/device_authorization`，凭据经 Basic Auth 传递；兑换及刷新使用 `/oauth/v3/token`。仅支持飞书国内版 Bearer Token。
- 扫码创建人和授权人的 `open_id` 必须一致；机器人验证码完成前不激活连接，不接收任务。设备码、应用密钥、Token、验证码不通过状态接口返回。转发二维码不足以把别人的飞书账号绑定到自己的 Lot 用户。
- 企业账号仍受飞书组织策略约束，可能需要管理员批准。官方 SDK 标注 addons 的额外配置存在灰度差异；最终权限以官方确认页和租户实际开通情况为准。

接入状态为未完成/过期时可重新连接。应用已经创建但后续授权失败时，重试会复用已保存的应用凭据；主动取消接入会清除待绑定凭据。如验证码投递结果不确定，先查看飞书私聊，不自动重发。

## 使用

在与机器人的私聊中发送：

```text
/send 张三 明天上午十点开会
给张三发：明天上午十点开会
/send ou_xxx 明天上午十点开会
/reply om_xxx 周五前交付
/help
/cancel
```

发送内容保持原文，收件人支持当前用户保存的联系人别名或当前应用的 `open_id`。按消息 ID 回复受用户实际访问范围约束。发送给其他人的消息使用用户 OAuth 身份，不会在授权失败时切换为机器人身份。设置页也提供本人发送/回复和联系人别名管理，尚无通讯录姓名搜索。

机器人只处理已绑定账号本人的文字私聊；群聊和未绑定用户不触发任务。普通文字通过 `AgentService.streamAgentResponse` 执行，沿用用户模型凭证、计费、运行记录和多轮上下文。任务最多运行 3 分钟，结果最多回传 3000 字符，完整文字保留在 Agent 会话中。

飞书会话首次执行文字任务时使用当前用户可用模型列表的默认项，与网页模型选择器顺序一致，并保存到该会话。已保存的模型继续沿用；有用户凭证但模型列表为空或读取失败时直接报错，不回退到服务端旧模型。模型上游失败属于任务执行错误，不表示飞书绑定或消息通道断开。

图片、视频实际生成/编辑请求统一回复 **后续支持，持续开发中...**。飞书渠道执行工具白名单为空，不能调用生成、子 Agent、文件或 Shell 工具；文字提示词和脚本可生成。显式发送指令中的文字不会被改写。首版不读取用户全部聊天、不监听个人全部私聊、不操作本机文件。

## 存储与并发

- `feishu_connections`：每用户的加密应用密钥、OAuth 凭证、权限和绑定版本；同一应用/租户/飞书身份不能同时绑定多个 Lot 用户。
- `feishu_setups`：用户隔离的扫码阶段、过期时间、轮询间隔和验证码尝试次数；敏感载荷加密。
- `conversations.channel='feishu'`：部分唯一索引保证每用户只有一条；始终排序置顶，不能移入项目、删除或重新生成来截断历史。
- `feishu_inbox`：接收时事务内写入用户消息和结果占位，再异步执行。同一用户按接收顺序串行，不同用户并行；每个实例最多运行 8 个任务，跨实例通过数据库用户锁、唯一运行索引和会话租约隔离。
- `feishu_sends`：外部发送前提交意图并使用固定幂等键。结果不确定时不自动重发；相同 requestId 不能改变发送内容。
- 超过每分钟 30 条的普通任务仍记录到会话，但标为限流且不执行；取消指令不受此限制。重复消息与重复取消不会重复生效。
- 取消/断开使待处理任务落为取消，并通知运行中的任务停止；运行槽在原执行停止前不会提前释放。已发出的外部消息无法撤回。
- 崩溃后超过 5 分钟仍运行的任务标为 unknown 并释放租约，不重放。结果先持久化再回传；回传失败在会话和设置页标记“回传待核实”，不丢弃完整输出。

Token 刷新在用户锁内进行并保存 refresh_token 轮换；无法确认刷新结果时要求重新授权。HTTP 只访问固定官方域名，禁止重定向和自动写重试；SDK 原始事件与凭证不写日志。每个已绑定应用使用独立 SDK 长连接，连接配置每 5 秒同步一次。

受 Lot 登录保护的接口：`GET /api/feishu/status`、`POST /authorize`、`POST /setup/:id/poll`、`POST /setup/:id/confirm`、`DELETE /connection`、`POST /messages`、`POST /contacts`、`DELETE /contacts/:alias`。客户端不能覆盖所属用户。

## 验证与排查

```bash
pnpm --filter @lot-agent/core build
pnpm exec vitest run packages/server/src/feishu packages/server/src/routes/feishu-conversation.test.ts packages/server/src/services/message-repository.test.ts packages/server/src/services/agent-service.stream.test.ts packages/server/src/db/migration-runner.test.ts
pnpm --filter @lot-agent/server build
pnpm --filter @lot-agent/web build
pnpm check:feishu:ui
```

UI 检查使用本地模拟接口，需要 Playwright 和 Chrome；可通过 `PLAYWRIGHT_MODULE` 指定已有安装。数据库集成测试需显式设置 `FEISHU_TEST_DATABASE_URL`，仅接受空的 `lot_feishu_review_test_*` 专用数据库，提前安装 vector 扩展；不会使用业务 `DATABASE_URL`。测试会保留该专用库供检查，测试后由操作者删除。

状态接口返回 404 表示后端或代理尚未提供新版飞书路由；200 且 `configured:false` 表示未配置加密密钥或集成已关闭。桌面端沿用其设置中的服务器地址，重启本地服务不会更新桌面端所连的线上后端。界面提供状态刷新和超时提示。

自动化测试全部模拟飞书响应，不证明真实租户已放开权限。发布前需用真实飞书账号完成扫码、验证码、私聊任务和指定收件人的本人发送验证。

官方参考：[Node SDK](https://github.com/larksuite/node-sdk)、[官方扫码创建机器人说明](https://www.feishu.cn/content/article/7613711414611463386)、[CLI 设备授权](https://github.com/larksuite/cli/blob/main/internal/auth/device_flow.go)、[本人发送](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-send.md)。
