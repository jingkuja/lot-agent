# 把 agender 机器信息服务打进 web 镜像 — 设计文档

- 日期: 2026-07-01
- 状态: 已批准,待实现

## 目标

在 web 容器里,除 nginx 外常驻运行 `agender`(一个 Rust 编译的机器信息服务,监听
`127.0.0.1:8080`,提供 `GET /system/stats`)。nginx 把 `/system/stats` 反向代理到它,
使浏览器可通过同源的 web 端点访问机器信息。

## 前提与已确认的决策

- **架构: 仅 amd64/x86-64**。`deploy/rust/agender` 是一个静态链接的 x86-64 ELF 可执行文件,
  仓库内**没有 Rust 源码**(只有编译产物)。web 镜像在 amd64 构建机上构建、部署到 amd64 盒子,
  二进制可直接运行。
- **进程管理: entrypoint 脚本**。agender 后台启动,nginx 前台运行。不引入 supervisor/s6。
- **访问控制: 公开可达**。`/system/stats` 与 `/api/` 一样对外可达,先不加 allow/deny 或鉴权。

## 涉及改动的文件

### 1. `deploy/rust/agender`(现有,保持不动)

已有的 x86-64 静态二进制。构建时被 `COPY` 进 runtime 镜像。它位于 Docker 构建上下文内
(`.dockerignore` 未排除 `deploy/rust/`)。构建阶段会 `chmod +x`,不依赖宿主机上的权限位。

### 2. `deploy/web-entrypoint.sh`(新增)

```sh
#!/bin/sh
set -e
# 后台启动机器信息服务(仅容器内 127.0.0.1:8080,不对外 EXPOSE)
/usr/local/bin/agender &
# 前台交给 nginx 官方 entrypoint,保留基础镜像的模板/初始化行为
exec /docker-entrypoint.sh nginx -g 'daemon off;'
```

- 用 nginx 官方 `/docker-entrypoint.sh` 而非直接 `nginx`,以保留 `nginx:alpine` 基础镜像的
  初始化逻辑(如 `/etc/nginx/templates` 的 envsubst)。
- `exec` 让 nginx 成为容器的 PID 1 前台进程,信号能正确传递。
- agender 以后台子进程运行;**崩溃不会自动重启**(已确认接受此权衡)。

### 3. `Dockerfile.web`(runtime 阶段追加)

在 `FROM nginx:1.27-alpine AS runtime` 阶段,`COPY web/dist` 之后追加:

```dockerfile
COPY deploy/rust/agender /usr/local/bin/agender
COPY deploy/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh
RUN chmod +x /usr/local/bin/agender /usr/local/bin/web-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]
```

- `EXPOSE 80` 不变:8080 仅容器内使用,不对外暴露。
- `HEALTHCHECK` 不变:仍探测 nginx 的 `/healthz`,不覆盖 agender 存活。

### 4. `deploy/nginx.conf`(新增一个 location)

在 `server { ... }` 内、`location / {}`(SPA 兜底)之前,新增精确匹配:

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

- 用 `location =` 精确匹配,优先级高于 SPA 的 `location /` 兜底,避免被 `try_files` 吞成
  `index.html`。

## 数据流

```
浏览器  GET  http://<web>:80/system/stats
  → nginx (精确匹配 location = /system/stats)
  → proxy_pass http://127.0.0.1:8080/system/stats
  → agender (容器内后台进程)
  → 返回机器信息 JSON
```

其余路径(`/api/`、`/static/`、`/assets/`、SPA 兜底、`/healthz`)行为完全不变。

## 验证

1. 构建:`docker build -f Dockerfile.web -t lot-agent-web:test .` 成功,agender 与
   entrypoint 均被拷入且可执行。
2. 运行:`docker run --rm -p 8088:80 lot-agent-web:test`。
3. 断言:
   - `curl -fsS localhost:8088/system/stats` 返回机器信息(非 502/404/index.html)。
   - `curl -fsS localhost:8088/healthz` 仍返回 `ok`。
   - `docker logs` 中能看到 agender 已启动、nginx 正常监听。

## 风险与备注

- **仅 amd64**:若将来部署到 arm64 盒子(`deploy/ota/install-box.sh` 支持 aarch64),当前
  x86-64 二进制在容器内 `exec` 会失败。届时需要一份 arm64 的 agender(需源码/Cargo 工程重新
  交叉编译),再考虑多架构镜像。
- **无自动重启**:agender 崩溃后 `/system/stats` 会 502,直到容器重启。若日后需要更强韧性,
  可切换到 supervisor/s6,或将 agender 拆成独立 compose 服务。
- **无访问限制**:`/system/stats` 对外暴露机器信息。若需收敛,可在该 location 加 `allow/deny`
  网段或 basic auth——不属于本次范围。

## 明确不做(YAGNI)

- 不重新编译 agender、不引入 Rust 构建阶段(用现成二进制)。
- 不引入 supervisor/s6。
- 不加鉴权/限流。
- 不做多架构(multi-arch)镜像。
- 不改 docker-compose.yml(web 服务定义、端口映射均不变)。
