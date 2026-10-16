# 媒体 Worker 的 Linux 安全策略

新机器从零安装请先读[新服务器首次部署指南](../../docs/marketing-video-new-server-deployment.md)；
下面也包含已有镜像的离线修复流程。

适用目标：Ubuntu 22.04、Docker Engine、非 root 媒体 Worker。本目录策略限制
amd64 / arm64；2026-10-16 已在 Ubuntu 22.04、内核 5.15.0-194-generic、
Docker 29.1.3、amd64 上完成验证。其他组合需重新验收，尤其 Ubuntu 24.04+
的 AppArmor userns 规则。

## 原因与权限边界

Docker 中再运行 bubblewrap 时，存在三层限制：

1. 默认 seccomp 限制 namespace 创建，出现 `No permissions to create new namespace`。
2. 默认 AppArmor 禁止 mount，出现 `Failed to make / slave: Permission denied`。
3. Docker 默认对部分 proc 路径设置的遮蔽/只读挂载，可能阻止子 user namespace
   再挂载 proc，出现 `Can't mount proc on /newroot/proc: Operation not permitted`。

此外，Debian 的 FFmpeg 动态库可能经 `/etc/alternatives` 链接到 BLAS/LAPACK；
沙箱仅挂载 `/usr`，会找不到动态库。本目录的 `fix-library-links.sh` 在构建时
将这些链接固定到 `/usr/lib` 下真实文件，不向沙箱暴露整个 `/etc`。
更新系统库后需要重新执行修复并运行预检。

安全策略由 Moby 官方快照（2026-10-16 获取）派生：

- [seccomp 基线](https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json)
- [AppArmor 基线](https://raw.githubusercontent.com/moby/profiles/main/apparmor/template.go)
- 许可证见 [LICENSE.moby](LICENSE.moby)。部署使用仓库内固定文件，不实时拉取 main。
  不保证与 Docker 29.1.3 内置策略逐字一致；升级 Docker / 内核后应复核。

`media-analysis-seccomp.json` 保留基线默认拒绝和原有规则，新增：
amd64 / arm64 的 clone 仅在包含 `CLONE_NEWUSER` 时允许；unshare 仅新增允许
`CLONE_NEWUSER`；允许 mount、umount2、pivot_root。保留 clone3 的 ENOSYS
回退，没有新增 setns、bpf 等放行规则。

`lot-agent-media-analysis.apparmor` 使用独立名称 `lot-agent-media-analysis-v2`，
允许 mount / pivot_root，保留基线 proc/sys、信号及 ptrace 等约束，并补充对
原 Docker 遮蔽/只读系统路径的访问拒绝。挂载规则是容器级允许；内核仍检查
user namespace 能力。必须同时保留 `user: node`、`cap_drop: [ALL]` 和
`no-new-privileges:true`，不要给外层进程添加 SYS_ADMIN 或 privileged。

`systempaths=unconfined` 仅取消该容器的 Docker 系统路径遮蔽/只读挂载，解决
嵌套 proc 挂载问题；seccomp 和 AppArmor 仍使用上述专用策略。AppArmor 的
访问拒绝与挂载遮蔽不完全等价，例如路径名称仍可能可见。不能单独启用此选项，
必须与 v2 AppArmor 配套，并通过敏感路径访问测试。
参考 [Docker systempaths 说明](https://docs.docker.com/reference/cli/docker/container/run/)。

应用的 bubblewrap 文件白名单、断网解码、下载出口代理与 SSRF 校验保留。
这些策略对容器默认权限有调整，不应推广到其他服务。

## 安装与验收

示例：代码 `/lot-agent/`，Compose 和 `.env` `/agent/`。先备份 Compose、安全
策略与旧镜像标识；不要把密钥、`.env` 内容写入部署日志。宿主机需要
`apparmor_parser`，并启用 AppArmor 服务。

```bash
install -d -m 0755 /agent/security
cp -a /lot-agent/deploy/security/. /agent/security/
apparmor_parser --skip-kernel-load --skip-cache /agent/security/lot-agent-media-analysis.apparmor
install -m 0644 /agent/security/lot-agent-media-analysis.apparmor /etc/apparmor.d/lot-agent-media-analysis-v2
apparmor_parser -r /etc/apparmor.d/lot-agent-media-analysis-v2
```

安装到 `/etc/apparmor.d/` 便于 AppArmor 服务开机加载，不覆盖 `docker-default`。
解析或加载失败时不切换业务服务。

完整构建使用仓库 `Dockerfile.media-analysis`，已包含动态库链接修复。若已有
完整应用镜像，可离线派生修复镜像，不重新安装系统包或下载 yt-dlp：

```bash
base_image=$(docker image inspect lot-agent-media-analysis:1.0 --format '{{.Id}}')
docker build --network=none \
  --build-arg "MEDIA_BASE_IMAGE=$base_image" \
  -f /agent/security/Dockerfile.runtime-fix \
  -t lot-agent-media-analysis:20261016-sandbox2 /agent/security
bash /agent/security/check-media-sandbox.sh \
  /agent/security/media-analysis-seccomp.json \
  lot-agent-media-analysis:20261016-sandbox2
```

镜像标签是本次部署示例；后续使用新标签，并保留上一次可回退的镜像。
脚本启动自动删除的测试容器，不传 `.env`、不挂业务卷、外层网络为 none。
验证外层敏感 proc 路径访问拒绝、内层文件/环境/PID/网络隔离、只读程序目录、
零有效 capability、no-new-privileges 和 seccomp，并在实际沙箱参数及 prlimit
下执行 yt-dlp 版本查询、FFmpeg 合成视频、FFprobe 读取。
测试不请求平台视频或调用付费模型，不替代出口代理、取消及真实平台兼容性验收。

预检全部 PASS 后，将下列字段合并进原有媒体服务，保留其他配置：

```yaml
services:
  media-analysis-worker:
    image: lot-agent-media-analysis:20261016-sandbox2
    user: node
    security_opt:
      - no-new-privileges:true
      - seccomp=/agent/security/media-analysis-seccomp.json
      - apparmor=lot-agent-media-analysis-v2
      - systempaths=unconfined
    cap_drop: [ALL]
```

seccomp 文件由 Docker 客户端读取；AppArmor 策略需加载到 Docker daemon
所在宿主机。禁止用 `seccomp=unconfined` 或 `apparmor=unconfined` 替代。

确认没有在途媒体分析任务后执行：

```bash
cd /agent
docker-compose config --quiet
docker-compose up -d --no-deps --force-recreate media-analysis-worker
docker-compose logs --tail=50 media-analysis-worker
```

仅 restart 不会更新容器安全策略。停止旧 Worker 可能影响在途任务；
`failed/DOWNLOAD_FAILED` 任务不会因换容器自动重放。用户可在原任务点击
“继续生成”后验证真实业务，可能产生模型费用。不要清空数据库、Redis 或调用账本。

## 验证与回退

2026-10-16 目标服务器已通过 AppArmor 解析/加载、上述完整预检，以及在
实际媒体 Worker 中运行同一组 Python 沙箱测试。API 健康检查为 200，
Nginx 配置检查通过，其他服务容器未重建。未调用付费模型、未重放失败任务。
详见 [本次部署记录](../../docs/marketing-video-server-deployment-20261016.md)。

回退时先检查在途任务，停止媒体 Worker，仅恢复其原 image 和 security_opt，
校验 Compose 后重建该服务。不要覆盖其他服务后续修改；不要删除业务卷，
也不要卸载仍被容器使用的 AppArmor profile。本机旧默认策略会再次阻止
bubblewrap，因此回退用于恢复原配置，不代表媒体功能恢复。
