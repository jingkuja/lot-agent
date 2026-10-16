# 营销影像：新服务器首次部署

适用：源码 `/lot-agent/`、运行配置 `/agent/` 的单机 Docker 部署。
基础平台说明见 [部署手册](deployment.md)；本指南补齐参考视频拆解的媒体
Worker 构建、宿主机策略及启动顺序。这里使用全新构建的 `:1.0` 镜像，
不需要旧服务器的 `20261016-sandbox2` 修复镜像。

已验证环境为 Ubuntu 22.04、内核 5.15、Docker 29.1.3、amd64。
策略支持 amd64 / arm64，但 arm64 和其他系统组合仍须在目标机运行预检；
不能仅凭相同 Ubuntu 名称判断一定通过。本文不是自动安装脚本，配置占位符
需要替换，失败步骤应先解决再继续。

## 1. 准备宿主机和运行目录

安装 Docker Engine、Compose 和 Ubuntu 的 AppArmor 工具，确认 Docker
可运行、AppArmor 已启用；不需要在宿主机安装 yt-dlp、FFmpeg 或 Node。
可参考 [Docker 官方 Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)。

```bash
apt-get update
apt-get install -y apparmor apparmor-utils
systemctl enable --now apparmor
docker version
docker compose version
uname -m
sysctl user.max_user_namespaces kernel.unprivileged_userns_clone
```

要求 user namespace 数量大于 0、`kernel.unprivileged_userns_clone=1`。
不满足时先检查宿主机策略，不要用 privileged 或关闭全部安全策略绕过。
本文使用 `docker compose`；已安装且兼容的 `docker-compose` 可替换命令前缀。

将完整发布源码放到 `/lot-agent/`，然后**仅在新的空运行目录**准备文件：

```bash
install -d -m 0755 /agent/deploy/postgres /agent/security
install -m 0644 /lot-agent/docker-compose.yml /agent/docker-compose.yml
install -m 0644 /lot-agent/deploy/postgres/init.sql /agent/deploy/postgres/init.sql
install -m 0600 /lot-agent/deploy/.env.example /agent/.env
cp -a /lot-agent/deploy/security/. /agent/security/
```

Compose 中 PostgreSQL 使用相对挂载 `./deploy/postgres/init.sql`，因此只复制
Compose 和 `.env` 不够。已有服务器不要覆盖 `.env`、Compose 或业务卷；
升级流程见 [安全策略说明](../deploy/security/README.md)。

## 2. 填写环境配置

编辑 `/agent/.env`，按基础部署手册设置数据库/Redis 强口令、模型服务与
账号/计费接入配置，再添加或更新以下字段，避免重复定义：

```ini
COMPOSE_PROFILES=media-analysis
MARKETING_ANALYSIS_ENABLED=1
YTDLP_VERSION=<固定发行版本>
YTDLP_SHA256=<该版本对应目标镜像架构的官方SHA256>
SECRET_MASTER_KEY=<32字节随机密钥的64位十六进制编码>
PUBLIC_BASE_URL=https://<本机对外服务域名>
CORS_ORIGIN=https://<本机对外服务域名>
```

若同时需要知识库 Worker，设置 `COMPOSE_PROFILES=media-analysis,knowledge`。
仓库 Compose 默认保留 `profiles: [media-analysis]`；不启用 profile，单独
执行 `docker compose up -d` 不会启动该服务。

密钥可用 `openssl rand -hex 32` 在可信终端生成并妥善保存；同一部署 API
和 Worker 必须共用它。迁移已有数据库时必须复用旧主密钥，不能另生成。
保持生产调试关闭，不设置 Mac 专用 `MARKETING_ANALYSIS_MACOS_SANDBOX`。

yt-dlp 从 [官方发行列表](https://github.com/yt-dlp/yt-dlp/releases)选定固定版本，
从**该版本** `SHA2-256SUMS` 取值：amd64 对应 `yt-dlp_linux`，arm64 对应
`yt-dlp_linux_aarch64`。不是通用 `yt-dlp` 文件的校验值；不要跨版本或架构复用。
2026-10-16 已部署实例使用 `2026.08.19`，这只是已验证版本记录，不代表最新版本。

域名、TLS 和反向代理需实际可访问。仓库 Web 容器提供 HTTP，HTTPS 需在
外层入口配置；`PUBLIC_BASE_URL` 必须是模型供应商可以访问的公开地址，
否则音频识别可能失败。媒体模型能力、用户凭证及费用说明见
[参考视频分析说明](marketing-video-reference-analysis.md)。

## 3. 从源码构建三个镜像

在 `/lot-agent/` 构建；`.env` 供 Compose 读取，**不会自动成为 Docker 构建参数**。
将以下两个非秘密值填成 `/agent/.env` 中完全相同的配置：

```bash
cd /lot-agent
export YTDLP_VERSION='<固定发行版本>'
export YTDLP_SHA256='<对应架构的官方SHA256>'
docker build -t lot-agent-app:1.0 -f Dockerfile .
docker build -t lot-agent-web:1.0 -f Dockerfile.web .
docker build -t lot-agent-media-analysis:1.0 -f Dockerfile.media-analysis \
  --build-arg APP_IMAGE=lot-agent-app:1.0 \
  --build-arg YTDLP_VERSION="$YTDLP_VERSION" \
  --build-arg YTDLP_SHA256="$YTDLP_SHA256" .
```

媒体镜像已包含动态库链接修复，不用再构建 `Dockerfile.runtime-fix`。
构建中的 SHA256 校验失败时应修正版本/架构/校验值，不删除校验逻辑。
以上默认本机原生构建；跨架构构建须让目标架构与选定下载器一致。

## 4. 安装安全策略并预检

```bash
apparmor_parser --skip-kernel-load --skip-cache /agent/security/lot-agent-media-analysis.apparmor
install -m 0644 /agent/security/lot-agent-media-analysis.apparmor /etc/apparmor.d/lot-agent-media-analysis-v2
apparmor_parser -r /etc/apparmor.d/lot-agent-media-analysis-v2
bash /agent/security/check-media-sandbox.sh \
  /agent/security/media-analysis-seccomp.json lot-agent-media-analysis:1.0
```

所有检查应 PASS；测试不挂业务卷、不带密钥、不调用模型。
namespace、mount、proc 或动态库失败的解释见
[安全策略说明](../deploy/security/README.md)。

然后编辑 `/agent/docker-compose.yml` 的现有媒体服务，添加 `user` 并替换
`security_opt` 为下面的内容，保留其他环境、资源限制、依赖、profile 和共享卷：

```yaml
  media-analysis-worker:
    image: lot-agent-media-analysis:1.0
    user: node
    security_opt:
      - no-new-privileges:true
      - seccomp=/agent/security/media-analysis-seccomp.json
      - apparmor=lot-agent-media-analysis-v2
      - systempaths=unconfined
    cap_drop: [ALL]
```

这是需要合并的字段，不能用它覆盖整个服务。宿主机策略不能只打进镜像。
`systempaths=unconfined` 必须配套 v2 AppArmor；它解除系统路径挂载限制，
不等于关闭 seccomp/AppArmor，但与默认路径遮蔽的安全边界有差异，详见策略说明。

## 5. 启动与验证

```bash
cd /agent
docker compose config --quiet
# 先启动基础平台，由 server 执行数据库迁移。
docker compose up -d postgres redis server web
# 确认 server 为 healthy；如果失败，先检查日志，不继续启动消费者。
docker compose ps
docker compose logs --tail=80 server
# server 就绪后启动消费者；媒体服务依赖 server 健康检查。
docker compose up -d worker media-analysis-worker
# 如需知识库，另执行：docker compose up -d knowledge-worker
docker compose ps
docker compose logs --tail=80 media-analysis-worker
```

期望媒体日志出现 `Media analysis worker listening on lot-media-analysis`。
媒体 Worker 无 HTTP 健康端点，不能只因没有 healthy 标识认定它失败。

```bash
docker compose exec -T server node -e \
  "fetch('http://127.0.0.1:3000/health').then(r=>{console.log(r.status);if(!r.ok)process.exitCode=1})"
docker compose exec -T web nginx -t
docker compose exec -T media-analysis-worker yt-dlp --version
```

核对下载器版本等于 `.env` 中的固定版本。确认 API、媒体 Worker 共用同一
PG、Redis、主密钥与 `app_data` 卷；不要输出完整容器环境或展开后的 Compose，
其中可能包含秘密。

最后从页面提交自有短视频或平台链接进行完整业务验收，此步骤会调用模型并
可能计费。启动成功与沙箱预检通过不能代替真实下载、转写和分析结果验收。
失败时按 [实测部署记录](marketing-video-server-deployment-20261016.md) 的查询
步骤区分数据库状态、下载阶段及模型阶段，不直接重放未知计费状态的任务。

后续改 `.env`、镜像或安全选项需 `up -d --force-recreate` 相应服务，普通
`restart` 不更新这些配置。保留旧镜像和配置备份，不执行 `down -v`。
