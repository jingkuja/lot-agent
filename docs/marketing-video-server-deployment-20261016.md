# 营销影像服务器部署与沙箱修复记录

部署日期：2026-10-16（北京时间）。目标：`192.140.178.86:22`。

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
