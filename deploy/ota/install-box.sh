#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Lot Agent 盒子首次安装（root 运行一次）。
# 放置 OTA 脚本、装依赖、装 frpc（如缺）、装并启用 systemd 单元、首次拉起栈。
# 幂等：可重复运行。
#
# 前置：
#   - 已装 Docker + docker compose（命令 `docker compose version` 可用）
#   - /opt/lot-agent 下已有 docker-compose.yml、.env（含密码与 APP_TAG/WEB_TAG）
#   - 已准备 /opt/lot-agent/box.env（由 box.env.example 复制并填好）
#   - 已准备 /opt/lot-agent/ota/frpc.toml（由模板复制并填好 serverAddr/token/remotePort）
# ─────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lot-agent}"
OTA_DIR="$APP_DIR/ota"
STATE_DIR="/var/lib/lot-ota"
FRP_VERSION="${FRP_VERSION:-0.61.1}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行：sudo bash $0" >&2; exit 1; }

echo "==> 1/7 检查 Docker"
command -v docker >/dev/null || { echo "未找到 docker，请先安装 Docker" >&2; exit 1; }
docker compose version >/dev/null || { echo "未找到 docker compose 插件" >&2; exit 1; }
systemctl enable --now docker

echo "==> 2/7 安装依赖 (jq curl)"
if   command -v apt-get >/dev/null; then apt-get update -y && apt-get install -y jq curl
elif command -v dnf     >/dev/null; then dnf install -y jq curl
elif command -v yum     >/dev/null; then yum install -y jq curl
else echo "请手动安装 jq 与 curl" >&2; fi

echo "==> 3/7 放置 OTA 脚本到 $OTA_DIR"
mkdir -p "$OTA_DIR" "$STATE_DIR" "$STATE_DIR/tmp"
# 若从仓库目录运行，把脚本同步到 OTA_DIR（已在原地则跳过）
if [ "$SELF_DIR" != "$OTA_DIR" ]; then
  cp -f "$SELF_DIR/update-run.sh" "$OTA_DIR/"
  [ -f "$OTA_DIR/frpc.toml" ] || cp -f "$SELF_DIR/frpc.toml" "$OTA_DIR/"
fi
chmod +x "$OTA_DIR/update-run.sh"

echo "==> 4/7 校验必备配置"
[ -f "$APP_DIR/docker-compose.yml" ] || { echo "缺 $APP_DIR/docker-compose.yml" >&2; exit 1; }
[ -f "$APP_DIR/.env" ]               || { echo "缺 $APP_DIR/.env" >&2; exit 1; }
[ -f "$APP_DIR/box.env" ]            || { echo "缺 $APP_DIR/box.env（由 box.env.example 复制填写）" >&2; exit 1; }
# tag 参数化 override 就位
[ -f "$APP_DIR/docker-compose.override.yml" ] || cp -f "$SELF_DIR/docker-compose.override.yml" "$APP_DIR/"
# .env 必须含 APP_TAG/WEB_TAG（updater 据此切版/回滚）
grep -qE '^APP_TAG=' "$APP_DIR/.env" || echo "APP_TAG=1.0" >> "$APP_DIR/.env"
grep -qE '^WEB_TAG=' "$APP_DIR/.env" || echo "WEB_TAG=1.0" >> "$APP_DIR/.env"

echo "==> 5/7 安装 frpc 二进制（如缺）"
if ! command -v frpc >/dev/null && [ ! -x /usr/local/bin/frpc ]; then
  arch="$(uname -m)"; case "$arch" in x86_64) a=amd64;; aarch64|arm64) a=arm64;; *) a="$arch";; esac
  url="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${a}.tar.gz"
  echo "    下载 $url"
  tmp="$(mktemp -d)"; curl -fSL "$url" -o "$tmp/frp.tgz"
  tar -xzf "$tmp/frp.tgz" -C "$tmp" --strip-components=1
  install -m0755 "$tmp/frpc" /usr/local/bin/frpc; rm -rf "$tmp"
fi
[ -f "$OTA_DIR/frpc.toml" ] || { echo "缺 $OTA_DIR/frpc.toml（由模板复制填写）" >&2; exit 1; }

echo "==> 6/7 安装并启用 systemd 单元"
install -m0644 "$SELF_DIR/systemd/frpc.service"          /etc/systemd/system/
install -m0644 "$SELF_DIR/systemd/lot-agent.service"     /etc/systemd/system/
install -m0644 "$SELF_DIR/systemd/lot-updater.service"   /etc/systemd/system/
install -m0644 "$SELF_DIR/systemd/lot-updater.timer"     /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now frpc.service
systemctl enable --now lot-agent.service     # 首次拉起整个栈
systemctl enable --now lot-updater.timer

echo "==> 7/7 完成。核对："
echo "    systemctl is-enabled docker frpc lot-agent lot-updater.timer"
systemctl is-enabled docker frpc lot-agent lot-updater.timer || true
docker compose --project-directory "$APP_DIR" ps || true
echo "OK. updater 将每 ~5min 轮询；午夜窗口自动更新；手动可服务端置 update_now 或 systemctl start lot-updater.service"
