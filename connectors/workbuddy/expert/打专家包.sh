#!/bin/bash
# 把 expert/ 打成 WorkBuddy 开放平台「专家」可上传的 zip。
# skills/ 不在仓库里冗余存一份，打包时从 ../skills 复制进来，保持单一来源。
# 注意：白名单式打包 —— 上次连接器包用 `-x '*.md'` 排除，把所有 SKILL.md 一起排掉了，别再犯。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
NAME=$(python3 -c "import json;print(json.load(open('.codebuddy-plugin/plugin.json'))['name'])")
OUT="${1:-$PWD/../dist-expert}"
STAGE=$(mktemp -d)/"$NAME"
mkdir -p "$STAGE" "$OUT"

# 白名单：工程笔记.md / 自检.py / 打专家包.sh 刻意不进包
cp -R .codebuddy-plugin agents avatars README.md "$STAGE"/
mkdir -p "$STAGE/skills"
python3 -c "
import json,shutil,os
for rel in json.load(open('.codebuddy-plugin/plugin.json')).get('skills',[]):
    src=os.path.join('..',os.path.basename(os.path.dirname(rel)),os.path.basename(rel)) if False else os.path.join('../skills',os.path.basename(rel))
    shutil.copytree(src,os.path.join('$STAGE','skills',os.path.basename(rel)),dirs_exist_ok=True)
    print('  + skills/'+os.path.basename(rel))
"
find "$STAGE" -name '.DS_Store' -delete

python3 自检.py >/dev/null 2>&1 || { python3 自检.py; echo "  ✗ 自检未通过，已停止打包"; exit 1; }

rm -f "$OUT/$NAME.zip"
( cd "$(dirname "$STAGE")" && zip -qr "$OUT/$NAME.zip" "$NAME" -x '*/.DS_Store' )
rm -rf "$(dirname "$STAGE")"
echo "  ✓ $OUT/$NAME.zip  $(ls -lh "$OUT/$NAME.zip" | awk '{print $5}')"
echo "  包内 SKILL.md: $(unzip -l "$OUT/$NAME.zip" | grep -c 'SKILL.md') 个（应为 3）"
