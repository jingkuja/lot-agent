# 微信小程序虚拟支付实现方案

更新：2026-10-09。小程序使用 `wx.requestVirtualPayment` 的 `short_series_goods` 道具直购。**小程序 + Agent 后台完成支付闭环；New API 只负责额度入账、回退和记账订单展示。** 网页/桌面原有支付宝和微信二维码充值继续使用原网关。

## 职责与数据边界

| 组件 | 职责 | 持久化内容 |
| --- | --- | --- |
| 小程序 | 加载报价、获取一次性 wx.login code、调起支付、查询到账结果 | 按登录账号保存待确认订单号 |
| Agent 后台 | 校验登录会话与订单归属、换取付款人 OpenID、定价、创建订单、支付签名、微信查单、退款同步、确认发货、补偿重试 | PostgreSQL `virtual_payment_orders`：用户、New API 用户 ID、积分/实付、商品/AppID/OfferID/OpenID/环境快照、状态和查单租约 |
| New API | 接收 Agent 的 HMAC 记账通知，原子写业务订单/充值记录/托管 Key 账本，按累计退款回退额度 | 订单号、用户、来源、支付渠道、平台流水号、积分/实付/额度、累计退款、未追回额度 |

New API 不配置或保存微信 AppID、Secret、OfferID、AppKey、商品、session_key，不调用微信签名、查单、发货接口。已有账号绑定字段属于登录账户体系，不属于新增支付配置。session_key 只在 Agent 单次签名请求内使用，不写订单，不发给 New API 或客户端。

## 积分与金额

- **100 积分 = 1 元**。原价（分）等于积分数量；档位从 `WECHAT_VIRTUAL_PAY_GOODS` 动态读取并升序展示，支持 1 到 10000000 的整数积分，例如 1 积分 = ¥0.01。默认示例为 100 / 500 / 1000 / 2000 / 5000 / 10000。
- Agent 读取既有通用充值折扣规则 `amount_discount`，采用不高于当前积分的最大门槛。实付分值按十进制四舍五入；到账积分不打折。该通用规则不包含微信配置。
- New API 初次记账时仍使用 `Trunc(积分 / 100 × QuotaPerUnit)`。例如 1000 积分、9 折实付 9 元，默认 `QuotaPerUnit=500000` 时入账 5000000 quota；后续退款与重试使用这个固定额度快照。
- Agent 在创建订单时固定积分、实付、商品与环境。前端 `expectedAmountFen` 与服务端不一致则拒绝下单。
- `goodsPrice` 传原价分值；折扣价传 `activitySellingPrice`，每单购买一个积分包。
- 入账目标始终是 Lot Agent 托管 Key：`owner_app=lot-agent`、`billing_target=managed_token`、`order_source=lot-agent-miniprogram`、`payment_method=wxpay_virtual`。用户普通钱包不变。

## 支付流程

1. 小程序调用 `/api/recharge/info?client=miniprogram&platform=...`。Agent 返回已配置商品的价格；配置或报价不可用时关闭充值入口。
2. 小程序通过 wx.login 获取一次性 code。Agent 的 `exchangeWechatPaymentCode` 换取付款人的 OpenID/session_key；入账用户取自当前 Agent 登录会话和服务端保存的 New API 用户映射。历史微信登录绑定不作为支付前提，付款不会重绑或切换账号，也不接受客户端指定入账用户、OpenID 或 session_key。
3. Agent 持久化订单后生成原始 `signData` 和 `paySig=HMAC-SHA256(AppKey, 'requestVirtualPayment&'+signData)`；再计算 `signature=HMAC-SHA256(session_key, signData)`。两处使用完全相同的 JSON 字节，session_key 按原始字符串使用。
4. 小程序调起 `wx.requestVirtualPayment`，将订单号按账号保存。客户端回调不作为到账依据；重新打开页面可恢复查询。
5. Agent 通过 `/xpay/query_order` 校验订单号、环境、现金订单类型、实付、平台流水号和支付时间。仅微信服务端确认的结果可以产生记账通知。
6. Agent 向 New API 发送记账通知。New API 在同一事务中创建小程序来源的业务订单、TopUp 和托管 Key 账本，处理累计退款，再返回确认。
7. 收到正确的记账回执后，Agent 调用 `/xpay/notify_provide_goods` 确认发货。

采用官方允许的**服务端轮询发货**方式，不要求微信消息推送接收地址。本次没有主动退款界面或 iOS 退款问询接口；微信/Apple 侧退款结果通过服务端查单同步。

## 记账接口与故障恢复

`POST /api/internal/agent-managed-recharge/receipts`，使用现有 HMAC 内部控制面和 `agent:key.credit` 权限，不接受普通用户会话或模型 API Key。

```json
{
  "owner_app": "lot-agent",
  "user_id": 7,
  "transaction_id": "LV0123456789abcdef0123456789abcd",
  "points": 1000,
  "paid_amount_fen": 900,
  "refunded_fen": 0,
  "payment_method": "wxpay_virtual",
  "order_source": "lot-agent-miniprogram",
  "provider_trade_no": "provider-order-id",
  "paid_at": 1791500000
}
```

- 首次通知生成记账订单并入账；`refunded_fen` 表示累计退款，0 为尚未退款。后续通知沿用完全相同的原交易事实，仅累计退款可增加。
- 同一订单与平台流水分别有唯一约束；用户、来源、实付、积分或流水冲突会被拒绝。重复或更旧的退款总额不会再次扣款，退款后的旧支付通知不会重新入账。
- 如果首次观察已全退，同一事务中记录原始充值及等额回退，外部不会观察到可消费的临时余额，账本仍保留完整审计轨迹。
- 回退 quota = 原入账 quota × 累计退款 / 原实付，截断后减去此前累计回退 quota；全退精确回收原入账额度。
- 已消费额度不足回收时，保存 `refund_debt_quota` 并禁用托管 Key；运营需核对债务和消费记录后处理，不把欠额当作已追回。
- 生产订单继续使用现有推广规则；记账事务写入推广成功/回退事件，推广 worker 不重复累加退款额。首次记账时固定推广规则快照。
- Agent 每 15 秒扫描到期订单，数据库 120 秒租约与 lease ID 防止多实例同时处理或旧进程覆盖新结果。未完成订单通常 15 秒检查；错误后 60 秒重试；已交付或超过一天的订单按小时检查，继续发现退款。
- New API 不可用、响应丢失或 Agent 重启：订单仍在 Agent 数据库，下一轮查询微信后重发幂等通知。发货失败同样先重新查单再补确认。
- 沙箱订单只在 Agent 留存并显示 `sandbox_paid`，绝不通知正式账本，不产生真实额度或推广奖励。停用新销售不停止历史订单核对。

New API 的充值记录保留原实付和累计退款，来源显示“Lot Agent 小程序”；Agent 的充值明细也显示退款金额。

## 配置与部署

只在 **Agent 后台** 配置，已加入根目录 `.env.example`、`deploy/.env.example` 和 Docker Compose 透传：

```dotenv
WECHAT_MP_APPID=
WECHAT_MP_SECRET=
WECHAT_VIRTUAL_PAY_ENABLED=0
WECHAT_VIRTUAL_PAY_ENV=0
WECHAT_VIRTUAL_PAY_OFFER_ID=
WECHAT_VIRTUAL_PAY_APP_KEY=
WECHAT_VIRTUAL_PAY_SANDBOX_APP_KEY=
WECHAT_VIRTUAL_PAY_GOODS={"100":"lot_points_100","500":"lot_points_500","1000":"lot_points_1000","2000":"lot_points_2000","5000":"lot_points_5000","10000":"lot_points_10000"}
```

`ENV=0` 现网、`1` 沙箱；两套 AppKey 不互相回退。商品 ID 必须替换为微信后台实际已发布的商品，原价分别为对应积分数量（分）；可以仅配置部分档位。切换环境或停用销售后，保留历史订单对应 AppID/OfferID 和密钥。改变商户身份前完成旧订单核对；不匹配的历史订单会保留并等待原配置恢复。

`WECHAT_VIRTUAL_PAY_GOODS` 只配置积分与道具 ID 的映射，不会自动在微信后台创建或发布道具。微信返回 `product_id_not_publish`（文档对应 `-15010`）时，应到微信公众平台 → 虚拟支付 → 道具管理检查实际请求的 ID。正式环境 `env=0` 必须使用已发布到现网的道具，仅上传、保存到开发版本或发布小程序代码均不能替代道具发布。例如 `"100":"lot_points_100"` 要求微信中存在并发布 ID 完全一致、原价为 100 分（¥1）的道具。若后台实际 ID 不同，修改 Agent 映射并重启服务；若刚发布，待发布生效后再创建新订单。官方对 `-15014`（发布未生效）的说明是约 10 分钟，该时间不是未发布错误的自动修复时限。

`coin_or_product_id_created_in_recently` 表示道具/代币刚创建或发布，仍待生效。页面会按“发布尚未生效”解释该返回，即使客户端只给出通用错误码或缺少数字错误码，也保留原始原因。通常从商品发布起等待约 10 分钟后手动重新支付，届时生成新订单；不会自动重试支付或根据客户端回调入账。

**¥0.01 测试档位**：配置键是积分数量/原价分值，不是元，因此使用 `"1"`，不要写 `"0.01"`。可以增加 `"1":"lot_points_1"`，也可使用 `"1":"lot_points_100"`；商品 ID 的后缀不参与金额计算，微信后台对应商品的实际原价也应是 1 分。已有商品若仍标价 100 分，需要修改微信后台价格或另建 1 分商品。Android 会展示该档位；iOS 仍隐藏不足 ¥1 的实付档位。修改环境变量后重启或重新创建 Agent 服务容器，再刷新小程序充值页。

1. 先部署 New API 记账接口，沿用 `AGENT_INTERNAL_CLIENT_ID/SECRET` 与 IP 限制，确保 `AGENT_INTERNAL_CLIENT_SCOPES` 包含 `agent:key.credit` 和现有读取权限。不添加任何微信支付环境变量。
2. 部署 Agent，启动时执行新增迁移 **0033-virtual-payment**，创建持久化支付订单表。版本 32 在既有数据库中已由 `comic-drama` 使用，因此支付使用 33；曾执行过旧支付迁移的环境会保留已有表和订单。迁移器会检查已应用版本的名称，发现同号异名时在接收请求前报错。确保 Agent 可访问微信 API、New API 内部接口以及 PostgreSQL。
3. 在 Agent 配置商户、商品与沙箱密钥后启用销售，发布新版小程序；旧版普通小程序支付请求不回退旧 JSAPI。既有普通网关订单仍可按原方式结算。
4. Android 沙箱验证调起、取消、断网恢复、用户退出、重复查询、发货与退款。再用正式小额订单验证真实入账及退款。
5. iOS 需微信 8.0.68+、iOS 15+、中国大陆 App Store 账户，最低实付 1 元，不支持沙箱。还需在微信公众平台 → 虚拟支付 → 基础配置中填写并保存“小程序简称”，用于 Apple 支付展示名称。Agent 隐藏不合格报价，最终资格由微信 API 判定。

开发者工具模拟器仅用于预览充值档位；页面检测到 `platform=devtools` 时会提示使用“预览”或“真机调试”，并停止创建支付订单。¥0.01 档位请用 Android 手机微信测试。真机支付失败时弹窗和页面会保留微信错误码及原因，例如 `-15013` 表示商品价格与微信后台不一致，`-15010` 表示商品未发布，`-15006` 表示支付签名错误；不要仅凭客户端提示判断扣款或入账，订单仍由服务端查单确认。

`-15001` 是通用参数错误，必须结合原始 `errMsg` / `err_msg` 定位具体字段。错误弹窗会同时显示中文说明、错误码和脱敏后的“微信返回”；若微信只返回错误码和 `requestVirtualPayment:fail`，弹窗会明确显示“微信未提供具体错误原因”，不能据此推断某一个参数必然有误。真机调试控制台的 `virtual payment failed` 记录还包含订单号、微信版本和系统版本。已知错误码也不能覆盖原始说明，控制台不输出支付签名、session_key、OpenID 或带参数的 URL。修改代码后需重新生成预览 / 真机调试二维码并扫码进入；电脑端编译不会替换手机已经打开的预览包。

如果微信返回“当前商户尚未开启iOS支付”，页面显示“苹果支付暂不可用”，保留原始原因与错误码。先将实际订单的 AppID、OfferID、环境与截图所在虚拟支付后台核对，再检查小程序简称及 Apple IAP 开通状态。若同一商户后台已开通、订单为现网且其他 iOS 条件满足，现有证据指向微信后台展示与交易侧资格校验状态不一致，需要微信侧进一步核查；官方接入文档未注明该状态的固定同步时长，不能套用商品发布“约 10 分钟”的说明。反馈时提供 AppID、OfferID、请求时间、业务订单号、原始错误、开通状态截图；不要附带 AppKey、AppSecret、session_key 或完整签名请求。支付结果仍以微信查单为准，客户端失败回调不会触发 New API 入账。

真实商户联调需要实际凭据、已发布商品和真机，代码测试不能替代收款/退款验收。本次不修改生产配置，不执行线上迁移或部署。

## 代码与验证

- Agent：`payments/service.ts`、`payments/wechat-virtual.ts`、`payments/repository.ts`、`routes/recharge.ts`、`auth/wechat.ts`、`db/migrations/0033-virtual-payment.ts`。
- New API：`controller/managed_recharge_receipt.go`、`model/managed_recharge_receipt.go`，既有业务订单、TopUp、推广和订单查看入口。

```bash
pnpm exec vitest run packages/server/src/payments packages/server/src/routes/recharge.test.ts packages/server/src/auth/wechat.test.ts packages/server/src/tokenhub/client.test.ts packages/miniprogram/recharge-page.test.ts
pnpm --filter @lot-agent/core build
pnpm --filter @lot-agent/server build
pnpm --filter @lot-agent/miniprogram build
pnpm --filter @lot-agent/web build
# new-api-src
 go test ./model ./controller ./service/promo ./middleware
 go build -o /tmp/new-api-agent-receipts .
```

官方资料：[业务能力与发货流程](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html)、[客户端参数](https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html)、[查单接口](https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_query_order)、[发货确认](https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_notify_provide_goods)。
