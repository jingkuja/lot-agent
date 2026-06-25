# Lot Agent 部署手册（第一个版本 · 单机 Docker Compose）

本手册说明如何用 Docker Compose 在一台主机上部署 Lot Agent 平台基座。

> 适用范围：第一个版本 / 内测 / 单机环境。生产高可用（多副本、TLS 终止、外部托管 PG/Redis、对象存储等）不在本手册范围，详见末尾「后续演进」。

---

## 1. 架构总览

5 个容器，浏览器只访问 `web`（nginx）一个入口：

```
                  ┌──────────── web (nginx) ────────────┐
  浏览器 ─:80───▶ │ 托管 web/dist 静态文件 + 反向代理:     │
                  │   /api    → server:3000              │
                  │   /static → server:3000  (SSE 不缓冲) │
                  └──────────────────────────────────────┘
                          │                     │
                   ┌──────▼──────┐       ┌──────▼───────┐
                   │   server    │       │    worker    │  同一 Node 镜像,
                   │ HTTP API    │       │ 异步任务消费  │  ROLE 区分入口
                   └──┬───────┬──┘       └──┬────────┬──┘
                      │       │  共享 app_data 卷 (data/assets 等)
              ┌───────▼─┐   ┌─▼──────────▼─┐
              │ postgres│   │    redis     │  各自命名卷持久化
              └─────────┘   └──────────────┘
```

关键点：

- **server 与 worker 是同一份代码、同一个镜像**（`lot-agent-app`），靠环境变量 `ROLE` 决定启动 `index.js`（API）还是 `workers/index.js`（任务消费）。
- **server 与 worker 共享 `app_data` 卷**：worker 生成图片/视频写入 `data/assets`，server 在 `/static` 读取并对外提供。二者必须挂同一个卷，否则前端拿不到生成结果。
- **数据库表由应用启动时自动迁移创建**（`packages/server/src/db/database.ts` 的 `migrate()`，幂等 `CREATE TABLE IF NOT EXISTS`）。`deploy/postgres/init.sql` 只负责扩展等应用做不了的事。
- **所有密钥来自 `.env`**，镜像与编排文件不含明文。

---

## 2. 前置依赖

| 依赖 | 版本 | 说明 |
|---|---|---|
| Docker Engine | ≥ 24 | 含 Compose v2（`docker compose`） |
| Docker Compose | v2.x | 旧版 `docker-compose` 也可，命令替换即可 |
| 可用内存 | ≥ 2 GB | PG + Redis + 两个 Node 进程 + nginx |
| 出网 | 构建时拉取基础镜像/依赖；运行时访问 LLM 厂商 API |
| 至少一个 LLM Key | — | `OPENAI_API_KEY`（OpenAI 兼容，默认 DeepSeek）或 `ANTHROPIC_API_KEY`，否则聊天不可用 |

无需在宿主机安装 Node / PostgreSQL / Redis，全部在容器内。

---

## 3. 交付物清单

| 文件 | 作用 |
|---|---|
| `Dockerfile` | Node 应用镜像（server + worker 共用），多阶段构建 |
| `entrypoint.sh` | 容器入口：按 `ROLE` 选 server/worker，并等待 PG/Redis 就绪 |
| `Dockerfile.web` | 构建 web 静态包并用 nginx 托管 |
| `deploy/nginx.conf` | nginx 静态托管 + `/api` `/static` 反代 + SSE 配置 |
| `deploy/postgres/init.sql` | 数据库首次初始化（扩展等），**不建表** |
| `docker-compose.yml` | 5 个服务的编排、卷、健康检查 |
| `deploy/.env.example` | Compose 所需环境变量模板 |
| `.dockerignore` | 收敛构建上下文 |

---

## 4. 配置

在仓库根目录创建 `.env`（不会被提交）：

```bash
cp deploy/.env.example .env
```

编辑 `.env`，至少修改：

```ini
PG_PASSWORD=<强口令>
REDIS_PASSWORD=<强口令>
# 至少配置一个 LLM Key：
OPENAI_API_KEY=<你的 Key>      # 或 ANTHROPIC_API_KEY
CORS_ORIGIN=http://<你的域名或IP>  # 例如 http://localhost 或 http://192.168.1.10
WEB_PORT=80                     # 浏览器访问端口，被占用可改成 8080 等
```

> 主机名等非密钥的接线（`PG_HOST=postgres`、`REDIS_HOST=redis`、`REDIS_URL`、`PORT` 等）已写在 `docker-compose.yml` 中，无需手填。
>
> Compose 在 `PG_PASSWORD` / `REDIS_PASSWORD` 缺失时会直接报错（编排里用了 `${VAR:?...}` 强校验），属预期保护。

---

## 5. 构建与启动

```bash
# 构建镜像并后台启动全部服务
docker compose up -d --build

# 查看状态（等待 healthy）
docker compose ps

# 跟踪日志
docker compose logs -f server worker
```

首次启动顺序由健康检查保证：`postgres` / `redis` 先 healthy，`server` 与 `worker` 才启动；`server` 启动时自动执行表结构迁移。

启动成功的标志：

- `docker compose ps` 中 `postgres`、`redis`、`server`、`web` 均为 `healthy`/`running`；
- `server` 日志出现 `Server running on http://localhost:3000`；
- `worker` 日志出现 `Worker started, listening for jobs`。

---

## 6. 验证

```bash
# 1) nginx 自身存活（web 容器）
curl http://localhost:${WEB_PORT:-80}/healthz

# 2) 后端 /health（容器内；注意 nginx 只反代 /api 与 /static，
#    /health 不经反代，需在容器内直接访问或临时映射 server 端口）
docker compose exec server node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"

# 3) 经 nginx 反代访问受保护 API（未带 token 应返回 401，说明链路通）
curl -i http://localhost:${WEB_PORT:-80}/api/agents

# 4) 数据库表已自动创建
docker compose exec postgres psql -U "$PG_USER" -d "$PG_DATABASE" -c "\dt"
```

浏览器打开 `http://<主机IP>:<WEB_PORT>`，应看到登录/聊天界面。注册或登录后发起一次对话即可验证 LLM 链路（需已配置 Key）。

> 异步生成（图片/视频）当前为 **Stub** 实现：worker 会产出占位资产，用于验证任务队列与计费链路通畅，并非真实生成内容（见 `CLAUDE.md` 的「未完成」说明）。

---

## 7. 运维常用命令

```bash
docker compose ps                 # 状态
docker compose logs -f server     # 实时日志（server/worker/web/postgres/redis）
docker compose restart server     # 重启单个服务
docker compose up -d --build      # 改代码后重建并滚动更新
docker compose down               # 停止并移除容器（保留数据卷）
docker compose down -v            # 同时删除数据卷（数据全部清空，谨慎）
```

### 升级（拉取新代码后）

```bash
git pull
docker compose up -d --build      # 重建镜像；server 启动自动跑增量迁移
```

迁移是幂等的（`IF NOT EXISTS`），重复执行安全。

### 数据卷

| 卷 | 内容 | 备注 |
|---|---|---|
| `pg_data` | PostgreSQL 数据 | 业务数据，务必备份 |
| `redis_data` | Redis AOF | 队列/缓存，可重建但建议保留 |
| `app_data` | `data/assets`、`data/documents`、`data/uploads` | 生成与上传的文件，务必备份 |

### 备份与恢复

```bash
# 备份数据库
docker compose exec -T postgres pg_dump -U "$PG_USER" "$PG_DATABASE" > backup-$(date +%F).sql

# 恢复数据库
cat backup-YYYY-MM-DD.sql | docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DATABASE"

# 备份资产卷
docker run --rm -v lot-agent_app_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/app_data-$(date +%F).tar.gz -C /data .
```

> 卷名前缀为 Compose 项目名（默认是目录名 `lot-agent`）。用 `docker volume ls` 确认实际名称。

---

## 8. 常见问题

**Q：`server` 反复重启，日志报 `PG_PASSWORD is required` 或连不上数据库。**
确认 `.env` 已设置 `PG_PASSWORD`，且 `postgres` 已 `healthy`。entrypoint 会等待 PG 的 TCP 端口，最长 `WAIT_TIMEOUT`（默认 60s）。

**Q：聊天报错 / 无回复。**
多半是未配置 LLM Key。检查 `.env` 的 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`，以及 `LLM_DEFAULT` 与所用厂商一致；`server` 启动日志会打印 `WARNING: No LLM API key configured`。

**Q：聊天能发出但前端不“逐字”流式输出。**
SSE 被中间层缓冲所致。本方案已在 `deploy/nginx.conf` 对 `/api/` 关闭 `proxy_buffering`；若你在 `web` 前又加了一层网关/CDN，需同样关闭缓冲并放宽读超时。

**Q：生成了图片/视频但前端打不开。**
确认 `server` 与 `worker` 挂的是同一个 `app_data` 卷（本编排已保证）。若你自定义了挂载，请保持一致。

**Q：80 端口被占用。**
改 `.env` 的 `WEB_PORT`（如 `8080`），重新 `docker compose up -d`，并相应更新 `CORS_ORIGIN`。

**Q：想直接调试后端 API（绕过 nginx）。**
取消 `docker-compose.yml` 中 `server` 的 `ports: - "3000:3000"` 注释并重启。

**Q：改了 `config/default.json` 想不重建镜像生效。**
默认 config 烤进镜像。临时可在 `server`/`worker` 增加挂载：
```yaml
    volumes:
      - app_data:/app/data
      - ./config:/app/config:ro
```
然后 `docker compose up -d`。

---

## 9. 安全注意事项

- `.env` 含明文密钥，已被 `.gitignore` 忽略，**切勿提交**；生产建议用密钥管理服务注入。
- `PG_PASSWORD`、`REDIS_PASSWORD` 使用强随机口令；Redis 已启用 `requirepass`。
- 默认未对外暴露 `postgres`/`redis`/`server` 端口，仅 `web` 对外。对公网开放时请在 `web` 前加 TLS（反代/负载均衡终止 HTTPS）并把 `CORS_ORIGIN` 设为 `https://` 域名。

---

## 10. 后续演进（不在本版本）

- 真实模型厂商（通义万相 / 可灵 / DALL·E）、OAuth 发布、云内容审核替换现有 Stub。
- 外部托管的 PostgreSQL / Redis、对象存储替换本地磁盘 `app_data`。
- 多副本 + 负载均衡、TLS 终止、Redis 限流、正式的迁移运行器。

详见 `plan.md` 与 `CLAUDE.md`。
