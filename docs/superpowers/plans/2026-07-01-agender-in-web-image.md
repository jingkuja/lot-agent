# agender 打进 web 镜像 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 web 容器里让 `agender`(x86-64 机器信息服务,127.0.0.1:8080,`/system/stats`)与 nginx 一起常驻,并由 nginx 把 `/system/stats` 反代到它。

**Architecture:** runtime 阶段把现成二进制 `deploy/rust/agender` 和一个 entrypoint 脚本拷进 `nginx:alpine` 镜像;entrypoint 后台启 agender、前台 exec nginx 官方 entrypoint;nginx 加一条 `location = /system/stats` 精确匹配反代到本地 8080。

**Tech Stack:** Docker(多阶段)、nginx:1.27-alpine、POSIX sh、现成静态 ELF 二进制。

## Global Constraints

- **仅 amd64/x86-64**:agender 是静态 x86-64 ELF,无源码;不做多架构镜像。
- **不改** `docker-compose.yml`、`EXPOSE 80`、现有 `HEALTHCHECK`、`/api`·`/static`·`/assets`·SPA 兜底·`/healthz` 的行为。
- **不引入** supervisor/s6、鉴权、限流、Rust 构建阶段。
- 8080 仅容器内,不对外暴露;`/system/stats` 公开可达。
- ESM/缩进等仓库约定不涉及本次(纯 deploy 文件)。

---

### Task 1: agender 与 nginx 同容器 + /system/stats 反代

**Files:**
- Create: `deploy/web-entrypoint.sh`
- Modify: `Dockerfile.web`(runtime 阶段,`COPY web/dist` 之后追加 COPY/RUN/ENTRYPOINT)
- Modify: `deploy/nginx.conf`(在 `location / {` 之前新增 `location = /system/stats`)
- 现有产物(不改内容):`deploy/rust/agender`(构建时被 COPY 进镜像)

**Interfaces:**
- Consumes: `deploy/rust/agender` —— 监听 `127.0.0.1:8080`,提供 `GET /system/stats`,返回机器信息(非空 body,非 index.html)。
- Produces: web 镜像的 `ENTRYPOINT = /usr/local/bin/web-entrypoint.sh`;对外新增可达端点 `GET /system/stats`(经 :80 nginx 代理)。

- [ ] **Step 1: 写 entrypoint 脚本**

创建 `deploy/web-entrypoint.sh`:

```sh
#!/bin/sh
set -e
# 后台启动机器信息服务(仅容器内 127.0.0.1:8080,不对外 EXPOSE)
/usr/local/bin/agender &
# 前台交给 nginx 官方 entrypoint,保留基础镜像的模板/初始化行为
exec /docker-entrypoint.sh nginx -g 'daemon off;'
```

- [ ] **Step 2: 改 Dockerfile.web runtime 阶段**

在 `COPY --from=builder /app/packages/web/dist /usr/share/nginx/html` 行之后、`EXPOSE 80` 之前追加:

```dockerfile
# 机器信息服务:拷入现成 x86-64 二进制 + 进程入口脚本(agender 后台 + nginx 前台)
COPY deploy/rust/agender /usr/local/bin/agender
COPY deploy/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh
RUN chmod +x /usr/local/bin/agender /usr/local/bin/web-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]
```

`EXPOSE 80` 与其后的 `HEALTHCHECK` 保持不变。(注意:`ENTRYPOINT` 放在 `HEALTHCHECK` 之前或之后皆可,只要在 runtime 阶段内;此处置于 EXPOSE 前。)

- [ ] **Step 3: 改 nginx.conf 新增精确匹配 location**

在 `deploy/nginx.conf` 的 `server { ... }` 内、`# SPA history fallback` 注释与 `location / {` 之前插入:

```nginx
    # 机器信息服务(容器内 agender:8080),公开可达。
    location = /system/stats {
        proxy_pass http://127.0.0.1:8080/system/stats;
        proxy_http_version 1.1;
        proxy_set_header Host            $host;
        proxy_set_header X-Real-IP       $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

```

用 `location =` 精确匹配,优先级高于 `location /` 兜底,避免被 `try_files` 吞成 index.html。

- [ ] **Step 4: 构建镜像验证拷入成功**

Run:
```bash
docker build -f Dockerfile.web -t lot-agent-web:test .
docker run --rm --entrypoint sh lot-agent-web:test -c \
  'test -x /usr/local/bin/agender && test -x /usr/local/bin/web-entrypoint.sh && echo OK'
```
Expected: 构建成功,最后一行输出 `OK`(两个文件都存在且可执行)。

- [ ] **Step 5: 运行容器,验证 /system/stats 与 /healthz**

Run:
```bash
docker run -d --name agender-test -p 8088:80 lot-agent-web:test
sleep 2
echo "--- /healthz ---";      curl -fsS http://localhost:8088/healthz
echo "--- /system/stats ---"; curl -fsS http://localhost:8088/system/stats; echo
echo "--- logs ---";          docker logs agender-test 2>&1 | tail -20
docker rm -f agender-test
```
Expected:
- `/healthz` 返回 `ok`。
- `/system/stats` 返回 agender 的机器信息(非空、非 404、非 502、非 index.html HTML)。
- 若 `/system/stats` 返回 502:agender 未起来或未监听 8080——查 logs;返回 HTML/index.html:location 未生效或匹配顺序有误。

- [ ] **Step 6: 提交**

```bash
git add deploy/web-entrypoint.sh Dockerfile.web deploy/nginx.conf deploy/rust/agender
git commit -m "feat(deploy): run agender machine-info service in web image, proxy /system/stats

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

注:`deploy/rust/agender` 目前未被 git 跟踪(1.5MB 二进制)。一并提交,否则他机/CI 构建时构建上下文缺该文件会导致 `COPY` 失败。若团队约定二进制不入库,改为在构建前另行分发——本次默认入库。

---

## Self-Review

**Spec coverage:**
- 打入 web 镜像 → Step 2(COPY)。
- agender + nginx 同容器运行 → Step 1(entrypoint)+ Step 2(ENTRYPOINT)。
- nginx 代理 `/system/stats` → Step 3。
- amd64、无自动重启、公开可达 → 均按 spec 决策,无额外任务。
- 验证(build + run + curl)→ Step 4/5。
- 不改 compose、EXPOSE、HEALTHCHECK → Global Constraints + Step 2 明示保持不变。

**Placeholder scan:** 无 TBD/TODO;每个代码步骤含完整内容。

**Type/命名一致性:** 路径 `/usr/local/bin/agender`、`/usr/local/bin/web-entrypoint.sh`、端点 `/system/stats`、端口 8080 在各步骤中一致。
