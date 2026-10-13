# Web 与桌面同步验证（2026-10-13）

业务源码基于 `0cd1840`，本次补充界面验证脚本。桌面继续复用完整 `packages/web/dist`，没有复制或裁剪 Web 功能；API 经桌面回环代理连接配置的后端。新建飞书机器人名称等服务端行为需后端部署对应版本，客户端安装包不包含服务端。

## 产物

使用既有 `pack.mjs` 依次重建 Core、Web、Electron，生成 Mac ARM64 / Intel 的 DMG、ZIP，以及 Windows x64 NSIS 安装包，输出到 `packages/desktop/release/web-sync-20261013/`。

- 沿用 `0.2.1` 版本号、既有更新源与更新公钥；本次为当前源码的本地重打包，未发布自动更新、未替换已安装应用。
- 三平台解包目录内的全部 5 个 Web 文件逐一计算 SHA-256，与当前 `packages/web/dist` 完全一致；两个 Mac ZIP 内的 Web 文件也完全一致。
- `web-sync-verification.json` 保存源码版本、Web 文件哈希、安装包大小与哈希。
- Mac 沿用现有未签名配置；Windows 安装启动及 Intel Mac 真机运行未验证。

## 验证

| 检查 | 结果 |
| --- | --- |
| Core、Web、Electron 构建 | 通过 |
| 桌面 TypeScript 检查 | 通过 |
| 桌面、服务端桥接、Agent 流测试 | 18 个文件，143 项通过 |
| Agent 导航 | 快捷入口、展开收起、切换确认、草稿隔离、历史同步、中英文与主题通过 |
| 桌面工具界面 | 模拟 macOS / Windows，目录选择、审批、三档权限、取消、运行中禁用和普通 Web 隔离通过 |
| 飞书界面 | Web 与模拟 macOS / Windows 桥接，中英文、深浅主题、错误恢复、授权流程、置顶会话和等待回复状态通过 |
| 实际 Mac ARM64 安装包 | 隔离临时用户配置启动成功；确认 `app.isPackaged`、真实 preload 桥接及当前版本，飞书入口正常，经回环代理读取模拟账号接入状态，无手工联系人表单 |

`check-agent-navigation-ui.mjs` 使用 `aria-controls` 精确定位 Agent 展开按钮，避免新增飞书入口后同样式按钮造成歧义。`check-feishu-ui.mjs` 增加桌面桥接场景，验证复用界面时不会丢失飞书入口或重新出现手工联系人/发送表单。

所有自动化业务响应使用模拟数据，不调用付费模型，不向真实飞书联系人发送消息；构建与测试通过不代表所有业务后端、外部授权和 Windows 真机操作均已验收。
