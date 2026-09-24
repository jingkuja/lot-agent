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

- 服务端地址写死在 `miniprogram/services/config.ts` 的 `API_BASE`，必须和服务端环境变量
  `PUBLIC_BASE_URL` 一致；小程序**没有**运行时改地址的入口（正式版受微信合法域名限制，改了也发不出去）。
- 合法域名（正式版）：request / uploadFile / downloadFile 都要配服务器主机名。
- 本地联调：在微信开发者工具里勾选「不校验合法域名」，并把 `API_BASE` 临时指向本机。
- 相对路径 `/static/...` 会拼到 `API_BASE` 上。

## 功能

| 页 | 作用 |
|---|---|
| 印台（生图） | 画布 + 底部发稿条。比例 / 清晰度 / 模型，可选参考图。生成按钮是圆形「印」 |
| 样张（海报） | 营销海报模板，填主题后把稿送到印台 |
| 印稿（相册） | `GET /conversations?agentId=image&includePreview=1` |
| 账房（我的） | 同一账户额度、绑定手机号、修改昵称、退出登录 |
| 修图 | 先选照片再改；也可把参考图丢回印台 |

微信静默登录：配置 `WECHAT_MP_APPID` + `WECHAT_MP_SECRET` 后，启动时 `wx.login`
换 `POST /api/auth/wechat-login`。未知 openid 会在 tokenhub 创建账号（用户名前缀
`wx_mini_`，展示名 `wx_mini`），并写入 **小程序字段** `wechat_mp_openid`。
Web 微信扫码登录继续用原来的 `wechat_id`，两套身份互不覆盖。

个人中心可授权获取手机号（`getPhoneNumber` → `POST /api/auth/wechat-phone-bind`）：
该手机号无人使用则直接绑定；已有 tokenhub 用户则当前小程序身份并入该手机号账号。

## 开发

1. 本机先起 Lot Agent 服务端（`pnpm run dev:server` 等）。
2. 用[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
   打开目录 `packages/miniprogram`（`miniprogramRoot` 已指向 `miniprogram/`）。
3. 连不上服务器时，先把 `miniprogram/services/config.ts` 的 `API_BASE` 改成
   `http://127.0.0.1:3000`（或你的盒子地址），并勾选不校验域名。
4. `DEBUG=1` 时服务端跳过登录，小程序也会直接进印台。

```bash
node packages/miniprogram/scripts/make-tab-icons.mjs   # 重新生成 tab 图标
pnpm --filter @lot-agent/miniprogram run build                # tsc --noEmit
```

`project.config.json` 里 `appid` 先是 `touristappid`。正式发版换成微信后台的 AppID，
并把同一对 AppID/Secret 写入服务端环境变量。

## 账号合并

手机号命中已有账号时，会先弹出确认，列出将转入的托管额度、账户积分、对话和作品；确认后：

- tokenhub 把 `wx_mini_*` 的 wallet quota 和托管 key 余额转入手机号账号
- lot-agent 把本地 `user_id` 资料改挂到该账号
- 当前 `wx_mini_*` 账号注销（tokenhub 禁用，本地用户删除）

用户名、邮箱、邀请关系和已有 `wechat_id` 仍保留手机号账号原值。若该手机号账号已绑定另一个小程序 openid，绑定会失败。

## 试用反馈第一批改动 2026-09-21

- “我的”不单独展示开关状态卡片。仅在开关开启时，在积分卡片底部显示“积分不足时使用灵渠 AI 余额”；关闭、加载中或加载失败时不显示该句。
- “了解更多”提供产品介绍、复制网页版地址 `https://todoucloud.com`、保存文字介绍海报。小程序页面及海报不展示中转站文案或入口。海报不包含二维码；作品推广海报和视频入口属于后续批次。
- 网页的中转站入口仍通过服务端 `TOKENHUB_PUBLIC_URL` 配置，使用公开的 `GET /api/public/product`；小程序的了解更多地址不依赖该接口。
- 预览页显式“创建分享卡片”后才能发送作品卡片。链接只包含随机分享标识，收件人无需登录即可查看选中的图片，不会读到作者会话、提示词历史或任务信息。作者在同一作品预览页可撤销；再次创建得到新标识，旧链接仍失效。已保存的图片和微信已有封面不会被远程收回。
- 分享冷启动不再被登录完成后的首页跳转覆盖。合并到另一账户时清理旧会话 ID、待用素材、任务缓存并重建页面。

部署服务端会自动应用迁移 23，为 `assets` 增加分享标识和标题；先部署服务端，再发布前端及小程序。本批不修改真实模型调用或网关扣费规则。撤销使分享页面失效，不改变已有 `/static/` 图片地址的访问策略。

验证记录：17 个测试文件、127 项相关测试通过；服务端、网页、小程序构建通过；tokenhub 的托管计费、额度组合矩阵及失败退款测试通过（使用内存数据库，无真实扣款）。额外执行的服务端全量 `tsc --noEmit` 仍有基线类型错误，对比 HEAD 未新增错误。小程序介绍海报通过本地 Canvas 渲染检查，但不代替微信真机验证。

真机验收：分别以已登录、未登录和过期会话打开作品卡片；作者撤销后再次打开；同一手机号两端核对积分与兜底开关；相册权限允许和拒绝时分别保存介绍海报；验证配置地址可以在浏览器打开。首次保存海报需用户授予相册权限。

## 原有设计说明

夜班印刷厂灯箱：**墨底** `#12161C`、**印青色** `#3EE0C2`、结果落在**暖色纸面** `#F4EFE4` 上，
四角是品红套准线。生成动作叫「印」，不是发送箭头。

## 当前视觉规范（2026-09-21）

本轮采用轻快的暖色生活风格：纸白背景、可可色文字、珊瑚色操作按钮，统一主题变量位于
`miniprogram/app.wxss`。旧版夜班印刷厂和粉色渐变样式仅保留在历史说明中。

- 修图页：可伸展画布、参考图 / 灵感 / 画面设置工具栏、完整宽度的描述输入区。
- 海报页：主题输入、下划线分类导航、原生文字与几何插画组成的风格示意封面；示意封面不是生成效果承诺。
- 作品页：图片与轻量标题组成的双列布局，生成中的封面和修图页共用全幅动态颗粒、正中百分比。
- 个人页、充值、预览、修图及启动页使用相同的文字层级、间距、按钮和配色；导航图标可通过 `pnpm --filter @lot-agent/miniprogram run icons` 重建。

本轮验证：小程序类型检查、19 项现有测试通过；微信开发者工具已检查修图、海报和个人页显示。
后台接口在检查时返回 502，未完成依赖在线数据的生成、作品和充值流程联调，也未进行真实支付。

### 视频工作室（2026-09）

底部第二个导航为「视频」。海报模板入口移到「修图」页右上角，海报页可「返回自由创作」；「我的」中的海报入口也使用普通页面跳转。

视频按文案、标题标签、声音、画面、BGM/字幕、封面、发布分享七步编辑。模型档位固定为旗舰 `doubao-seedance-2-5`（1080p）、质量 `doubao-seedance-2-0`（720p）、快速 `minimax-video-h3`（480p），生成走原有 video Agent、用户 TokenHub key 和任务队列。模型 ID 需在实际 TokenHub 账户中可用。文案通过受鉴权、限流的 `POST /api/video-drafts` 生成，使用小程序配置的 LLM 并计入用量。

声音、配乐、字幕、封面文字目前均为视频模型的生成要求，没有独立 TTS 或后期合成；封面图作为首帧替代参考图，页面文字叠层只是示意。生成后需预览检查效果。草稿和未完成任务按用户 ID 保存在本地，切回页面可恢复查询；提交响应丢失时只查询原会话，不自动重提。历史成片在「作品 → 视频」中查看。

发布页支持保存 MP4、微信好友作品卡片和朋友圈卡片。只有用户点击准备分享才创建可撤销的公开令牌，访客只能看该作品。抖音／小红书入口会保存视频并复制文案，用户需在目标 App 中完成发布；没有调用尚未接通的 OAuth 直发接口。微信分享与相册权限需在真机验收，部署时需同时更新服务端，并确保静态视频域名已配置为小程序 downloadFile 合法域名。

小程序视频分辨率随模型档位固定，通过 `settings.resolution` 进入任务，并映射到 TokenHub 请求的 `metadata.resolution`，同时参与生成缓存键；画面比例仍由 `ratio` 独立传入。只传 `quality` 不满足 TokenHub 的视频 token 计费参数要求。
