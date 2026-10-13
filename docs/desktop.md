# Lot Agent 桌面客户端（packages/desktop）

基于 Electron 的桌面壳，复用 `@lot-agent/web` 的构建产物，连接**远端** Lot Agent
服务端（与 docker-compose 部署的 nginx 入口相同）。支持 macOS（arm64 / x64）和
Windows（x64）。

## 架构

```
┌────────────────────────── Electron 窗口 ──────────────────────────┐
│ renderer: packages/web 构建产物（零桌面专属 URL 逻辑）              │
│     │  http://127.0.0.1:<随机端口>                                 │
│     ▼                                                             │
│ main: loopback server（local-server.ts）                           │
│     ├─ 静态托管 web/dist（SPA fallback）                           │
│     ├─ 反向代理 /api /static /health → 配置的远端服务器（流式）      │
│     └─ 默认连接 https://todoucloud.com；可通过命令参数覆盖          │
│ preload: contextBridge → window.lotDesktop                         │
│     （token 安全存储 / 窗口控制 / 通知 / 下载事件 / 服务器配置）      │
└───────────────────────────────────────────────────────────────────┘
```

- 页面与 API 同源 → 无 CORS；`http://127.0.0.1` 是 secure context → WebCrypto
  登录加密可用；`BASE = "/api"` 与 `/static/...` 链接无需任何改动。
- token 由主进程 `safeStorage`（macOS Keychain / Windows DPAPI）加密后落盘
  （`userData/session-token`，0600），渲染进程启动时同步注入内存缓存。
- 桥接口的唯一权威定义在 `packages/web/src/types/desktop.ts`，改接口时同步
  修改 `packages/desktop/src/preload/index.ts`。

## 开发

```bash
pnpm run dev:desktop        # 根目录：web(vite HMR) + electron，加载 localhost:5173
```

桌面开发启动通过 `scripts/dev.mjs` 设置环境并直接启动 Electron，兼容 Windows
默认终端；`clean` 同样使用 Node，只清理 desktop 包内的 `dist` 与 `release`。

`dev:desktop` 使用 Vite 的 `desktop` 模式，代理按请求读取桌面端保存的 `userData/config.json`
（启动参数或手动配置入口写入），因此开发窗口与打包应用跟随同一个服务器地址；
未配置时回退 `localhost:3000`。打包版本首次启动默认连接 `https://todoucloud.com`，
直接进入当前 Web UI，无需用户填写服务器地址。`/__lot/setup` 仅保留为手动配置入口。登录页底部与 Web 共用“用户协议 / 隐私政策”入口，不再展示服务器设置或服务器地址。

普通 `pnpm dev` / `pnpm dev:web` 的代理固定连接 `http://localhost:3000`，不读取
桌面端保存的远端地址，避免本地新页面误连旧版线上 API。需要单独启动桌面开发代理时，
使用 `pnpm --filter @lot-agent/web run dev --mode desktop`；更换模式需重启 Vite。

生产模式本地验证（走回环服务器 + 默认服务器）：

```bash
pnpm --filter @lot-agent/web run build
pnpm --filter @lot-agent/desktop run build
pnpm --filter @lot-agent/desktop run start
```

## 打包

```bash
pnpm run dist:desktop         # 根目录：构建 web + 出【当前平台】安装包
pnpm run dist:desktop:win     # 根目录：构建 web + 出 Windows NSIS（macOS 上交叉构建亦可）
pnpm run dist:desktop:mac     # 根目录：构建 web + 出 macOS dmg/zip（arm64 + x64）
pnpm run dist:desktop:mac --arm64 --server-url https://todoucloud.com
pnpm run dist:desktop:win --server-url https://your-server.example
```

所有 `dist` / `dist:mac` / `dist:win` 入口（包括直接在 desktop 包运行）统一经过
`scripts/pack.mjs`，依次重新构建 Core → Web → Electron 后才运行 electron-builder。
因此安装包总是带上当前仓库的 Web UI，不会误打包旧的 `web/dist`。Electron Builder
的参数原样透传，例如 `--arm64` 或 `--dir`。

`--server-url` 设置安装包内置的默认服务器地址，支持空格或等号写法；不指定时为
`https://todoucloud.com`。也可用构建环境变量 `LOT_DESKTOP_DEFAULT_SERVER_URL`。
已安装的旧应用需要重新安装新产物，修改源码本身不会更新旧安装包。

程序启动同样支持 `--server-url`（先退出正在运行的应用）：

```bash
# macOS
open -a "Lot Agent" --args --server-url https://your-server.example
# 本地运行构建后的 Electron
pnpm --filter @lot-agent/desktop start --server-url https://your-server.example
```

Windows 快捷方式目标末尾可追加 `--server-url=https://your-server.example`。
地址优先级：启动参数 → 已保存的服务器 → 打包内置默认地址（开发模式无配置时仍为
localhost:3000）。生效地址会保存，供下次启动和开发代理使用。更换服务器会清除
旧服务器的登录令牌与本机工具授权并重新加载页面，避免凭证跨服务器发送。
仅接受 HTTP(S) 的域名和可选端口，不接受账号、路径、查询参数和片段。
本地 `/__lot/*` 控制接口校验 Host 和请求来源；配置 POST 仅接受同源 JSON 请求，
阻止其他网页通过回环地址更改服务器配置。

产物在 `packages/desktop/release/`：

在 Mac 上生成包含三平台安装包、签名清单和服务器脚本的完整发布压缩包，可直接运行 `pnpm release:desktop 0.2.2`；版本号可替换，无需手改 `package.json`。此命令的产物按版本存放，完整说明见 [一条命令构建发布包](desktop-updates.md#一条命令构建完整发布包)。

- macOS：`linquclaw-<version>-mac-arm64.dmg / -mac-x64.dmg`（及 `.zip`）
- Windows：`linquclaw-<version>-win-x64.exe`（NSIS，per-user 安装免管理员）。
  NSIS 交叉构建无需 Wine，macOS 上可直接出包（已验证）；正式发布建议在
  对应平台或 CI matrix 上构建。

### Windows 机器上出包

```powershell
git clone <repo> && cd lot-agent
pnpm install
pnpm run dist:desktop         # Windows 上默认即出 NSIS x64
```

国内网络拉不动 Electron / electron-builder 二进制时先设镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

程序和托盘图标使用 `packages/desktop/build/icon-source.jpg` 中的灵渠 claw 品牌图片。
在 macOS 执行 `pnpm --filter @lot-agent/desktop run icons`，通过系统 `sips` 等比缩放并补齐白色正方形背景，生成 `icon.png`（1024×1024）及 `tray-icon.png`（32×32），保留完整图案与文字。生成文件纳入版本控制，Windows 打包无需额外图像工具；electron-builder 自动转换为 macOS ICNS 和 Windows ICO，并嵌入应用及安装包。

## 签名与公证（macOS）

默认 `electron-builder.yml` 中 `mac.identity: null` 出**未签名**包（首次打开需
右键 → 打开）。正式发布：

1. 删除 `identity: null`；
2. 配置环境变量：
   - `CSC_LINK` / `CSC_KEY_PASSWORD` — Developer ID Application 证书（p12 base64）
   - `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` — 公证
     （electron-builder 自动执行 notarize）

Windows 签名：`CSC_LINK` 指向代码签名证书即可，electron-builder 自动签 exe。

## 自动更新

自 `0.2.0` 起支持固定 HTTPS 更新源和 Ed25519 签名清单：Mac 无开发者账号时自动下载 ZIP，点击重启后独立辅助进程替换应用，失败可用 DMG 手动安装；Windows 使用 NSIS 更新。更新源独立于业务服务器，运行中任务和输入框草稿阻止安装。

密钥生成、构建配置、服务器发布脚本、Nginx 配置及验收见 [桌面自动更新与服务器发布](desktop-updates.md)。旧客户端需先手动安装一次带更新模块的版本。

## 快捷键（桌面端）

| 快捷键 | 功能 |
|---|---|
| Cmd/Ctrl+N | 当前 Agent 新会话 |
| Cmd/Ctrl+, | 打开 Key 设置 |
| Cmd/Ctrl+Shift+T | 切换深浅主题 |

## 行为说明

- 关窗默认最小化到托盘（托盘菜单退出）；macOS 点 Dock 图标恢复窗口。
- 生成类任务（图片/视频）完成且窗口失焦时发系统通知 + Dock 角标 /
  任务栏闪烁，聚焦后自动清除。
- 所有下载走系统保存对话框，进度在应用右下角 Toast 展示，完成后可
  「打开 / 所在文件夹」。


## 本地工作目录与 Agent 工具

桌面通用助手在输入框上方常驻显示本地工作目录和选择 / 更换按钮；左下角工具权限菜单也保留目录入口，两处状态同步。正在执行本地任务时，两处均禁止更换目录。通过系统目录选择器授权后，当前桌面会话可以列目录、读取 UTF-8 文件、新建文件、精确替换文件文本、删除单个文件和运行系统命令；点击“停用本地工具”会撤销授权并取消本机任务。目录授权不跨重启、页面重载、账号切换或服务器切换保留。其他专用 Agent 保持现有工具白名单。

| 工具 | 行为 |
| --- | --- |
| `desktop_list_files` | 列出所选目录内的条目，最多 2000 项 |
| `desktop_read_file` | 读取最多 1 MB 的 UTF-8 文本，结果最多 50000 字符 |
| `desktop_write_file` | 新建文本文件，拒绝覆盖已有文件；父目录需要已存在 |
| `desktop_edit_file` | 精确替换唯一匹配文本；确认后再次核对原文，通过临时文件替换保存 |
| `desktop_delete_file` | 永久删除所选目录内的单个普通文件；拒绝目录和链接，批准期间文件变化则拒绝删除；不依赖命令行 |
| `desktop_bash` | macOS/Linux 使用系统 Bash；默认 30 秒、最多 120 秒；输出超限或取消时终止进程组 |
| `desktop_powershell` | Windows 使用系统 PowerShell 5.1，无需安装 Git Bash；超时和取消使用 taskkill 终止进程树 |

文件新增、读取、编辑和删除由客户端直接处理，不依赖任何 Shell。Windows 命令使用
系统 `System32/WindowsPowerShell/v1.0/powershell.exe`，macOS/Linux 使用系统 Bash；
不搜索 Git、WSL 或用户 PATH 内的同名程序。命令输入和返回结果保留 Unicode，
PowerShell 使用 UTF-8 输出并保留非零退出码，不加载 profile，也不修改系统执行策略。
客户端注册时上报 v2 协议和实际可用 Shell，服务端仅向模型提供对应语法的命令工具。
Shell 不可用时仍提供全部文件工具。新版客户端要求服务端支持 v2，请同步更新两端；
服务端收到旧版客户端的空注册请求时仍只提供原有五个工具，不下发新增操作。

文件工具拒绝相对路径越界、绝对路径、符号链接、硬链接和特殊文件；读取及编辑拒绝二进制，删除支持单个普通二进制文件。文件修改与命令 的批准策略由主进程按会话管理，默认“每次确认”；“本次对话确认”需要首次点击“本次对话允许”，后续同一会话自动执行；“完全授权”直接允许当前会话后续操作。新建会话只继承其草稿中明确选择的策略，不会影响其他已有会话。策略与批准仅在主进程内存中保存，重载、注销、停用工具或更换目录后清除。审批在聊天消息区以紧凑卡片展示命令或文件改动，支持拒绝、允许一次、本次对话允许，不弹系统授权窗。**Bash 和 PowerShell 均不是操作系统沙箱**，命令可以访问工作目录之外的文件和网络；权限菜单与命令审批卡片明确说明这一点。命令进程不继承应用的 API Key 等额外环境变量，不加载 profile/rc 文件。系统命令环境不可用时界面提示文件工具仍可使用。

读取的内容和命令输出会作为工具结果发送给远端模型，并沿现有消息 / 执行记录链路保存，界面会在授权入口说明。文件本身由 Electron 主进程处理，服务端不执行 Shell 或访问用户电脑路径。

### 调用链与权限边界

`InputBox / DesktopWorkspace → useDesktopWorkspace → preload → tool-host.ts / tool-approvals.ts → 系统目录选择器 → /api/conversations/:id/desktop-tools/session`。

`DesktopApprovalCards` 从可信 IPC 获取当前会话的待审批操作，批准使用主进程生成的单次 ID；取消、断连或过期后 ID 立即失效。修改权限档位不会自动批准已展示的请求。这里是已有本地工具执行器的批准回调，不新增等待聊天回复的模型工具，也不改变 `endsTurn` 协议。批准后的工具输入、结果或拒绝错误沿现有消息持久化链路保存；临时批准卡片不持久化，重新加载不会恢复可执行按钮。

主进程以当前登录令牌申请短期、单次聊天使用的随机 capability；该值只保存在主进程内存，经 `webRequest` 注入受信任主窗口的指定会话消息 POST。普通 Web / 小程序不提供这条本地桥接，服务端不会根据 `clientType`、User-Agent 或普通端类型标记启用工具。此机制验证授权能力的持有与会话归属，不是对客户端二进制的远程证明；即使第三方模拟协议，也不会因此访问已连接桌面端的授权目录或执行器。

服务端 `desktop/broker.ts` 校验用户、会话和单次授权，仅在该请求的工具注册表与执行白名单加入本机工具代理。`tool-host.ts` 在主进程轮询请求，`local-tools.ts` 独立验证名称和参数、执行操作并返回结果。目录路径和 capability 不由模型指定。IPC 校验主窗口、主 frame 与页面来源；新窗口在系统浏览器打开，外部页面不能导航进有本机桥接的窗口。

停止、过期、断线、注销或切换服务器会撤销授权。请求只投递一次，写操作不会自动重试；未知结果沿现有运行恢复机制提示核实。聊天卡片与历史记录显示本地工具名称、输入、输出和错误，Web 可以查看同步历史，但不能借历史记录重新执行本机操作。

当前 broker 为 API 进程内临时状态：单 API 实例可直接使用；多 API 实例必须将同一用户 / 会话的注册、轮询、消息和结果请求路由到同一实例（不能只按浏览器 Cookie 粘连，因为主进程也发起请求）。API 重启后本轮授权失效，用户可重新发起聊天，不恢复或重放未确认的写操作。

### 验证

```bash
pnpm --filter @lot-agent/core build
pnpm exec vitest run packages/desktop packages/server/src/desktop packages/server/src/services/agent-service.stream.test.ts packages/core/src/tools/registry.test.ts
pnpm check:desktop-tools:ui  # 需 Playwright + Chrome；PLAYWRIGHT_MODULE 可指定安装路径
pnpm --filter @lot-agent/web build
pnpm --filter @lot-agent/desktop build
pnpm --filter @lot-agent/desktop exec tsc --noEmit
```

UI 脚本使用模拟桌面桥接，验证中文浅色、英文深色、选择 / 停用目录三档权限、批准/拒绝卡片、输入框内位置以及 Web 端隐藏入口；不访问用户本地文件、不调用真实模型。`DESKTOP_SCREENSHOTS_DIR` 可指定已有目录保存截图。文件工具测试只操作临时目录；Windows 命令测试使用系统 PowerShell，无需 Git Bash，且不跳过 Windows，目录链接测试使用 junction。

最近一次本机测试及真实 Electron 验证范围见 [2026-10-12 验证记录](desktop-verification-2026-10-12.md)。Windows 安装启动、系统目录权限、PowerShell 及进程树取消仍需对应平台验收。

最新 Web 页面同步、三平台重打包及跨端 UI 检查见 [2026-10-13 同步验证记录](desktop-verification-2026-10-13.md)。
