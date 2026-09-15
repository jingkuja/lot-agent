# LOT 印社（packages/miniprogram）

微信小程序端，和桌面端一样是**独立模块**：自己的 UI 与工程，不复用 `packages/web` 的页面。
会话、生成任务、计费全部打到同一套 Lot Agent 服务端，走 **图片 Agent**（`agentId=image`）
和现有的 `POST /api/conversations/:id/generations`。

本期范围：**文生图、营销海报样张、个人以图修图**。不做视频 / PPT / 数字员工。

## 架构

```
微信小程序（packages/miniprogram/miniprogram）
    wx.request / wx.uploadFile / wx.downloadFile
            │
            ▼
Lot Agent server  /api  /static
    图片 Agent 会话 + BullMQ image.generate + 同一套额度
```

- 合法域名（正式版）：request / uploadFile / downloadFile 都要配服务器主机名。
- 开发版：微信开发者工具可勾选「不校验合法域名」，服务器地址在连接页或「我的」里改。
- 相对路径 `/static/...` 会拼到当前配置的 API 根地址。

## 功能

| 页 | 作用 |
|---|---|
| 印台（生图） | 画布 + 底部发稿条。比例 / 清晰度 / 模型，可选参考图。生成按钮是圆形「印」 |
| 样张（海报） | 营销海报模板，填主题后把稿送到印台 |
| 印稿（相册） | `GET /conversations?agentId=image&includePreview=1` |
| 账房（我的） | 同一账户额度、绑定手机号、服务器地址、重新连接 |
| 修图 | 先选照片再改；也可把参考图丢回印台 |

微信静默登录：配置 `WECHAT_MP_APPID` + `WECHAT_MP_SECRET` 后，启动时 `wx.login`
换 `POST /api/auth/wechat-login`。未知 openid 会在 tokenhub 创建账号（用户名前缀
`wx_mini_`，展示名 `wx_mini`），并写入 **小程序字段** `wechat_mp_openid`。
Web 微信扫码登录继续用原来的 `wechat_id`，两套身份互不覆盖。

个人中心可授权获取手机号（`getPhoneNumber` → `POST /api/auth/wechat-phone-bind`）：
该手机号无人使用则直接绑定；已有 tokenhub 用户则当前小程序身份并入该手机号账号。

## 开发

1. 本机先起 Lot Agent 服务端（`npm run dev:server` 等）。
2. 用[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
   打开目录 `packages/miniprogram`（`miniprogramRoot` 已指向 `miniprogram/`）。
3. 启动失败时可在连接页或「我的」把服务器改成 `http://127.0.0.1:3000`（或你的盒子地址），勾选不校验域名。
4. `DEBUG=1` 时服务端跳过登录，小程序也会直接进印台。

```bash
node packages/miniprogram/scripts/make-tab-icons.mjs   # 重新生成 tab 图标
npm run build -w @lot-agent/miniprogram                # tsc --noEmit
```

`project.config.json` 里 `appid` 先是 `touristappid`。正式发版换成微信后台的 AppID，
并把同一对 AppID/Secret 写入服务端环境变量。

## 账号合并待办

手机号命中已有账号时，当前实现只把小程序 `wechat_mp_openid`（及 unionid）挪到该账号，并切换会话。以下尚未处理：

- 积分 / 额度：`wx_mini_*` 账号上的 tokenhub quota、托管订阅 key 余额不会并入手机号账号。
- 本地资料：lot-agent 侧对话、作品、上传、任务仍挂在被放弃的本地 user id 上。
- 展示资料：用户名 / 邮箱 / 邀请关系 / 已有 `wechat_id` 保持手机号账号原值。
- 被放弃的 `wx_mini_*` 用户没有回收或注销流程。
- 手机号账号若已绑定另一个小程序 openid，绑定会失败，不会强制抢绑。

## 设计

夜班印刷厂灯箱：**墨底** `#12161C`、**印青色** `#3EE0C2`、结果落在**暖色纸面** `#F4EFE4` 上，
四角是品红套准线。生成动作叫「印」，不是发送箭头。
