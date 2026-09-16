#!/bin/bash
# 把 skills/ 下每个技能单独打成 zip，供 WorkBuddy 市场「添加技能」上传。
# 连接器包里的 skills/ 会随连接器一起装，这些 zip 是独立走技能市场的那条路。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/skills"
OUT="${1:-$PWD/../dist-skills}"
mkdir -p "$OUT"; rm -f "$OUT"/*.zip
for d in */; do
  n="${d%/}"
  zip -qr "$OUT/$n.zip" "$n" -x '.*' -x '*/.*'
  echo "  ✓ $n.zip  $(ls -lh "$OUT/$n.zip" | awk '{print $5}')"
done
echo "  输出目录: $OUT"
