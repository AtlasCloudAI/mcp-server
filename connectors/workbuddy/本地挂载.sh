#!/bin/bash
# 把本机构建的 MCP server 挂进 WorkBuddy 客户端做本地测试。
# 不发 npm、不传平台，只改你自己机器上的 WorkBuddy 配置，可一键还原。
#
#   挂载：  ./本地挂载.sh <你的 ATLASCLOUD_API_KEY>
#   还原：  ./本地挂载.sh --revert
set -euo pipefail

CFG="$HOME/.workbuddy/connectors/default/mcp.json"
BAK="$CFG.before-atlas-cloud"
DIST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/dist/index.js"
KEY_NAME="connector:atlas-cloud-local"

[ -f "$CFG" ] || { echo "找不到 $CFG —— WorkBuddy 没装或没启动过"; exit 1; }

if [ "${1:-}" = "--revert" ]; then
  [ -f "$BAK" ] || { echo "没有备份可还原"; exit 1; }
  mv "$BAK" "$CFG"; echo "✓ 已还原。重启 WorkBuddy 生效。"; exit 0
fi

KEY="${1:-}"
[ -n "$KEY" ] || { echo "用法: $0 <ATLASCLOUD_API_KEY>   （或 --revert）"; exit 1; }
[ -f "$DIST" ] || { echo "找不到 $DIST —— 先在仓库根目录跑 npm run build"; exit 1; }

[ -f "$BAK" ] || cp "$CFG" "$BAK"

CFG="$CFG" BAK="$BAK" DIST="$DIST" KEY="$KEY" KEY_NAME="$KEY_NAME" node <<'NODE'
const fs = require("node:fs");
const { CFG, DIST, KEY, KEY_NAME } = process.env;
const cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers[KEY_NAME] = {
  type: "stdio",
  command: "node",
  args: [DIST],
  env: { ATLASCLOUD_API_KEY: KEY },
  timeout: 30000,
};
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + "\n");
console.log(`✓ 已写入 ${KEY_NAME}`);
console.log(`  入口 ${DIST}`);
NODE

echo "  备份在 $BAK"
echo
echo "下一步：完全退出 WorkBuddy（cmd+Q，不是关窗口）再重开，然后在连接器面板里找它。"
echo "注意：API Key 以明文存在上面这个文件里，测完记得跑 --revert。"
