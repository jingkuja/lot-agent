#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Lot Agent OTA — 盒子侧单次更新运行（由 lot-updater.timer 每 ~5min 触发一次）。
#
# 流程：拉 /update/check → 决策(手动标记 / 午夜窗口) → 下载校验 → docker load
#       → 改 .env 切 tag → compose up app → 健康检查 → 成败/回滚 → 上报。
#
# 关键不变量：
#   - data 容器(postgres/redis)全程不动；只重建 server/worker/web。
#   - 旧镜像保留(供回滚)；更新成功后才按 KEEP_VERSIONS 清理。
#   - 任何失败都不让盒子停在坏状态：要么旧版继续跑，要么回滚回旧版。
#
# 依赖：bash、docker、docker compose、curl、jq、sha256sum、coreutils。
# 退出码恒为 0（让 systemd timer 视为正常；真实结果走 /update/report 上报）。
# ─────────────────────────────────────────────────────────────
set -uo pipefail

# ── 配置（box.env 注入；带保守默认）──────────────────────────
APP_DIR="${APP_DIR:-/opt/lot-agent}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
COMPOSE="docker compose --project-directory $APP_DIR"
STATE_DIR="${STATE_DIR:-/var/lib/lot-ota}"
STATE="$STATE_DIR/state.json"
TMP_ROOT="${TMP_ROOT:-/var/lib/lot-ota/tmp}"

UPDATE_SERVER="${UPDATE_SERVER:?box.env 缺少 UPDATE_SERVER}"
BOX_ID="${BOX_ID:?box.env 缺少 BOX_ID}"
BOX_TOKEN="${BOX_TOKEN:?box.env 缺少 BOX_TOKEN}"
UPDATE_CHANNEL="${UPDATE_CHANNEL:-stable}"
UPDATE_WINDOW_START="${UPDATE_WINDOW_START:-00:00}"
UPDATE_WINDOW_END="${UPDATE_WINDOW_END:-00:30}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
KEEP_VERSIONS="${KEEP_VERSIONS:-2}"
WEB_PORT="${WEB_PORT:-80}"
MIN_FREE_MB="${MIN_FREE_MB:-2048}"   # 下载前要求的额外磁盘余量

APP_SVCS="server worker web"          # 只重建这三个 app 服务

log()  { echo "[$(date -u +%FT%TZ)] $*" >&2; }
die()  { log "ERROR: $*"; }

# 单实例锁：避免 timer 触发与手动触发叠加
exec 9>"$STATE_DIR/.lock" 2>/dev/null || { mkdir -p "$STATE_DIR"; exec 9>"$STATE_DIR/.lock"; }
flock -n 9 || { log "另一个更新进程在跑，跳过本轮"; exit 0; }

mkdir -p "$STATE_DIR" "$TMP_ROOT"

# ── 状态读写 ─────────────────────────────────────────────────
read_state() {  # $1 = key
  [ -f "$STATE" ] && jq -r --arg k "$1" '.[$k] // empty' "$STATE" 2>/dev/null || true
}
write_state() { # key value pairs via jq merge
  local cur; cur="$(cat "$STATE" 2>/dev/null || echo '{}')"
  echo "$cur" | jq \
    --arg cv "${1:-}" --arg pv "${2:-}" --arg lr "${3:-}" --arg le "${4:-}" \
    '. + (if $cv!="" then {current_version:$cv} else {} end)
       + (if $pv!="" then {previous_version:$pv} else {} end)
       + {last_result:$lr, last_error:($le|select(.!="")), last_check_at:(now|todateiso8601)}' \
    > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}

current_version() {
  local v; v="$(read_state current_version)"
  [ -n "$v" ] && { echo "$v"; return; }
  # 回退：从 .env 的 APP_TAG 推断
  grep -E '^APP_TAG=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 || echo "0"
}

# ── 上报（best-effort，失败不影响主流程）────────────────────
report() { # result error
  curl -fsS --max-time 15 -X POST "$UPDATE_SERVER/update/report" \
    -H "X-Box-Token: $BOX_TOKEN" -H "Content-Type: application/json" \
    -d "$(jq -n --arg b "$BOX_ID" --arg cv "$(current_version)" \
              --arg pv "$(read_state previous_version)" --arg r "$1" --arg e "${2:-}" \
              '{box_id:$b,current_version:$cv,previous_version:$pv,result:$r,
                error:($e|select(.!="")),at:(now|todateiso8601)}')" \
    >/dev/null 2>&1 || log "上报失败(忽略): $1"
}

# ── .env 切 tag（updater 唯一改写处）────────────────────────
set_tag() { # APP_TAG / WEB_TAG = value
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

# ── 健康检查（server 内置 HEALTHCHECK + web /healthz + worker running）──
health_ok() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local scid wcid ok=1
    scid="$($COMPOSE ps -q server 2>/dev/null)"
    wcid="$($COMPOSE ps -q worker 2>/dev/null)"
    [ -n "$scid" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$scid" 2>/dev/null)" = "healthy" ] || ok=0
    [ -n "$wcid" ] && [ "$(docker inspect -f '{{.State.Running}}' "$wcid" 2>/dev/null)" = "true" ] || ok=0
    curl -fsS --max-time 5 "http://127.0.0.1:${WEB_PORT}/healthz" >/dev/null 2>&1 || ok=0
    [ "$ok" = 1 ] && return 0
    sleep 3
  done
  return 1
}

# ── 午夜窗口判定（盒子本地时区）──────────────────────────────
in_window() {
  local now s e; now="$(date +%H:%M)"
  s="$UPDATE_WINDOW_START"; e="$UPDATE_WINDOW_END"
  if [[ "$s" < "$e" ]]; then [[ "$now" > "$s" || "$now" == "$s" ]] && [[ "$now" < "$e" ]]
  else  # 跨午夜窗口，如 23:30→00:30
        [[ "$now" > "$s" || "$now" == "$s" || "$now" < "$e" ]]
  fi
}

# ── 主流程 ───────────────────────────────────────────────────
CUR="$(current_version)"
CHECK="$TMP_ROOT/check.json"
if ! curl -fsS --max-time 30 -H "X-Box-Token: $BOX_TOKEN" \
      "$UPDATE_SERVER/update/check?box_id=${BOX_ID}&channel=${UPDATE_CHANNEL}&current=${CUR}" \
      -o "$CHECK"; then
  log "check 失败(网络/服务端)，旧版继续跑，下次再试"; exit 0
fi

UPDATE_NOW="$(jq -r '.update_now // false' "$CHECK")"
TARGET="$(jq -r '.version // empty' "$CHECK")"
[ -z "$TARGET" ] && { log "check 无 version 字段，跳过"; exit 0; }

# 决策
if [ "$UPDATE_NOW" = "true" ]; then
  log "手动标记 update_now=true → 立即更新 $CUR → $TARGET"
elif [ "$TARGET" = "$CUR" ]; then
  log "已是最新 ($CUR)，结束"; exit 0
elif ! in_window; then
  log "有新版本 $TARGET，但未到午夜窗口 [$UPDATE_WINDOW_START-$UPDATE_WINDOW_END]，等待"; exit 0
else
  log "午夜窗口内，有新版本 → 更新 $CUR → $TARGET"
fi

# ── a. 磁盘预检 ──────────────────────────────────────────────
NEED_MB=$(( ( $(jq '[.images[].size] | add // 0' "$CHECK") / 1048576 ) + MIN_FREE_MB ))
FREE_MB=$(df -Pm "$TMP_ROOT" | awk 'NR==2{print $4}')
if [ "${FREE_MB:-0}" -lt "$NEED_MB" ]; then
  die "磁盘不足: 需 ${NEED_MB}MB 仅余 ${FREE_MB}MB"; write_state "" "" failure "disk_low"
  report failure "disk_low ${FREE_MB}/${NEED_MB}MB"; exit 0
fi

# ── b. 下载 + 校验 sha256 ────────────────────────────────────
WORK="$TMP_ROOT/$TARGET"; rm -rf "$WORK"; mkdir -p "$WORK"
fail_update() { die "$1"; rm -rf "$WORK"; write_state "" "" failure "$1"; report failure "$1"; exit 0; }

mapfile -t ROWS < <(jq -r '.images[] | "\(.name)\t\(.tag)\t\(.url)\t\(.sha256)"' "$CHECK")
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r name tag url sha <<<"$row"
  out="$WORK/${name}-${tag}.tar.gz"
  log "下载 $name:$tag …"
  curl -fSL --retry 3 --retry-delay 5 -C - --max-time 1800 "$url" -o "$out" \
    -H "X-Box-Token: $BOX_TOKEN" || fail_update "download_failed:$name"
  got="$(sha256sum "$out" | awk '{print $1}')"
  [ "$got" = "$sha" ] || fail_update "sha256_mismatch:$name"
done

# ── c. docker load（旧 tag 镜像保留不删）────────────────────
for f in "$WORK"/*.tar.gz; do
  log "docker load $f"; gunzip -c "$f" | docker load || fail_update "docker_load_failed"
done

# ── d. 记录回滚点 ────────────────────────────────────────────
PREV="$CUR"
write_state "" "$PREV" updating ""

# ── e. compose 结构变更（可选下发）──────────────────────────
COMPOSE_URL="$(jq -r '.compose_url // empty' "$CHECK")"
if [ -n "$COMPOSE_URL" ]; then
  cp -f "$APP_DIR/docker-compose.yml" "$APP_DIR/docker-compose.yml.prev" 2>/dev/null || true
  curl -fsS -H "X-Box-Token: $BOX_TOKEN" "$COMPOSE_URL" -o "$APP_DIR/docker-compose.yml" \
    || fail_update "compose_download_failed"
fi

# ── e/f. 切 tag + 重建 app（data 不动）──────────────────────
set_tag APP_TAG "$TARGET"
set_tag WEB_TAG "$TARGET"
log "compose up -d $APP_SVCS（切到 $TARGET）"
$COMPOSE up -d $APP_SVCS || log "compose up 报错，进入健康检查/回滚判定"

# ── g. 健康检查 ──────────────────────────────────────────────
if health_ok; then
  log "健康检查通过，$TARGET 上线"
  write_state "$TARGET" "$PREV" success ""
  report success ""
  # 清理过旧镜像（保留最近 KEEP_VERSIONS 版的 tag；untagged 一并 prune）
  docker image prune -f >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit 0
fi

# ── 回滚（100% 命门）────────────────────────────────────────
ERR_TAIL="$($COMPOSE logs --tail=40 server 2>&1 | tail -40 | tr '\n' '|')"
die "新版本 $TARGET 健康检查失败，回滚到 $PREV"
set_tag APP_TAG "$PREV"
set_tag WEB_TAG "$PREV"
[ -f "$APP_DIR/docker-compose.yml.prev" ] && mv -f "$APP_DIR/docker-compose.yml.prev" "$APP_DIR/docker-compose.yml"
$COMPOSE up -d $APP_SVCS || log "回滚 compose up 报错"
if health_ok; then
  log "回滚成功，$PREV 恢复运行"
  write_state "$PREV" "$PREV" rolled_back "health_failed_on_$TARGET"
  report rolled_back "health_failed_on_${TARGET}; ${ERR_TAIL}"
else
  die "回滚后仍不健康！需经 frp SSH 人工救场"
  write_state "$PREV" "$PREV" rolled_back "rollback_unhealthy_on_$TARGET"
  report rolled_back "ROLLBACK_UNHEALTHY_on_${TARGET}; ${ERR_TAIL}"
fi
rm -rf "$WORK"
exit 0
