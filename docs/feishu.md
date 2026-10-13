# 飞书接入

侧栏「当前 Agent」卡片的「飞书」或账号菜单的「飞书接入」→「连接飞书」。普通用户不需要到开发者后台创建应用、复制密钥或配置权限：

1. 用飞书扫描官方创建二维码，确认创建专属 Lot Agent 机器人。
2. 使用同一飞书账号确认用户授权，页面自动轮询并进入验证步骤。
3. 在 Agent 页面输入机器人私聊发来的六位验证码，完成绑定。验证码 10 分钟有效，最多尝试 5 次，不要提供给他人。

扫码时保持接入窗口打开，网页按飞书要求的间隔轮询授权结果，不需要设置回调地址。关闭窗口后重新打开可继续未过期的接入。绑定完成后，消息通道状态每 5 秒自动刷新；长连接尚在建立时显示“连接中”。

每个 Lot 用户在**通用 Agent 历史顶部只有一条置顶的「飞书」会话**。飞书发来的文字任务、命令、排队状态、结果、失败和取消都显示在这里；重新授权或断开后再接入仍使用同一条会话。会话内容自动刷新，网页端用于查看记录，任务和取消指令从飞书发送。不会在飞书客户端执行置顶操作。

## 服务端配置

必需：按 `.env.example` 的说明配置 `SECRET_MASTER_KEY`。用户应用密钥、设备码、待绑定凭证及 OAuth Token 全部在服务端加密保存。默认启用；`FEISHU_ENABLED=0` 可关闭集成。

`FEISHU_LONG_CONNECTION=1`（默认）开启机器人私聊。设为 `0` 仅保留扫码绑定和主动发送，不接收机器人任务。服务器需要出站访问 `accounts.feishu.cn`、`open.feishu.cn` 以及飞书 SDK 的 WebSocket 服务；无需公网事件回调或 OAuth 回调地址。

仅支持每个用户扫码创建专属机器人，不读取全局应用凭证。扫码返回的 `app_id` 和加密后的 `app_secret` 按当前登录用户保存到 `feishu_connections`；授权令牌刷新、机器人发送和长连接均使用该用户的应用凭证。缺失应用密钥的绑定不可使用，需断开后重新扫码接入。

旧公共 `/api/public/feishu/start`、`/callback` 仅返回 410，不提供授权；反向代理保留该路径不记录查询参数，避免旧授权链接进入日志。

正式部署需要更新并重启服务端；启动时应用迁移 `0038`。新迁移会合并旧版有效「飞书任务」会话，保留原消息 ID、运行记录和追踪关联。旧版未保存的命令结果明确标记“原版本未保存结果正文”，不会伪造历史输出。迁移前运行中的任务标记为结果待核实，不自动重放。

## 官方协议与边界

- `onboarding-client.ts` 实现官方 `PersonalAgent` 扫码创建协议：`POST https://accounts.feishu.cn/oauth/v1/app/registration` 的 `begin` / `poll`。
- 使用返回的 `verification_uri_complete` 机器人确认页；按官方 Node SDK 的格式传递 `createOnly=true`、应用名称和 gzip/base64url `addons`，预填最小机器人模板及消息权限/事件。不会自动改动用户已有的其他机器人。
- 应用身份权限：`im:message:send_as_bot`、`im:message.p2p_msg:readonly`；事件：`im.message.receive_v1`。用户身份权限：`im:message`、`im:message.send_as_user`、`contact:user:search`，授权时请求 `offline_access`。
- 用户授权使用 `/oauth/v1/device_authorization`，凭据经 Basic Auth 传递；兑换及刷新使用 `/oauth/v3/token`。仅支持飞书国内版 Bearer Token。
- 扫码创建人和授权人的 `open_id` 必须一致；机器人验证码完成前不激活连接，不接收任务。设备码、应用密钥、Token、验证码不通过状态接口返回。转发二维码不足以把别人的飞书账号绑定到自己的 Lot 用户。
- 企业账号仍受飞书组织策略约束，可能需要管理员批准。官方 SDK 标注 addons 的额外配置存在灰度差异；最终权限以官方确认页和租户实际开通情况为准。

接入状态为未完成/过期时可重新连接。应用已经创建但后续授权失败时，重试会复用已保存的应用凭据；主动取消接入会清除待绑定凭据。如验证码投递结果不确定，先查看飞书私聊，不自动重发。

## 使用

在网页、桌面端的任意 Agent 文字对话，或与机器人的飞书私聊中，直接提出发送要求，例如：

```text
获取昨天招商银行的收盘价发给我自己
帮我发消息给张三，告诉他明天上午十点开会
把刚才的总结发给张三
```

服务端在当前请求中注入 `feishu_contacts` 和 `feishu_send_message`，所有 Agent 共用本人飞书连接，并开放既有联网查询工具以支持先查后发。模型不能指定所属用户或幂等键。需要查询的任务先取得资料再发送；联系人通过官方 `POST /open-apis/contact/v3/users/search` 查询。无关键词时查询聊过的人；可按姓名/邮箱搜索、限制聊过的人、用返回的 pageToken 翻页，包含用户可见的外部联系人。同名、模糊匹配或仍有下一页时先消歧，不自动选第一项发送。设置页仅管理连接和授权状态，不再提供手动联系人或发送表单。

已有绑定需要点击「重新授权」授予 `contact:user:search`；新应用的创建模板已包含该权限。若旧应用或企业策略尚未允许此权限，需要管理员在飞书后台开通“搜索用户”后再授权，单纯更新代码不会扩充旧 Token 权限。查询使用所属用户的 Token 和绑定版本，授权失效或断开后不会返回联系人数据，也不会改用机器人身份搜索。

飞书私聊也兼容原有命令：

```text
/send 张三 明天上午十点开会
给张三发：明天上午十点开会
/send ou_xxx 明天上午十点开会
/reply om_xxx 周五前交付
/help
/cancel
```

发送内容保持原文，收件人支持官方搜索得到的姓名/邮箱或当前应用的 `open_id`。按消息 ID 回复受用户实际访问范围约束。发送给其他人的消息默认使用用户 OAuth 身份；用户明确要求机器人发送时，工具传入 `identity: "bot"`，使用当前绑定应用的 `tenant_access_token` 和 `im:message:send_as_bot`。已在对话中选定机器人身份的后续发送沿用该选择，无需重复确认或填写表单；不会在本人发送失败时擅自切换身份。成功回执明确返回 `identity` 和 `messageId`。“我自己 / 自己 / self”由专属机器人直接投递到当前绑定账号，不需保存联系人或让用户向自己发送；这不是给其他联系人发送失败时的身份回退。旧版联系人数据及接口保留兼容，新的对话工具不依赖手动别名。

机器人只处理已绑定账号本人的文字私聊；群聊和未绑定用户不触发任务。普通文字通过 `AgentService.streamAgentResponse` 执行，沿用用户模型凭证、计费、运行记录和多轮上下文。任务最多运行 30 分钟（仍受 Agent 自身运行预算约束），结果最多回传 3000 字符，完整文字保留在 Agent 会话中。

飞书会话首次执行文字任务时使用当前用户可用模型列表的默认项，与网页模型选择器顺序一致，并保存到该会话。已保存的模型继续沿用；有用户凭证但模型列表为空或读取失败时直接报错，不回退到服务端旧模型。模型上游失败属于任务执行错误，不表示飞书绑定或消息通道断开。

飞书沿用 Web 通用助手的服务端工具白名单，包括文档、PPT、生成、技能和子 Agent 等当前已注册工具，不再设置额外的纯文字/媒体请求拦截。各工具的用户归属、输入校验、网络保护、取消与写入幂等继续生效；桌面本机桥接仍需桌面工作目录授权，普通 Web 不开放的宿主 Shell/文件工具也不会因飞书接入而开放。

`ask_user` 的问题/选项、`propose_outline` 的可读大纲会回传飞书，状态记为 `awaiting_input`（等待回复），用户直接在飞书回复后通过历史继续。Web 仍保存原工具调用及交互卡片。文档/PPT 的下载链接由通道从成功工具回执提取，避免模型改写链接；相对链接需 `PUBLIC_BASE_URL` 才能在飞书打开，未配置时提示到 Lot Agent 会话下载。超过 3000 字符的回传附带完整内容查看提示，不静默丢弃长结果。

联网搜索继续使用 `BIGMODEL_API_KEY` 配置；没有有效搜索凭据时不得编造查询结果。不会读取用户全部聊天或监听个人全部私聊。

## 存储与并发

- `feishu_connections`：每用户的加密应用密钥、OAuth 凭证、权限和绑定版本；同一应用/租户/飞书身份不能同时绑定多个 Lot 用户。
- `feishu_setups`：用户隔离的扫码阶段、过期时间、轮询间隔和验证码尝试次数；敏感载荷加密。
- `conversations.channel='feishu'`：部分唯一索引保证每用户只有一条；始终排序置顶，不能移入项目、删除或重新生成来截断历史。
- `feishu_inbox`：接收时事务内写入用户消息和结果占位，再异步执行。同一用户按接收顺序串行，不同用户并行；每个实例最多运行 8 个任务，跨实例通过数据库用户锁、唯一运行索引和会话租约隔离。
- `feishu_sends`：外部发送前提交意图并使用固定幂等键。结果不确定时不自动重发；相同 requestId 不能改变发送内容或身份。显式机器人发送有独立幂等键；同一用户输入的另一身份若已发送成功或结果未知，不允许通过切换身份再次投递。获取机器人 Token 失败发生在消息提交前，记为明确失败，不误报消息结果未知。
- 超过每分钟 30 条的普通任务仍记录到会话，但标为限流且不执行；取消指令不受此限制。重复消息与重复取消不会重复生效。
- 取消/断开使待处理任务落为取消，并通知运行中的任务停止；运行槽在原执行停止前不会提前释放。已发出的外部消息无法撤回。
- 崩溃后超过 35 分钟仍运行的任务标为 unknown 并释放租约，不重放。结果先持久化再回传；回传失败在会话和设置页标记“回传待核实”，不丢弃完整输出。

Token 刷新在用户锁内进行并保存 refresh_token 轮换；无法确认刷新结果时要求重新授权。HTTP 只访问固定官方域名，禁止重定向和自动写重试；SDK 原始事件与凭证不写日志。每个已绑定应用使用独立 SDK 长连接，连接配置每 5 秒同步一次。

明确被飞书拒绝的发送保持 `failed`，同一消息再次按姓名或 ID 调用不会重发，也不会误报为结果未知。接口失败回执保留数值错误码，不透传上游原始响应或凭据。通道读取完整事件流直到 `done` 和服务端收尾，避免丢失真实终态；失败消息优先展示受控的飞书错误/错误码、已确认的发送回执及运行 ID。仅有模型“准备发送”的文字不代表成功；已确认发送后模型总结失败也不会丢掉消息 ID。旧记录若只保存通用拒绝文字，无法从中还原官方错误码。

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

自动化测试全部模拟飞书响应，不证明真实租户已放开权限。发布前需用真实飞书账号完成扫码、验证码、私聊任务、联系人权限升级/搜索、同名选择、文档生成及指定收件人的本人发送验证。

发送错误码 `230038`（`Cross tenant p2p chat operate forbid.`）表示跨租户单聊不允许通过发送消息接口发送。该请求明确失败，不是 Token 失效或缺少普通发送 scope；重新授权、将 open_id 换成姓名都不能解除这一接口限制。联系人搜索成功不代表允许发送。机器人对外共享属于另一种身份及配置，不得自动切换身份或宣称开通它即可修复本人私信。依据：[发送消息官方错误码表](https://open.feishu.cn/document/server-docs/im-v1/message/create)。

### 自动以机器人身份发送给外部联系人

用户在对话中说“用机器人身份发给 Anson”，助手搜索官方联系人后调用 `feishu_send_message(identity="bot")`。首次启用的前置条件不等于每次手动发送：

1. 应用需为支持对外共享的企业自建应用，所属企业/团队完成认证，或完成个人实名认证。
2. 飞书开发者后台 → 应用发布 → 版本管理与发布 → 创建版本 → 对外共享，开启“允许外部用户与机器人单聊”，发布版本并完成管理员审核；配置了首次使用审核时，由应用所有者审批。
3. 外部联系人必须主动打开 `https://applink.feishu.cn/client/bot/open?appId=<当前应用ID>` 并确认开启单聊。即使开启对外共享且免审核，机器人也不能直接主动建立首次外部私聊。
4. 完成后，用户在 Lot Agent / 飞书对话提出发送要求即可由工具自动发送；外部联系人的聊天不会触发所属用户的 Agent 任务。

机器人发送返回 `230013` 时，应检查对外共享、收件人单聊确认、可用范围及禁用名单；失败回执提供当前应用的启用链接。不能由该错误单独断言哪项配置缺失。不会循环 OAuth 授权、自动重试或声称已送达。应用信息查询的 `99991672` 仅说明该查询权限不足，不能证明消息接口不可用。

依据：[飞书机器人对外共享及首次单聊条件](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/develop-robots/add-bot-to-external-group)、[打开机器人官方协议](https://open.feishu.cn/document/uAjLw4CM/uYjL24iN/applink-protocol/supported-protocol/open-a-bot)。

官方参考：[Node SDK](https://github.com/larksuite/node-sdk)、[官方扫码创建机器人说明](https://www.feishu.cn/content/article/7613711414611463386)、[CLI 设备授权](https://github.com/larksuite/cli/blob/main/internal/auth/device_flow.go)、[本人发送](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-send.md)。

联系人接口依据：[飞书官方 CLI 的搜索实现](https://github.com/larksuite/cli/blob/main/shortcuts/contact/contact_search_user.go)、[官方使用说明](https://github.com/larksuite/cli/blob/main/skills/lark-contact/references/lark-contact-search-user.md)。
