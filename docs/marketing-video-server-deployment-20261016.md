# 营销影像服务器部署与沙箱修复记录

部署日期：2026-10-16（北京时间）。目标：`192.140.178.86:22`。

## 最新结果：定位签名缺失并部署抖音提取器修复（20:55）

直接读取线上 403 的响应体，确认为
`Blocked by ArgusSecurityPlugin Signature Not Found`。失败请求没有
`timestamp` / `x-secsdk-web-signature`；本机成功请求具备这些字段和匿名
`UIFID_TEMP`。这解释了本次拒绝，不能把它误判为必须登录或确定的地区封禁。

上游 [yt-dlp #9667](https://github.com/yt-dlp/yt-dlp/issues/9667) 的最新调查
和 [PR #17826](https://github.com/yt-dlp/yt-dlp/pull/17826) 与响应吻合。
PR 截至核验时仍未合并。本次固定其提交
`edf5ca18f756b1a21f56c87aaf1aef7ef8d3520e` 对应的补丁，而非更新到移动分支。
源包、补丁和变更前后提取器均有 SHA256 校验，构建过程只修改 portable
zipapp 的 `yt_dlp/extractor/tiktok.py`。详情见
[固定抖音提取器补丁](../deploy/yt-dlp/README.md)。

最终镜像保留原版 yt-dlp；桥接器只为服务端规范化的抖音短链和视频 URL
选择 `yt-dlp-douyin`。匿名 Cookie 由任务内下载进程处理，没有导入账号或
共享浏览器会话。所有请求仍经过原有 HTTPS 出口、SSRF 检查及沙箱。
先访问首页的浏览器候选 `douyin4` 仍有间歇失败，新增源码已精确撤回，
没有部署；全局替换下载器的验证镜像 `douyin5` 也未部署。

实际线上镜像于 12:55:09 UTC 切换为
`lot-agent-media-analysis:20261016-douyin6`（`8ec72d065138`）。仅重建媒体
Worker，其他运行容器 ID 不变。Mihomo 保持关闭，网页与 API 健康检查均为
200，Worker 正常监听队列。

验证结果：

- 补丁候选两次顺序、两次并发下载全部通过；58.2 秒、720×1280，含音视频，
  每次文件 6,022,961 字节。实际抽帧得到 118 帧。
- 最终分流候选额外下载验证通过（10.6 秒）；实际生产容器再验证通过
  （7.9 秒）。均使用用户提供的同一短链、无登录 Cookie、无付费模型调用。
- 27 项下载/浏览器/管道测试、4 项 Python 分流/版本/哈希检查通过；server
  构建通过。完整 Linux 媒体沙箱预检通过。

发布目录：`/agent/releases/douyin-20261016-extractor/`；配置备份：
`/agent/backups/douyin-extractor-20261016T125507Z/`。修复源码同步到
`/lot-agent`，保留已有修改。重建媒体镜像时仍使用原 `YTDLP_SHA256`，
`YTDLP_VERSION` 固定为 `2026.08.19`；媒体 Dockerfile 同步复制分流桥，
避免复用旧应用镜像时装好补丁却未调用。

未自动重放失败业务任务；页面原错误记录不会自行变为成功。用户刷新后
点击“继续生成”才会重新执行后续分析。上述验收覆盖线上下载及本地媒体处理，
不表示已执行整套付费模型生成。回退只需将 Compose 中媒体 image 恢复为
`20261016-douyin2` 并仅重建该服务，保留安全策略和所有业务卷。

## 较早复验：关闭代理后仍有间歇性平台拒绝

用户再次报告线上 `BROWSER_READ_FAILED`。检查确认 Mihomo 自 12:17:30 UTC
起保持关闭，线上仍为 `20261016-douyin2`，没有代理环境变量；最近两条失败
任务都是同一抖音短链，且没有保存平台 Cookie。实际 Worker 容器内一次探测
16.8 秒下载成功，但其他相同镜像的探测失败，因此关闭代理后的单次成功不能
证明读取已稳定。

有限 CDP 诊断确认失败响应属于目标视频的详情请求，状态为 HTTP 403，
不是其他推荐视频的失败；页面显示临时错误后可能跳转“精选”。一次受控刷新
曾恢复下载，但随后候选镜像仍多次失败。该实验经过 30 项测试及构建，候选
镜像为 `20261016-douyin3`，**未切换到线上**。本轮新增刷新逻辑及测试已用
精确反向补丁撤回，保留此前 Linux 修复和其他未提交修改。任务内固定解析
结果、允许页面图片的临时探测也未解决问题，没有修改线上 DNS 或代理配置。

本机通路再次成功下载同一视频，8,139,173 字节；FFprobe 确认 58.2 秒、
576×1024、含视频和音频轨道，已提供本地文件用于上传。没有自动重放用户
任务或调用付费模型。当前只能确认匿名服务器访问存在平台拒绝，具体判定
原因未确定，不能承诺链接读取稳定可用。

## 较早复验：关闭 Mihomo 后单次下载成功

用户说明须关闭服务器代理后访问抖音。检查发现 `mihomo.service` 正在运行，
TUN、自动路由、TLS 嗅探开启；规则模式下抖音落到 DIRECT。按用户要求执行
`systemctl stop mihomo` 后，服务为 `inactive/dead`，`Meta` TUN 网卡已移除，
网站健康检查仍为 200。未改代理规则、节点、DNS 或原开机自启设置。

保持同一线上媒体镜像 `20261016-douyin2` 和相同隔离策略，用临时容器重新
读取 `https://v.douyin.com/Opl7-ZVVzec/`：18.5 秒完成下载，文件 8,139,173
字节，累计入口流量 42,874,530 字节；沙箱 FFprobe 确认时长 58.2 秒，
576×1024，含视频与音频轨道。没有登录、导入 Cookie 或调用付费模型。
这次关闭后的实测成功更新了下方 17:50 时下载未通过的结论；尚未单独确定
Mihomo 接管链路中引发差异的具体机制，不能直接归因于地区限制。

用户原任务没有自动重放，刷新后点击“继续生成”可重新执行业务分析。
本次只停止 Mihomo，原服务仍保留开机自启；服务器重启后须复核其状态。

## 当日后续：抖音匿名读取升级（17:50）

用户已拉取 `6b7ad0b` 并构建媒体镜像 `:1.0`，但运行 Compose 仍引用
`20261016-sandbox2`，前端也仍使用旧镜像；最近任务因此继续记录
`needs_auth / AUTH_REQUIRED`。检查时没有活动媒体任务。

在临时容器中进一步修复 Linux Chromium 启动：直接运行
`/usr/lib/chromium/chromium`，避免包装脚本读取沙箱未挂载的
`/etc/chromium.d`；Linux 不传 `--disable-crashpad-for-testing`，HOME 与
缓存限制在 `/tmp`。原 `pids_limit: 128` 造成浏览器和出口桥无法创建线程，
默认两任务并发的媒体容器改为有界的 512；3 GiB 内存、2 CPU、非 root、
seccomp、AppArmor、cap_drop 与文件/网络隔离保持原配置。

实际切换仅涉及两个服务：

- 媒体：`lot-agent-media-analysis:20261016-douyin2`（`eb34ef50fd8b`）。
- 前端：`lot-agent-web:20261016-douyin1`（`02fda92379af`）。
- 配置备份：`/agent/backups/douyin-20261016T095011Z/`。
- 发布产物与源码补丁：`/agent/releases/douyin-20261016/`。

媒体镜像从服务器已构建的新版 `:1.0` 派生，加入本机通过 server 构建的
JavaScript 产物与修复后的 Python 桥；未升级运行依赖。源码补丁同步到
`/lot-agent`，保留该目录此前的部署文件删除状态。前端从 `6b7ad0b` 的
临时干净上下文构建，避免恢复用户已移动的部署文件。

验证：27 项浏览器/下载/管道测试通过，server 与 web 构建通过；新镜像的
完整媒体沙箱预检通过，Worker 正常监听，API 与网页健康检查 200，Nginx
配置通过，其他运行容器 ID 不变。

**真实抖音下载仍未通过**：匿名浏览器可以打开用户给定视频页面，但目标
视频详情接口 `/aweme/v1/web/aweme/detail/` 返回 HTTP 403，页面显示
“服务器出现问题，请稍后重试”；最终得到 `BROWSER_READ_FAILED`。
这不能证明登录即可解决，也不能据此确定具体的 IP/区域/风控原因。
没有改动代理或 DNS，没有执行付费模型调用或自动重放用户任务。
此前持久化的 `AUTH_REQUIRED` 记录保留，刷新后重试才会获得新结果。

回退时仅把当前 Compose 的媒体 image、前端 image 和媒体 pids_limit
恢复为本节备份中的值，再对这两个服务执行 `up -d --no-deps --force-recreate`。
不要使用下方首次沙箱修复之前的旧权限配置作为本次回退目标。

以下记录保留首次沙箱修复时的状态。

## 交付结果

媒体分析 Worker 已部署修复并启动；服务器上的完整媒体沙箱预检和生产
Worker 内同一组测试均通过。API 健康检查返回 200，Nginx 配置校验通过。
本次只重建 `media-analysis-worker`，其余服务的容器 ID 未变化。

未重新执行用户的失败分析任务，也未调用付费模型。真实平台下载、下载代理
完整链路、音频转写及模型分析效果仍需通过业务任务验收；本次通过的是运行
环境和媒体工具链验证，不能等同于所有视频平台业务成功。

## 环境与路径

| 项目 | 实际值 |
| --- | --- |
| 系统 | Ubuntu 22.04 LTS，amd64 |
| 内核 | 5.15.0-194-generic |
| Docker Engine | 29.1.3 |
| 源码 | `/lot-agent/` |
| Compose / 环境文件 | `/agent/docker-compose.yml`、`/agent/.env` |
| 安全策略与预检 | `/agent/security/` |
| AppArmor profile | `lot-agent-media-analysis-v2` |
| AppArmor 安装文件 | `/etc/apparmor.d/lot-agent-media-analysis-v2` |
| 当前媒体镜像 | `lot-agent-media-analysis:20261016-sandbox2` |
| yt-dlp | 2026.08.19 |
| 本次备份 | `/agent/backups/media-sandbox-20261016T070336Z/` |

AppArmor 服务已启用开机加载；未执行宿主机重启测试。
`user.max_user_namespaces=128043`、`kernel.unprivileged_userns_clone=1`，
本次无需调整宿主机 user namespace 参数。

原镜像 `lot-agent-media-analysis:1.0` 保留：

```text
sha256:9a9ebbf1d2193aef744600f09eb3ce0691da968c328aeb35fcfad1490fcf42bf
```

新镜像由原镜像离线派生：

```text
sha256:5ac46da8f08ecc2df69350462a8ee55edf6fce77e390154083a700e79c1b9227
```

## 根因与修复

界面“正在处理”不能证明 Worker 仍在运行任务。数据库中原分析已是
`failed / queued / DOWNLOAD_FAILED`，且无活动租约。
检查发现媒体进程在访问视频平台之前就存在本地运行环境阻塞：

| 错误 | 本次定位与修复 |
| --- | --- |
| `No permissions to create new namespace` | Docker 默认 seccomp 阻止 namespace 创建，改用媒体专用策略 |
| `Failed to make / slave: Permission denied` | 默认 AppArmor 禁止 mount，加载独立媒体 profile |
| `Can't mount proc on /newroot/proc: Operation not permitted` | Docker 系统路径遮蔽/只读挂载与嵌套 proc 挂载冲突；仅对媒体容器设置 systempaths，并配套 AppArmor 拒绝规则 |
| FFmpeg 缺少 BLAS/LAPACK 动态库 | `/usr/lib` 链接穿过沙箱未挂载的 `/etc/alternatives`；在镜像构建时固定到 `/usr/lib` 中真实文件 |

这不是已证实的服务器 CPU/内存不足，也不是 yt-dlp 版本变量未生效。
其他下载问题仍可能出现在真实平台访问阶段，应以新任务日志判断。

## 生效配置与权限边界

媒体服务关键字段如下；原环境变量、共享业务卷及资源限制保留：

```yaml
services:
  media-analysis-worker:
    image: lot-agent-media-analysis:20261016-sandbox2
    user: node
    mem_limit: 3g
    cpus: 2
    pids_limit: 128
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
      - seccomp=/agent/security/media-analysis-seccomp.json
      - apparmor=lot-agent-media-analysis-v2
      - systempaths=unconfined
```

未添加 privileged、SYS_ADMIN、宿主机网络或 Docker socket。
seccomp、AppArmor 和应用 bubblewrap 都继续生效。`systempaths=unconfined`
只取消该容器的系统路径遮蔽/只读挂载；v2 AppArmor 补充相应访问拒绝。
访问拒绝与挂载遮蔽不完全等价，不能脱离 v2 策略单独启用该选项。

部署时对比确认 server 与媒体 Worker 的主密钥、PG 主机/数据库、Redis URL、
yt-dlp 版本配置一致，未输出这些配置的秘密值。未修改密钥或用户业务数据。

## 已完成验收

在不挂业务卷、不传环境文件、外层无网络的一次性容器，以及实际运行的
媒体 Worker 内分别验证：

- 敏感 proc 文件读取被拒绝；sysctl 文件写方式打开被拒绝，未实际写入。
- 任务外文件和 `/app` 不可见；`/usr` 只读，任务目录可读写。
- 父进程测试环境变量未传入子沙箱。
- 有效 capability 为 0，NoNewPrivs 为 1，seccomp 过滤生效。
- 内外 PID namespace 不同；内层无法连接外层回环监听地址。
- 在完整 bubblewrap + prlimit 参数下，yt-dlp 版本查询成功。
- FFmpeg 生成自制 1 秒视频，FFprobe 成功读取正数时长。

其他检查：AppArmor 语法与内核加载通过；Compose 校验通过；运行中容器
seccomp 与文件一致；MaskedPaths / ReadonlyPaths 为空，确认 systempaths
已应用；Worker 已输出 `Media analysis worker listening on lot-media-analysis`；
API `/health` 返回 200；`nginx -t` 通过。

## 运维与后续部署

日常检查：

```bash
cd /agent
docker-compose ps
docker-compose logs --tail=100 media-analysis-worker
bash /agent/security/check-media-sandbox.sh \
  /agent/security/media-analysis-seccomp.json \
  lot-agent-media-analysis:20261016-sandbox2
```

上述预检不调用付费模型。预检脚本会启动一个临时容器并自动清理。
后续更新镜像、Docker 或内核后，应先运行预检再切换 Worker。

完整构建的 `Dockerfile.media-analysis` 已加入动态库链接修复；配套脚本在
`deploy/security/fix-library-links.sh`。服务器 `/lot-agent/` 中同步相同修复。
镜像构建仍需显式传入固定 `YTDLP_VERSION` 和对应架构官方 `YTDLP_SHA256`；
`.env` 不会自动成为 `docker build --build-arg`。本次复用已验证的原镜像，
不改变 yt-dlp 版本，也未重新联网安装系统包。

安全策略安装、离线派生镜像和部署步骤见
[媒体 Worker Linux 安全策略](../deploy/security/README.md)。服务器运维副本
另见 `/agent/security/README.md`（相对文档链接按源码目录组织）。

修改镜像或安全策略后，确认无在途媒体任务，再执行：

```bash
cd /agent
docker-compose config --quiet
docker-compose up -d --no-deps --force-recreate media-analysis-worker
```

不要运行全栈 `down`；不要用 `down -v`，不要清空数据库或 Redis。
普通 `restart` 不会应用容器安全选项或镜像变化。

## 原失败任务与业务复验

原任务 `35e33ca6-0f3a-47c6-ba62-4e5eda6dc48a` 保留，本次没有手工更改状态
或重放。可在页面原任务点击“继续生成”触发业务验证；该步骤可能产生模型费用。

若仍报错，先记录操作时间和任务 ID，查看媒体 Worker 与 server 日志，再查
数据库状态；不要只根据前端按钮判断任务是否卡住：

```bash
cd /agent
docker-compose logs --since=10m --tail=200 media-analysis-worker server
docker-compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off' <<'SQL'
SELECT id, status, stage, error_code, updated_at, lease_until, now() AS db_now
FROM marketing_reference_analyses
WHERE deleted_at IS NULL
ORDER BY created_at DESC
LIMIT 5;
SQL
```

分享日志前去除令牌、Cookie、签名 URL 和个人信息。真实下载失败时继续区分
平台限制、服务器出口网络、下载代理及后续模型阶段，不能再次笼统归因于硬件。

## 回退

本次备份目录保留原 Compose、原安全目录和 v1 AppArmor 文件。
先确认无在途任务，再停止媒体 Worker：

```bash
cd /agent
docker-compose stop media-analysis-worker
```

对照备份，只恢复媒体服务原 image 与 security_opt，避免整份覆盖其他服务
后续变更。原 image 为 `lot-agent-media-analysis:1.0`，原 security_opt 仅为
`no-new-privileges:true`。校验后仅重建该服务：

```bash
docker-compose config --quiet
docker-compose up -d --no-deps --force-recreate media-analysis-worker
```

回退会恢复本机已知不能运行 bubblewrap 的旧状态，不代表媒体功能恢复。
保留新旧镜像、业务卷及任务账本，修复后再切换；不卸载仍被容器使用的
AppArmor profile，不修改其他容器的策略。
