# Lot Agent 远程更新方案（OTA · 整镜像 tar 包 · 盒子主动拉取 · 自愈回滚）

> 文档日期：2026-06-30 ｜ 整合并取代根目录旧版《远程更新方案.md》。
> 适用范围：**应用容器（`server` / `worker` / `web`）的远程镜像更新**。
> `postgres` / `redis` 当前随盒子部署，**后续上云**；本方案不更新数据容器，架构已为其上云预留。
> 本目录同时提供盒子上**可直接执行的脚本与配置**（见文末「目录清单」）。

---

## 0. 部署约束与拓扑

| 约束 | 含义 |
|---|---|
| 计算盒子在**客户现场**，你方运维无法物理接触 | 更新必须**远程 + 无人值守** |
| 盒子**可出网**（HTTPS 访问你方更新服务端、下载文件） | ✅ 采用**盒子主动拉取（phone-home）**模型 |
| 盒子已部署 **frp 内网穿透**，建立到你方的反向隧道 | ✅ 你方可经 frp **SSH 进盒子排错**（仅排错/兜底，不参与更新主流程） |
| 进不去盒子常态排错 | ✅ 更新必须**自愈**：失败 100% 自动回滚 + 状态上报 |

由此定死的设计：

1. **更新触发 = 盒子轮询**：盒子上 `update-run.sh` 由 systemd timer 每 ~5 分钟跑一次。
2. **两条更新路径**：
   - **每晚定时**：仅当当前时间落在 `[UPDATE_WINDOW_START, UPDATE_WINDOW_END]`（默认 00:00–00:30）且有新版本时，执行版本更新。
   - **手动（中心服务端标记）**：你方在服务端给某盒子打 `update_now` 标记 → 盒子下一次轮询（≤5 分钟）即**绕过午夜窗口立即更新**。
3. **100% 自愈回滚**：更新后健康检查失败 → 自动切回上一版镜像，绝不卡在坏版本。
4. **产物 = 整镜像 tar 包**：`docker save` 出的 `lot-agent-app` / `lot-agent-web` 镜像包，盒子 `docker load` 后切 tag 重启。代码+依赖永远一致、回滚最干净。
5. **frp 放 Docker 外、做 systemd 原生服务**：即使整个 Docker 栈挂了，隧道仍在 → 你还能 SSH 进盒子救场。这是「连回滚都失败」时的最后保险。

---

## 1. 总体架构

```
┌──────────── 你方中心服务器 ────────────┐        ┌──────────── frp 服务端 frps ───────────┐
│  GET  /update/check    → 版本+update_now │        │  暴露 60022→盒子:22(SSH)、60080→盒子:80 │
│  GET  /artifacts/*.tar.gz  → 镜像包下载  │        │  你方经此反向隧道进盒子排错（仅兜底）   │
│  POST /update/report   → 接收盒子上报    │        └────────────────────▲────────────────────┘
│  （HTTPS + 静态文件 + 两个轻端点）       │                 frpc 出站长连│
└───────────────────▲─────────────────────┘                             │
        出网 HTTPS（盒子→服务器，单向）│                                │
┌───────────────────┴──────────────────── 客户盒子（Linux + systemd）───┴───────────────────┐
│  systemd 单元：                                                                            │
│   • docker.service        （enabled，开机起 Docker）                                       │
│   • frpc.service          （enabled，原生二进制，开机建隧道；Docker 挂了也在）             │
│   • lot-agent.service      （oneshot：docker compose up -d，开机兜底拉起栈）               │
│   • lot-updater.timer→.service（oneshot：每 ~5min 跑 update-run.sh）                       │
│                                                                                           │
│  Docker compose 栈（restart: unless-stopped，随 Docker 自恢复）：                          │
│   app（被更新）： server   worker   web                                                    │
│   data（不更新）：postgres  redis     ← 后续上云后从盒子移除                               │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

> **更新服务端 ≠ 盒子里的 `server` 容器**。它对盒子只是「更新 API + 文件下载」，**不需要 docker registry**。

---

## 2. 组件职责

### 2.1 更新服务端（你方中心服务器）

| 端点 | 方法 | 作用 |
|---|---|---|
| `/update/check` | GET | 轻量端点。盒子带 `box_id` / `channel` / `current` + `X-Box-Token`。返回 `{ update_now, version, images[], compose_url }`。频繁调用，**必须便宜**。 |
| `/artifacts/<file>.tar.gz` | GET | 镜像 tar 包静态下载，建议支持 `Range`（断点续传，弱网友好）。 |
| `/artifacts/docker-compose-<ver>.yml` | GET | （可选）compose 结构变化时下发新编排。 |
| `/update/report` | POST | 盒子上报：当前版本、上次结果、健康、时间戳、失败日志摘要。 |

最小实现：nginx/对象存储托管 `artifacts/` + 一个轻服务处理 `check` / `report`。**手动触发**即在服务端把目标盒子的 `update_now` 置 true；盒子更新成功上报后服务端自动清除该标记。

### 2.2 盒子上的 updater（`update-run.sh` + systemd timer）

- **不再是容器**：作为**宿主机脚本**由 systemd 一次性运行，直接用宿主 `docker` / `docker compose`，**无需挂 docker.sock**。
- 每次运行：拉 `check` → 决策（手动标记 / 午夜窗口）→ 下载校验 → `docker load` → 改 `.env` 切 tag → `compose up -d server worker web` → 健康检查 → 成败/回滚 → 上报。
- 状态持久化在 `/var/lib/lot-ota/state.json`。

### 2.3 frpc（`frpc.service` + `frpc.toml`）

- 原生二进制 `/usr/local/bin/frpc`，systemd `Restart=always`，开机自启。
- 建立反向隧道：`frps:60022 → 盒子:22`（SSH 排错）、可选 `frps:60080 → 盒子:80`（web 现场调试）。
- **仅排错/兜底**，不在更新主流程内。

---

## 3. 接口格式

### 3.1 `/update/check` 响应

```json
{
  "update_now": false,
  "version": "1.2.0",
  "released_at": "2026-06-30T16:00:00Z",
  "mandatory": false,
  "images": [
    { "name": "lot-agent-app", "tag": "1.2.0",
      "url": "https://update.example.com/artifacts/lot-agent-app-1.2.0.tar.gz",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb924...", "size": 312000000 },
    { "name": "lot-agent-web", "tag": "1.2.0",
      "url": "https://update.example.com/artifacts/lot-agent-web-1.2.0.tar.gz",
      "sha256": "a1d0c6e83f027327d8461063f4ac58a6...", "size": 18000000 }
  ],
  "compose_url": null,
  "notes": "修复标题生成；升级 server 健康检查"
}
```

- **app + web 同一 release 版本号**统一发布，避免错配。
- `update_now=true`：你方手动标记，盒子立即更新（绕过午夜窗口）。
- `compose_url` 平时 `null`（只换 tag）；**仅当 compose 结构变化**时下发新编排。
- `sha256` / `size`：完整性校验 + 磁盘预检。

### 3.2 `/update/report` 请求

```json
{ "box_id": "box-0001", "current_version": "1.2.0", "previous_version": "1.1.0",
  "result": "success | failure | rolled_back", "at": "2026-06-30T16:05:00Z",
  "error": null, "health": "ok" }
```

---

## 4. 更新流程（`update-run.sh` 单次运行）

```
每次 timer 触发（默认每 5 分钟一次）：

1. 读本地 state.current_version（无则取 .env 的 APP_TAG）
2. GET /update/check?box_id=&channel=&current=   （带 X-Box-Token）
   网络/服务端失败 → 本轮静默退出（旧版继续跑，下次再试）
3. 决策：
   - update_now == true                       → 执行更新（手动路径，绕过窗口）
   - 否则 version == current                  → 无更新，结束
   - 否则 现在 ∉ [窗口]                        → 未到午夜窗口，结束
   - 否则                                      → 执行更新（定时路径）
4. 执行更新到 target：
   a. 磁盘预检（Σsize + 余量）；不足 → 放弃 + 上报 failure
   b. 逐个下载 tar 到临时目录 → 校验 sha256
        任一失败 → 清理，旧版继续跑 → 上报 failure
   c. docker load 每个 tar（新 tag 镜像；旧 tag 保留不删）
   d. previous_version = current_version（写 state，供回滚）
   e. 切 tag：写 .env 的 APP_TAG/WEB_TAG=target
        （compose 结构变化时：先拉 compose_url 覆盖 docker-compose.yml）
   f. docker compose up -d server worker web   （只重建 app；data 容器不动）
   g. 健康检查（≤ HEALTH_TIMEOUT，默认 90s，见 §5）
        ├─ 通过：current_version=target；prune 过旧镜像（留最近 KEEP_VERSIONS 版）→ 上报 success
        └─ 失败：回滚 ↓
5. 回滚（100% 命门）：
   a. 写回 .env 的 tag = previous_version（必要时恢复旧 compose）
   b. docker compose up -d server worker web
   c. 复测健康；无论结果都上报 rolled_back + 失败详情（日志尾部）
```

**关键不变量**：
- **data 容器全程不动**：`compose up -d` 显式只列 `server worker web`。
- **旧镜像不立即删**：回滚靠它，至少保留上一版。
- **任何一步失败都不让盒子停在坏状态**：要么没更成（旧版继续跑），要么回滚回旧版。

---

## 5. 健康检查与 100% 回滚

健康判定（盒子本地，updater 直接探测）：

- **server**：容器内置 `HEALTHCHECK` 探 `:3000/health`（server 起得来 ⇒ 数据库连上、迁移跑完）。updater 读 `docker inspect -f '{{.State.Health.Status}}'` == `healthy`。
- **web**：`curl http://127.0.0.1:${WEB_PORT}/healthz` == `ok`（nginx 本地健康端点，见 `deploy/nginx.conf`）。
- **worker**：容器 `running` 即视为存活（compose 已禁用其 healthcheck，无 HTTP 口）。

三者全绿才算健康；**必须有超时**，超时即判失败回滚，避免卡在「启动中」。

回滚为何可靠：方案是**不可变镜像**，上一版镜像还在盒子本地，回滚只是改 `.env` tag + `compose up -d` 切回，**秒级、确定性**。

> ⚠️ **迁移红线（最隐蔽的坑）**：代码回滚**不回滚数据库迁移**。因此迁移必须**只增不改、向后兼容**（沿用 `db/database.ts` 的 `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` 幂等约定），保证「旧代码也能跑在新库结构上」。否则回滚后旧代码遇新结构会报错。

> 🛟 **双重失败兜底**：若连回滚都失败（极罕见），盒子可能不可用——此时经 **frp SSH** 进盒子人工救场（手动 `docker compose up -d`、改 `.env`、看日志）。这就是 frp 隧道在更新体系里的价值。

---

## 6. 盒子本地状态与磁盘

`/var/lib/lot-ota/state.json`：

```json
{ "current_version": "1.2.0", "previous_version": "1.1.0",
  "last_check_at": "2026-06-30T16:05:00Z", "last_result": "success", "last_error": null }
```

- **镜像保留**：本地保留最近 `KEEP_VERSIONS`（默认 2）个版本（当前 + 上一版），更老的在更新成功后 `docker image prune` 清理，控制磁盘。
- 状态目录在宿主机，盒子重启不丢，timer 据此续跑。

---

## 7. 编排改造（tag 参数化）

不改根目录主 `docker-compose.yml`，而是放一份 **override** 与之同级自动合并，让镜像 tag 由 `.env` 驱动：

`deploy/ota/docker-compose.override.yml`（安装时复制到 compose 目录）：

```yaml
services:
  server:
    image: lot-agent-app:${APP_TAG:-1.0}
  worker:
    image: lot-agent-app:${APP_TAG:-1.0}
  web:
    image: lot-agent-web:${WEB_TAG:-1.0}
```

`.env` 需含（updater 会改写这两行切版/回滚）：

```
APP_TAG=1.0
WEB_TAG=1.0
```

---

## 8. frp 内网穿透配置

**盒子侧** `frpc.toml`（frp ≥ 0.52 TOML 格式，见本目录模板）建立反向隧道；由 `frpc.service` 开机自启、`Restart=always` 守护。

**你方 frps（服务端）** 需放通对应 `remotePort`（如 60022 / 60080），并与盒子共享 `auth.token`。一盒一隧道，`remotePort` 按盒子编号区分（如 `6XX22`）。

排错示例：`ssh -p 60022 user@frps.example.com` 即进入对应盒子。

---

## 9. 开机自启（systemd + Docker restart）

四道保障，缺一不可：

1. **Docker 本体**：`systemctl enable docker` → 开机起 Docker。
2. **容器自恢复**：compose 服务 `restart: unless-stopped`（现有 compose 已配）→ Docker 起来后容器自动回来。
3. **栈兜底拉起**：`lot-agent.service`（oneshot `docker compose up -d`，`enabled`）→ 处理「容器被删 / compose 变更 / 首启次序」边角情况。
4. **隧道与 updater**：`frpc.service`（enabled）+ `lot-updater.timer`（enabled，`OnBootSec` + `OnUnitActiveSec`）。

重启后顺序：网络就绪 → docker → 容器自恢复 + lot-agent 兜底 → frpc 建隧道 → updater timer 开始轮询。

---

## 10. 你方发布流程（构建机执行，非盒子）

见本目录 `release.sh`。要点：

```bash
VER=1.2.0
docker build -t lot-agent-app:$VER -f Dockerfile .
docker build -t lot-agent-web:$VER -f Dockerfile.web .
docker save lot-agent-app:$VER | gzip > lot-agent-app-$VER.tar.gz
docker save lot-agent-web:$VER | gzip > lot-agent-web-$VER.tar.gz
# 算 sha256 / size → 生成 manifest → 上传
```

**发布顺序是命门**：**先**上传所有 tar 制品，**最后**才更新服务端的版本指针（让 `/update/check` 返回新 `version`）。这样盒子永不会拉到「清单已变、文件还没到」的半成品。

---

## 11. 安全

- manifest 与制品全程 **HTTPS**。
- **sha256 强制校验**：半包/损坏直接放弃本轮更新。
- **盒子鉴权**：请求头 `X-Box-Token`，一盒一码，服务端校验。
- **frp 鉴权**：`auth.token`，仅你的盒子能建隧道；`remotePort` 按盒子隔离。
- **（建议二期）清单签名验签**：你方私钥签 manifest，updater 用内置公钥验签，防中间人下发恶意镜像（现场无人值守，价值高）。
- updater 直接持宿主 docker 权限（高权限），脚本须极简、来源可信。

---

## 12. 落地执行步骤

### 12.1 盒子首次安装（root，约 10 分钟）

```bash
# 0) 前置：已装 Docker / docker compose；盒子可出网
# 1) 拷贝部署文件到盒子 /opt/lot-agent（含 docker-compose.yml、Dockerfile 产出的镜像或首版 tar）
# 2) 准备 .env（含 PG_PASSWORD / REDIS_PASSWORD / APP_TAG=1.0 / WEB_TAG=1.0 等）
# 3) 准备 box.env（更新服务端地址、BOX_ID、BOX_TOKEN，由 box.env.example 复制）
# 4) 配置 frpc.toml（serverAddr / auth.token / remotePort）
# 5) 一键安装：放置脚本+systemd单元、装依赖(jq/curl)、装frpc、启用自启、首次拉起
sudo bash /opt/lot-agent/ota/install-box.sh
```

安装完成后核对：

```bash
systemctl is-enabled docker frpc lot-agent lot-updater.timer   # 均应 enabled
systemctl status frpc lot-updater.timer --no-pager
docker compose -f /opt/lot-agent/docker-compose.yml ps          # app+data 容器 Up/healthy
ssh -p 60022 user@frps.example.com                              # 隧道可达
```

### 12.2 日常发布（你方）

1. 构建机跑 `release.sh 1.2.0` → 上传 tar + 更新服务端版本指针。
2. 当晚各盒子 00:00–00:30 窗口自动拉取更新；成功/回滚均回报。
3. 在服务端看各盒子 `report` 汇总确认。

### 12.3 手动立即更新某盒子（你方）

1. 服务端给该 `box_id` 置 `update_now=true`。
2. 盒子 ≤5 分钟内轮询拾取 → 立即更新（绕过午夜窗口）。
3. 上报 success 后服务端自动清除该标记。
4. （应急）也可经 frp SSH 进盒子，手动 `systemctl start lot-updater.service` 立刻触发一次。

### 12.4 回滚验证（上线前演练）

```bash
# 故意发一个会健康检查失败的版本，或本地把 server 端口改错，观察：
journalctl -u lot-updater -f          # 看到健康检查失败 → 自动回滚日志
cat /var/lib/lot-ota/state.json       # last_result=rolled_back，current 仍为旧版
docker compose ps                     # 容器回到上一版且 healthy
```

---

## 13. 范围与后续演进

**本方案做**：`server`/`worker`/`web` 三容器的镜像化远程更新（定时+手动、自愈回滚、状态上报）、frp 隧道、开机自启。

**后续（不在本期）**：
- **数据库上云**：postgres/redis 迁云后从盒子 compose 移除，app 改连云端连接串；盒子只剩 app + updater，本模型不变。
- **updater 自更新**：首版假定 `update-run.sh` 不变；自替换机制列二期。
- **灰度/分批发布**：`/update/check` 已带 `box_id`/`channel`，可扩展按盒子放量、强制升级。
- **清单签名验签**：见 §11，建议二期。

---

## 目录清单（`deploy/ota/`）

| 文件 | 位置 | 作用 |
|---|---|---|
| `update.md` | 文档 | 本方案 |
| `update-run.sh` | 盒子 `/opt/lot-agent/ota/` | **核心**：单次「检查→更新→健康→回滚→上报」 |
| `install-box.sh` | 盒子（root 跑一次） | 首次安装：放文件、装依赖/frpc、装 systemd 单元、启用自启、首启 |
| `box.env.example` | 盒子 `/opt/lot-agent/box.env` | OTA 配置模板（更新服务端 / BOX_ID / TOKEN / 窗口 / 超时） |
| `docker-compose.override.yml` | 盒子 compose 目录 | 镜像 tag 参数化（`${APP_TAG}` / `${WEB_TAG}`） |
| `frpc.toml` | 盒子 `/opt/lot-agent/ota/` | frp 客户端隧道配置模板 |
| `systemd/frpc.service` | `/etc/systemd/system/` | frpc 原生服务，开机自启 |
| `systemd/lot-agent.service` | `/etc/systemd/system/` | 开机 `docker compose up -d` 兜底 |
| `systemd/lot-updater.service` | `/etc/systemd/system/` | oneshot：跑 `update-run.sh` |
| `systemd/lot-updater.timer` | `/etc/systemd/system/` | 每 ~5min + 开机后触发 updater |
| `release.sh` | **构建机**（非盒子） | 发布：build→save→sha256→manifest→上传 |
