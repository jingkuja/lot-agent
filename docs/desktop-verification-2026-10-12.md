# 桌面客户端验证记录（2026-10-12）

基于当前未提交工作区。执行环境为 macOS arm64、Node 22.14.0、pnpm 10.33.0、Electron 43.2.0。所有文件操作使用临时目录；未调用真实模型、未使用已有登录状态。以下结果不代表 Windows 真机验收。

## 首轮结果（移除 Git Bash 依赖之前）

| 范围 | 实际结果 |
| --- | --- |
| 新增、读取、编辑 | 通过；新增拒绝覆盖，编辑要求唯一匹配，批准期间发生外部修改时拒绝覆盖 |
| 删除 | Bash 删除通过；拒绝后保留文件，批准后删除。没有独立 `desktop_delete_file` 工具 |
| 路径与文件限制 | 越界、链接、硬链接、无效 UTF-8、二进制、超大文件被拒绝；中文和空格路径、CRLF 编辑通过 |
| 审批 | 每次确认、本次对话允许、完全授权、一次性批准、会话隔离、过期审批拒绝通过 |
| 停止和撤权 | 待审批取消不写文件；已启动的 Bash 子进程取消后无延迟写入；停用、重载清空授权 |
| 服务端边界 | 用户和会话归属、单次 capability、工具白名单、参数校验、结果持久化、请求不重投通过 |
| 客户端界面 | 中文浅色、英文深色、三档权限、批准和拒绝、目录选择及停用、小窗口边界通过；普通 Web 无本机入口 |
| Windows 界面模拟 | Windows 路径、Git Bash 缺失提示、运行中禁用切换目录通过；仅模拟 renderer 状态 |
| 构建 | Core、Web、Desktop 构建及 Desktop TypeScript 检查通过；Web 有构建体积提示 |

97 项 Vitest 测试通过（按不同用例去重）：

- 文件工具 15、桌面平台脚本 2、配置 15、安全令牌 6。
- broker、routes、tool-host、tool-approvals、IPC 合计 19。
- 本地静态和反向代理服务 22。
- Agent 流式工具链 9、Core 工具注册表 9。

真实 Electron 验证使用当前构建的 preload、IPC、主进程执行器和回环代理，独立临时 userData、伪 token、本地模拟 broker。新增、读取、编辑、Bash 删除拒绝及批准、三档策略、草稿绑定、取消、过期审批、停用及重载均通过；确认 sandbox/contextIsolation 开启、nodeIntegration 关闭。系统目录选择器返回值替换为临时目录，因此未验证真实目录对话框或操作系统访问授权。真实后端和模型发起完整聊天的在线链路未在本次执行。

## 本次修复

1. Windows 默认终端不支持原来的 `LOT_DESKTOP_DEV=1 electron .` 和 `rm -rf`：改为 Node 启动与清理脚本，测试含空格路径、参数透传、退出码和清理范围。
2. 本地服务器配置接口原先缺少请求来源校验：增加 Host、Origin 和 JSON 类型检查。新增回归用例在旧代码失败，修复后通过；正常设置、SSE、上传和取消测试保持通过。
3. 扩充文件删除、拒绝、取消、中文路径和链接替换回归；Windows 目录链接测试使用无需符号链接特权的 junction，Bash 测试不再跳过 Windows。

## 权限含义

| 档位 | 读取和列目录 | 写文件、编辑和 Bash |
| --- | --- | --- |
| 每次确认 | 目录授权后可执行 | 每次需要批准 |
| 本次对话确认 | 目录授权后可执行 | 首次点击“本次对话允许”后，同一会话后续自动执行 |
| 完全授权 | 目录授权后可执行 | 当前会话自动执行 |

文件工具限制在选定目录内；Bash 不是操作系统沙箱，可以访问目录外文件和网络。“完全授权”不会提升操作系统账户权限。读取内容及命令输出会发送给远端模型，并沿消息和执行记录链路保存。

## Windows 待验收（按后续原生工具版本执行）

代码和模拟验证已完成，但未运行 Windows 操作系统、NSIS 安装包或原生 PowerShell，不能断言 Windows 全链路已通过。

在 Windows x64 普通用户下，无需安装 Git Bash，执行：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @lot-agent/core build
pnpm exec vitest run packages/desktop packages/server/src/desktop packages/server/src/services/agent-service.stream.test.ts packages/core/src/tools/registry.test.ts
pnpm --filter @lot-agent/web build
pnpm --filter @lot-agent/desktop build
pnpm --filter @lot-agent/desktop exec tsc --noEmit
pnpm run dist:desktop:win
```

安装后仍需实际核对：

1. NSIS 普通用户安装、启动、重启、窗口和托盘操作。
2. 真实目录选择器、含中文和空格的目录、只读 NTFS 权限；拒绝后不得改文件，错误应可见。
3. 新建、编辑、独立文件删除、PowerShell 命令及三档审批；跨会话、停用、重载、账号和服务器切换清权。
4. 长命令和带子进程命令的停止、超时，确认 `taskkill /T /F` 终止进程树。
5. DPAPI 登录令牌保存和读取、退出登录清理。
6. 没有 Git Bash 时文件操作和系统 PowerShell 命令均可用；系统 PowerShell 被禁用时文件工具仍可用，不引导安装 Git。

macOS 交叉构建出 Windows 安装包不能替代上述运行验收。


## 后续调整：Windows 无需 Git Bash

Windows 默认改用系统 PowerShell 5.1，macOS/Linux 继续使用系统 Bash。新增 `desktop_delete_file`，直接删除工作目录内的单个普通文件，不依赖 Shell；批准卡片明确提示永久删除，拒绝、取消或批准期间文件变化时保留文件。

客户端注册上报 v2 协议与可用 Shell；服务端仅暴露对应的命令工具，避免向 Windows 发送 Bash 语法。Shell 不可用仍暴露全部文件工具。旧客户端保持原有工具集合；新客户端连接旧服务器时明确拒绝启用，需要两端同步更新。

本轮 108 项测试通过，包括 PowerShell 可执行路径、Unicode 参数、无 profile/无交互启动、凭证环境隔离及 taskkill 参数的模拟验证；单文件删除、越界/链接/目录拒绝、变化/取消保留、能力协商和旧服务端拒绝均通过。Core、Server、Web、Desktop 构建和 Desktop 类型检查通过；浏览器检查覆盖 macOS/Windows、中文/英文、深浅主题、PowerShell 和永久删除审批。Windows Shell 启动测试使用模拟进程；Windows 实际执行仍需真机验收。

真实 macOS Electron 额外验证原生文件删除的拒绝与批准，以及 v2 工具链；沿用独立临时用户数据、临时文件、模拟 broker 和目录选择器返回值。未连接真实模型或使用用户登录状态。
