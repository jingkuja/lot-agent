#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# 发布脚本 —— 在【构建机】运行（非盒子）。
# build → docker save → 算 sha256/size → 生成 manifest → 输出待上传产物。
#
# 用法：  bash deploy/ota/release.sh 1.2.0  [输出目录]
#
# 发布命门：先把所有 tar 制品上传到更新服务端，【最后】才让 /update/check
# 返回新 version（更新版本指针）。否则盒子会拉到「清单已变、文件未到」的半成品。
# ─────────────────────────────────────────────────────────────
set -euo pipefail

VER="${1:?用法: release.sh <version> [outdir]}"
OUT="${2:-dist/release/$VER}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHANNEL="${CHANNEL:-stable}"
ARTIFACT_BASE="${ARTIFACT_BASE:-https://update.example.com/artifacts}"

cd "$REPO_ROOT"
mkdir -p "$OUT"

echo "==> 1/4 构建镜像 $VER"
docker build -t "lot-agent-app:$VER" -f Dockerfile .
docker build -t "lot-agent-web:$VER" -f Dockerfile.web .

echo "==> 2/4 导出 tar.gz"
app_tar="lot-agent-app-$VER.tar.gz"
web_tar="lot-agent-web-$VER.tar.gz"
docker save "lot-agent-app:$VER" | gzip > "$OUT/$app_tar"
docker save "lot-agent-web:$VER" | gzip > "$OUT/$web_tar"

echo "==> 3/4 算 sha256 / size 并生成 manifest.json"
sha_of() { sha256sum "$1" | awk '{print $1}'; }
size_of() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }   # macOS / Linux 兼容

cat > "$OUT/manifest.json" <<JSON
{
  "version": "$VER",
  "channel": "$CHANNEL",
  "released_at": "$(date -u +%FT%TZ)",
  "mandatory": false,
  "update_now": false,
  "images": [
    { "name": "lot-agent-app", "tag": "$VER",
      "url": "$ARTIFACT_BASE/$app_tar",
      "sha256": "$(sha_of "$OUT/$app_tar")", "size": $(size_of "$OUT/$app_tar") },
    { "name": "lot-agent-web", "tag": "$VER",
      "url": "$ARTIFACT_BASE/$web_tar",
      "sha256": "$(sha_of "$OUT/$web_tar")", "size": $(size_of "$OUT/$web_tar") }
  ],
  "compose_url": null,
  "notes": "release $VER"
}
JSON

echo "==> 4/4 产物就绪于 $OUT："
ls -lh "$OUT"
cat <<EOF

下一步（顺序不可错）：
  1) 先上传 tar 制品：  $OUT/$app_tar  $OUT/$web_tar   → 更新服务端 artifacts/
  2) 校验可下载后，最后再发布 manifest.json（更新 /update/check 返回的 version）
  3) 手动立即更新某盒子：在服务端把该 box 的 update_now 置 true
EOF
