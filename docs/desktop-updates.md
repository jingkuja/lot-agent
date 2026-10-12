# 桌面客户端最新版本发布指南

所有版本使用本文流程：本机一条命令构建 Mac / Windows、生成签名清单和压缩包，上传服务器后运行发布脚本。无需按版本单独维护文档。

## 发布配置

| 项目 | 当前配置 |
| --- | --- |
| 构建环境 | macOS、Node.js 20+、pnpm，已安装项目依赖 |
| 安装包 | Mac ARM64 / Intel 的 DMG、ZIP；Windows x64 NSIS |
| 更新地址 | `https://todoucloud.com/updates/stable/` |
| 网站基础目录 | `/www/wwwroot/todoucloud.com/` |
| 服务器更新文件 | `/www/wwwroot/todoucloud.com/updates/stable/` |
| 服务器发布暂存 | `/www/wwwroot/todoucloud.com/lot-agent-release/staging/` |
| 本机更新私钥 | `$HOME/.lot-agent-release/update-private.pem` |
| 本机更新公钥 | `$HOME/.lot-agent-release/update-public.pem` |

继续使用已经生成的更新密钥，不要重新生成或上传私钥。私钥目录权限为 `700`、私钥文件为 `600`，请离线备份；客户端固化公钥，丢失私钥后无法为已有客户端签发更新。Ed25519 更新签名不需要 Apple 开发者账号，也不替代操作系统代码签名。

## 一条命令构建完整发布包

在本机仓库目录执行。将示例版本号换成**高于线上版本、尚未发布的新版本号**，格式只支持 `major.minor.patch`：

```bash
cd /Users/nikin/project/lotlife/lot-agent
release_version=0.2.3
pnpm release:desktop "$release_version"
```

无需修改 `package.json`。脚本将参数版本写入安装包，源码中的版本号保持原样。它依次完成：

1. 检查版本、密钥配对、更新地址及输出目录。
2. 构建 Core / Web / Electron，生成两个 Mac 架构及 Windows x64 安装包。
3. 为三个平台生成 Ed25519 签名清单，包含版本、平台、文件大小和 SHA-512。
4. 生成服务器发布脚本、Nginx 配置片段、发布说明和公钥文件。
5. 生成 `SHA256SUMS`、发布压缩包及 `.sha256` 文件，并检查压缩包可读。

输出位置：

```text
packages/desktop/release/<版本号>/
packages/desktop/release/publish-<版本号>/
  desktop-release-<版本号>/
  desktop-release-<版本号>.tar.gz
  desktop-release-<版本号>.tar.gz.sha256
```

这是本机打包命令，不会自动上传或部署服务器。同版本输出目录存在时会拒绝覆盖；已发布版本只能使用原包重试，修改代码后应提升版本号。

可选更新说明与离线缓存：

```bash
pnpm release:desktop "$release_version" --notes /tmp/release-notes.txt
pnpm release:desktop "$release_version" --electron-dist /path/to/electron-cache
pnpm release:desktop --help
```

上述是替代用法，选择其中一种执行。更新说明使用 UTF-8 文本，建议写中英文；未传时生成默认说明。脚本会自动复用 `~/Library/Caches/electron/` 中当前 Electron 版本的 Mac ARM64、Mac x64、Windows x64 完整 ZIP 缓存，否则正常下载。自定义缓存目录需适用于三个目标。

密钥位置可通过 `LOT_DESKTOP_UPDATE_PRIVATE_KEY_FILE`、`LOT_DESKTOP_UPDATE_PUBLIC_KEY_FILE` 覆盖。`LOT_DESKTOP_UPDATE_URL` 支持更换 HTTPS 域名，路径须保留 `/updates/stable/` 并配置对应站点；业务后端地址使用 `LOT_DESKTOP_DEFAULT_SERVER_URL`。

## 上传到服务器

在本机执行，沿用上一步的 `release_version`，把 SSH 账号和地址换成实际值：

```bash
release_parent="packages/desktop/release/publish-${release_version}"
release_name="desktop-release-${release_version}"

scp "${release_parent}/${release_name}.tar.gz" \
  "${release_parent}/${release_name}.tar.gz.sha256" \
  root@服务器地址:/tmp/
```

也可使用现有上传工具，把这两个文件上传到 `/tmp/`。

## 服务器解压与发布

以 root 或发布目录管理员执行，要求 Node.js 20+。服务器上重新设置同一个版本号：

```bash
release_version=0.2.3
release_name="desktop-release-${release_version}"
staging_root=/www/wwwroot/todoucloud.com/lot-agent-release/staging

node --version
cd /tmp
sha256sum -c "${release_name}.tar.gz.sha256"
install -d -m 700 /www/wwwroot/todoucloud.com/lot-agent-release "$staging_root"
install -d -m 755 /www/wwwroot/todoucloud.com/updates/stable

tar --no-same-owner -xzf "/tmp/${release_name}.tar.gz" -C "$staging_root"
cd "${staging_root}/${release_name}"
sha256sum -c SHA256SUMS
```

所有校验应为 `OK`。如果更新服务已配置，直接执行下面的发布命令；首次部署先完成下一节的更新目录 Nginx 配置，再返回执行：

```bash
bash ./publish-all.sh
```

脚本会验证签名及本地安装文件，再通过公网 HTTPS 下载完整产物校验，最后逐平台切换 `latest.json` 和官网下载符号链接。请等待三个平台都输出 `Published ... <版本号>`。公网校验会消耗一份完整安装产物的下载流量。

任意平台失败会停止，已成功平台保留；修正配置或网络后，原样重跑同一命令即可。不要直接覆盖线上 `latest.json`、修改已发布安装包或复用版本号发布不同内容。

## 首次配置 Nginx

当前服务器使用宿主机 Nginx；正常升级不需要重复此步骤。以下命令在解压后的发布目录中执行。

先安装更新目录配置：

```bash
install -d -m 755 /etc/nginx/snippets
install -m 644 nginx-updates.locations.conf /etc/nginx/snippets/lot-desktop-updates.conf
```

在宝塔「网站 → todoucloud.com → 设置 → 配置文件」中，向**实际处理 HTTPS 请求的 443 server 块**加入：

```nginx
include /etc/nginx/snippets/lot-desktop-updates.conf;
```

已有同名 location 或 include 时合并替换，避免重复定义。此片段将 `/updates/` 映射到 `/www/wwwroot/todoucloud.com/updates/`，缺失文件返回 404，清单禁止缓存，版本文件支持长期缓存及 Range；同时禁止访问 `/lot-agent-release` 及全部子路径。

若其他域名或 HTTP server 块也直接提供同一网站目录，在这些块加入暂存目录限制：

```nginx
location = /lot-agent-release { return 404; }
location ^~ /lot-agent-release/ { return 404; }
```

只做 HTTPS 跳转的入口无需重复静态文件配置。不要把网站首页回退写成 server 层的全站重写；应限制在 `location /` 中，让 `/updates/` 直接读取静态文件。

检查并重载宝塔 Nginx：

```bash
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

普通安装且 Nginx 已在 PATH 中时使用 `nginx -t && nginx -s reload`。如有 CDN，对 `latest.json`、`download.dmg/exe` 和三个官网下载入口关闭缓存，不缓存 404，并保留 Range / 206。

现在运行 `bash ./publish-all.sh`。**初次发布成功后**，再安装官网下载入口配置：

```bash
install -m 644 nginx-downloads.locations.conf /etc/nginx/snippets/lot-desktop-downloads.conf
```

同一个 HTTPS server 块加入下面一行，合并或移除原有冲突 location，然后再次检查并重载：

```nginx
include /etc/nginx/snippets/lot-desktop-downloads.conf;
```

保留的官网下载入口是 `/linquclaw-arm64.dmg`、`/linquclaw.dmg`、`/linquclaw.exe`，分别指向 Mac Apple Silicon、Mac Intel 和 Windows x64 的最新已发布安装包。

仓库内对应配置源为 `deploy/nginx-desktop-updates.conf` 与 `deploy/nginx-desktop-downloads.conf`。若改用仓库 Docker 部署，使用更新后的 Web 镜像及 `deploy/docker-compose.desktop-updates.yml` 挂载静态目录；当前宿主机部署无需使用此 Compose 文件。

## 发布后验证

沿用服务器上的 `release_version`：

```bash
curl -I https://todoucloud.com/updates/stable/mac-arm64/latest.json
curl -I https://todoucloud.com/updates/stable/mac-x64/latest.json
curl -I https://todoucloud.com/updates/stable/win-x64/latest.json
curl -I -H 'Range: bytes=0-1023' \
  "https://todoucloud.com/updates/stable/mac-arm64/linquclaw-${release_version}-mac-arm64.zip"
curl -I https://todoucloud.com/updates/stable/mac-arm64/not-found.zip
curl -I "https://todoucloud.com/lot-agent-release/staging/desktop-release-${release_version}/publish-all.sh"
```

前三项应返回 `200` 且 `Cache-Control: no-store`，Range 请求返回 `206`，缺失文件和暂存目录地址返回 `404`。

在已安装的旧版客户端点击「应用更新 → 检查更新」，等待自动下载，点击「重启并更新」，重启后确认版本号与发布版本一致，并检查原有账号、配置和本地工作目录。Mac ARM64、Mac Intel、Windows x64 分别测试；构建和单元测试不能代替实机升级验证。

没有更新模块的旧客户端需先手动安装一次。Mac 应从真实且可写的「应用程序」或 `~/Applications` 运行，不要从 DMG 内启动。Mac 无 Apple 签名/公证，系统仍可能阻止打开；自动安装失败时选择「下载 DMG 手动安装」。Windows 使用 NSIS 安装流程，系统可能显示 SmartScreen 或权限提示。

## 常见问题

- **Public artifact checksum mismatch / returned HTML**：公网文件与清单不一致。脚本会给出失败 URL、响应类型、大小等信息。若安装包 URL 返回 `text/html`，通常落入网站首页回退、代理或 CDN 的旧缓存。检查实际生效的 443 server 中 `/updates/` 的 root、重写规则及缓存，修正后原样重试，不要跳过校验。
- **Release output already exists**：本机已经有同版本输出。已发布版本沿用原包；新代码使用更高版本。清空本机目录不会解除服务器对同版本不同内容的限制。
- **构建中断后有锁**：普通失败会自动清理本次临时输出并释放锁。进程被强制终止时，确认没有构建进程后清理 `packages/desktop/release/.desktop-release-lock`，按时间识别并清理本次遗留 `.release-*` 临时目录。
- **服务器发布锁残留**：确认没有发布进程后，清理对应平台更新目录中的 `.publish-lock` 和 `.publish-*` 再重试；不要删除已发布安装文件。
- **需要回滚**：把修复代码构建成更高版本发布。发布脚本与客户端不会通过降级清单回退旧版本。

## 更新行为与实现约束

客户端启动约 30–40 秒后检查，之后每 6 小时附加随机延迟再检查，也可手动检查。清单验签后自动下载，只有点击「重启并更新」才安装，普通退出不会触发安装。安装前会阻止未发送草稿、附件及活动任务；其他表单内容应先保存。

Mac 使用 ZIP 解包，核对 bundle ID、版本、架构及链接边界，退出后备份替换并等待新版启动确认。新版启动失败且进程已退出时恢复旧版；无法安全结束新版进程时保留备份供手动恢复。备份位于应用同目录 `.lot-update-*/previous.app`，确认稳定并退出应用后可清理；不要在辅助进程运行中操作。程序不提权、不移除 quarantine、不关闭 Gatekeeper。

Windows 使用固定的 `electron-updater` NSIS 流程和已验签的清单 Provider。两端当前均完整下载，构建生成的 `latest*.yml` 不用于更新；`https://updates.invalid/` 仅供生成 Windows 安装器缓存配置，运行时不访问。

保持 `appId: com.lotagent.desktop`、`productName: Lot Agent`、安装身份及用户数据目录不变。更新地址与公钥编译进主进程，独立于业务服务器地址，不携带用户令牌。

## 开发验证命令

```bash
pnpm exec vitest run packages/desktop/scripts/release-command.test.ts packages/desktop/scripts/release.test.ts
pnpm exec vitest run packages/desktop
pnpm --filter @lot-agent/desktop exec tsc --noEmit
pnpm check:desktop-updates:ui
```

完整桌面测试需要本地回环端口权限，UI 检查需要 Playwright / Chrome。重新初始化一套尚未使用的更新服务时，可用 `node deploy/desktop-release.mjs keygen` 创建密钥；当前部署继续使用既有密钥。分步构建、清单准备和发布可通过 `pnpm dist:desktop:mac`、`pnpm dist:desktop:win` 及 `node deploy/desktop-release.mjs help` 查看，但常规发布直接使用本文的一键命令。
