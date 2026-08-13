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
│     └─ /__lot/setup 首次启动服务器设置页                           │
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
npm run dev:desktop        # 根目录：web(vite HMR) + electron，加载 localhost:5173
```

dev 模式下 vite 代理会按请求读取桌面端保存的 `userData/config.json`
（`服务器设置` 弹窗写入），因此开发窗口与打包应用跟随同一个服务器地址；
未配置时回退 `localhost:3000`。prod 首次启动（未配置服务器）由回环服务器
直接提供 `/__lot/setup` 设置页。

生产模式本地验证（走回环服务器 + 设置页全流程）：

```bash
npm run build -w @lot-agent/web
npm run build -w @lot-agent/desktop
npm run start -w @lot-agent/desktop
```

## 打包

```bash
npm run dist:desktop         # 根目录：构建 web + 出【当前平台】安装包
npm run dist:desktop:win     # 根目录：构建 web + 出 Windows NSIS（macOS 上交叉构建亦可）
npm run dist:desktop:mac     # 根目录：构建 web + 出 macOS dmg/zip（arm64 + x64）
```

产物在 `packages/desktop/release/`：

- macOS：`Lot Agent-<version>-arm64.dmg / -x64.dmg`（及 `.zip`）
- Windows：`Lot Agent Setup <version>.exe`（NSIS，per-user 安装免管理员）。
  NSIS 交叉构建无需 Wine，macOS 上可直接出包（已验证）；正式发布建议在
  对应平台或 CI matrix 上构建。

### Windows 机器上出包

```powershell
git clone <repo> && cd lot-agent
npm install
npm run dist:desktop         # Windows 上默认即出 NSIS x64
```

国内网络拉不动 Electron / electron-builder 二进制时先设镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

图标为脚本生成的占位图（`npm run icons -w @lot-agent/desktop`），替换正式
美术稿时覆盖 `packages/desktop/build/icon.png` / `tray-icon.png` 即可。

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

本期未接入。预留方向：`electron-updater` + generic provider 指向内部分发服务，
或在 OTA 离线盒场景复用 `deploy/ota/` 的通道。

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
