# Lot Agent 积分充值

## 方案

Lot Agent 复用 New API 已配置的支付宝/微信直连支付网关和回调，不单独持有 MID、商户密钥或回调验签密钥。

选择该方案的原因：

- 支付订单、验签、补单和充值账本集中在 New API，避免两套资金逻辑。
- Lot Agent 与 New API 之间使用独立的 HMAC 内部控制面，不向浏览器暴露内部密钥。
- Agent 充值通过订单来源和入账目标与普通 New API 充值隔离。

## 调用链

1. Lot Agent 从 New API 获取当前启用的支付宝/微信支付方式。
2. 用户输入积分并选择支付方式；`100 积分 = 1 CNY`。
3. Lot Agent 服务端通过签名内部接口创建订单。
4. New API 创建 `PaymentBusinessOrder`，并写入：
   - `order_source = lot-agent`
   - `billing_target = managed_token`
   - `managed_owner_app = lot-agent`
   - `managed_quota_delta = 本次应充额度`
5. 微信下单返回 `code_url`，Lot Agent 在弹窗内生成二维码；支付宝下单返回 `pay_url`，Lot Agent 在新标签中打开支付页。
6. 支付网关验签并核对金额后调用 New API 的内部支付成功接口；New API 通过幂等账本给用户的 Lot Agent 托管 Key 入账。
7. Lot Agent 轮询 `PaymentBusinessOrder` 状态；成功后刷新积分余额。

普通 New API 充值使用 `order_source = new-api`、`billing_target = user_wallet`，不会进入 Agent 托管 Key。

## 幂等和补单

- 托管充值账本以 `(owner_app, transaction_id)` 唯一约束防止重复入账。
- 支付回调重复投递时，账本返回重复结果，不会再次增加额度。
- Agent 来源订单只增加托管 Key，普通订单只增加用户钱包。
- 订单状态与托管 Key 入账在同一数据库事务中完成；网关重复通知不会重复增加额度。

## 配置

支付配置仅放在 New API：

- `PAY_URL`：支付网关地址。
- `PAY_MERCHANT_ID`：商户标识；支付网关配置多个商户时必填。
- `INTERNAL_API_TOKEN`：New API 与支付网关之间的共享鉴权密钥。

New API 还需配置：

- `AGENT_INTERNAL_CLIENT_ID`
- `AGENT_INTERNAL_CLIENT_SECRET`
- `AGENT_INTERNAL_CLIENT_SCOPES`，包含 `agent:recharge.read` 和 `agent:recharge.create`
- 可选 `AGENT_INTERNAL_ALLOWED_IPS`

Lot Agent 配置对应的：

- `NEW_API_INTERNAL_BASE_URL`
- `NEW_API_INTERNAL_CLIENT_ID`
- `NEW_API_INTERNAL_CLIENT_SECRET`

两端 client id、secret 必须一致。生产环境不得使用示例密钥。
