#!/bin/bash

set -u

EXPECTED_MCP_NAME="atlascloud-staging"
EXPECTED_MCP_URL="https://atlascloud-mcp.dev.atlascloud.ai/mcp"
EXPECTED_AUTH_BASE="https://atlascloud-auth.dev.atlascloud.ai"
READ_ONLY_SCOPES_JSON='["openid","email","profile","offline_access","atlas:models:read","atlas:predictions:read","atlas:billing:read"]'
DEFAULT_TIMEOUT_SECONDS=540

APP_SERVER_PID=""
INPUT_FD_OPEN=0
TASK_TEMP_DIR=""
TASK_TEMP_BASE=""

print_usage() {
  printf '%s\n' "用法：$0 [--codex-bin /absolute/path/to/codex]"
}

fail() {
  printf '\n❌ %s\n' "$1" >&2
  exit 1
}

process_is_running() {
  case "${APP_SERVER_PID:-}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$APP_SERVER_PID" 2>/dev/null
}

close_input_fd() {
  if [ "$INPUT_FD_OPEN" -eq 1 ]; then
    exec 3>&-
    INPUT_FD_OPEN=0
  fi
}

stop_app_server() {
  close_input_fd
  if process_is_running; then
    kill -TERM "$APP_SERVER_PID" 2>/dev/null || true
    wait "$APP_SERVER_PID" 2>/dev/null || true
  fi
}

remove_task_temp_dir() {
  [ -n "${TASK_TEMP_DIR:-}" ] || return 0
  [ -n "${TASK_TEMP_BASE:-}" ] || return 0
  [ -d "$TASK_TEMP_DIR" ] || return 0
  [ ! -L "$TASK_TEMP_DIR" ] || {
    printf '%s\n' "⚠️ 临时目录意外变成符号链接，未自动删除：$TASK_TEMP_DIR" >&2
    return 1
  }

  local resolved_parent temp_name
  resolved_parent="$(CDPATH= cd -- "$(dirname -- "$TASK_TEMP_DIR")" && pwd -P)" || return 1
  temp_name="$(basename -- "$TASK_TEMP_DIR")" || return 1
  [ "$resolved_parent" = "$TASK_TEMP_BASE" ] || {
    printf '%s\n' "⚠️ 临时目录超出预期边界，未自动删除：$TASK_TEMP_DIR" >&2
    return 1
  }
  case "$temp_name" in
    atlascloud-codex-oauth.*) ;;
    *)
      printf '%s\n' "⚠️ 临时目录名称不符合预期，未自动删除：$TASK_TEMP_DIR" >&2
      return 1
      ;;
  esac

  rm -rf -- "$TASK_TEMP_DIR" || {
    printf '%s\n' "⚠️ 无法删除临时 OAuth 日志，请手动处理：$TASK_TEMP_DIR" >&2
    return 1
  }
}

cleanup() {
  stop_app_server
  remove_task_temp_dir || true
}

on_signal() {
  printf '\n%s\n' "OAuth 已中止；当前浏览器授权页已经不能继续使用。" >&2
  exit 130
}

trap cleanup EXIT
trap on_signal INT HUP TERM

CODEX_BIN=""
case "$#" in
  0) ;;
  2)
    [ "$1" = "--codex-bin" ] || {
      print_usage >&2
      exit 2
    }
    CODEX_BIN="$2"
    ;;
  *)
    print_usage >&2
    exit 2
    ;;
esac

if [ -z "$CODEX_BIN" ]; then
  if command -v codex >/dev/null 2>&1; then
    CODEX_BIN="$(command -v codex)"
  else
    for candidate in \
      "/Applications/ChatGPT.app/Contents/Resources/codex" \
      "/Applications/Codex.app/Contents/Resources/codex"
    do
      if [ -x "$candidate" ]; then
        CODEX_BIN="$candidate"
        break
      fi
    done
  fi
fi

[ -n "$CODEX_BIN" ] || fail "未找到 Codex CLI。请先安装并打开 Codex 桌面端。"
[ -x "$CODEX_BIN" ] || fail "Codex CLI 不可执行：$CODEX_BIN"
[ -x /usr/sbin/lsof ] || fail "系统缺少 /usr/sbin/lsof，无法验证本机 OAuth 回调监听器。"
[ -x /usr/bin/open ] || fail "系统缺少 /usr/bin/open，无法打开 OAuth 授权页。"

OAUTH_TIMEOUT_SECONDS="${ATLAS_OAUTH_TIMEOUT_SECONDS:-$DEFAULT_TIMEOUT_SECONDS}"
case "$OAUTH_TIMEOUT_SECONDS" in
  ''|*[!0-9]*) fail "ATLAS_OAUTH_TIMEOUT_SECONDS 必须是 1 到 540 的整数。" ;;
esac
[ "$OAUTH_TIMEOUT_SECONDS" -ge 1 ] && [ "$OAUTH_TIMEOUT_SECONDS" -le 540 ] \
  || fail "OAuth 等待时间必须在 1 到 540 秒之间。"

NO_OPEN="${ATLAS_OAUTH_NO_OPEN:-0}"
case "$NO_OPEN" in
  0|1) ;;
  *) fail "ATLAS_OAUTH_NO_OPEN 只能是 0 或 1。" ;;
esac

if pgrep -f '[c]odex mcp login atlascloud-staging' >/dev/null 2>&1; then
  fail "检测到另一个 atlascloud-staging 登录进程。请先回到那个终端完成或中止，避免混用授权页。"
fi

TASK_TEMP_BASE_RAW="${TMPDIR:-/tmp}"
TASK_TEMP_BASE="$(CDPATH= cd -- "$TASK_TEMP_BASE_RAW" && pwd -P)" \
  || fail "无法解析临时目录：$TASK_TEMP_BASE_RAW"
umask 077
TASK_TEMP_DIR="$(mktemp -d "$TASK_TEMP_BASE/atlascloud-codex-oauth.XXXXXX")" \
  || fail "无法创建 OAuth 临时目录。"
[ -n "$TASK_TEMP_DIR" ] && [ -d "$TASK_TEMP_DIR" ] && [ ! -L "$TASK_TEMP_DIR" ] \
  || fail "OAuth 临时目录创建结果无效。"

INPUT_FIFO="$TASK_TEMP_DIR/app-server.stdin"
PROTOCOL_LOG="$TASK_TEMP_DIR/app-server.stdout.jsonl"
DIAGNOSTIC_LOG="$TASK_TEMP_DIR/app-server.stderr.log"
mkfifo "$INPUT_FIFO" || fail "无法创建 App Server 输入管道。"
: > "$PROTOCOL_LOG" || fail "无法创建 App Server 协议日志。"
: > "$DIAGNOSTIC_LOG" || fail "无法创建 App Server诊断日志。"

"$CODEX_BIN" app-server <"$INPUT_FIFO" >"$PROTOCOL_LOG" 2>"$DIAGNOSTIC_LOG" &
APP_SERVER_PID=$!
case "$APP_SERVER_PID" in
  ''|*[!0-9]*) fail "无法取得 Codex App Server 进程号。" ;;
esac

exec 3>"$INPUT_FIFO" || fail "无法连接 Codex App Server 输入管道。"
INPUT_FD_OPEN=1

send_json() {
  printf '%s\n' "$1" >&3 || fail "无法向 Codex App Server 发送请求。"
}

wait_for_text() {
  local needle max_seconds elapsed
  needle="$1"
  max_seconds="$2"
  elapsed=0
  while [ "$elapsed" -lt "$max_seconds" ]; do
    if grep -Fq "$needle" "$PROTOCOL_LOG"; then
      return 0
    fi
    if ! process_is_running; then
      return 2
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

printf '%s\n' "AtlasCloud Staging × Codex OAuth 修复版"
printf '%s\n' "- Codex：$CODEX_BIN"
printf '%s\n' "- 版本：$("$CODEX_BIN" --version 2>/dev/null || printf 'unknown')"
printf '%s\n' "- 环境：$EXPECTED_MCP_NAME"
printf '%s\n' "- 授权：只读，不含 atlas:generation:write"
printf '%s\n' "- 最长等待：${OAUTH_TIMEOUT_SECONDS} 秒"

send_json '{"method":"initialize","id":1,"params":{"clientInfo":{"name":"atlascloud_oauth_installer","title":"AtlasCloud OAuth Installer","version":"0.4.0"}}}'
if ! wait_for_text '"id":1' 30; then
  fail "Codex App Server 初始化超时或提前退出。请升级 Codex 后重试。"
fi
INIT_RESPONSE="$(grep -F '"id":1' "$PROTOCOL_LOG" | tail -n 1)"
case "$INIT_RESPONSE" in
  *'"error":'*) fail "Codex App Server 拒绝初始化。请升级 Codex 后重试。" ;;
esac

send_json '{"method":"initialized","params":{}}'
LOGIN_REQUEST="{\"method\":\"mcpServer/oauth/login\",\"id\":2,\"params\":{\"name\":\"$EXPECTED_MCP_NAME\",\"clientRegistration\":\"dcr\",\"scopes\":$READ_ONLY_SCOPES_JSON,\"timeoutSecs\":$OAUTH_TIMEOUT_SECONDS}}"
send_json "$LOGIN_REQUEST"

if ! wait_for_text '"id":2' 45; then
  fail "Codex 没有返回 OAuth 授权地址。请检查网络或升级 Codex。"
fi
AUTH_RESPONSE="$(grep -F '"id":2' "$PROTOCOL_LOG" | tail -n 1)"
case "$AUTH_RESPONSE" in
  *'"error":'*) fail "当前 Codex 不支持可延长的 MCP OAuth 登录，请升级 Codex 后重试。" ;;
esac

AUTH_URL="$(printf '%s\n' "$AUTH_RESPONSE" | sed -n 's/.*"authorizationUrl":"\([^"]*\)".*/\1/p')"
[ -n "$AUTH_URL" ] || fail "Codex 返回的 OAuth 授权地址无法解析。"
case "$AUTH_URL" in
  *'\\'*) fail "Codex 返回的 OAuth 授权地址包含不支持的转义。" ;;
  "$EXPECTED_AUTH_BASE"/auth\?*) ;;
  *) fail "Codex 返回了非 staging 的 OAuth 授权地址，已阻止打开。" ;;
esac
case "$AUTH_URL" in
  *'atlas%3Ageneration%3Awrite'*) fail "OAuth 地址意外包含 generation 写权限，已阻止打开。" ;;
esac
case "$AUTH_URL" in
  *'resource=https%3A%2F%2Fatlascloud-mcp.dev.atlascloud.ai%2Fmcp'*) ;;
  *) fail "OAuth 地址没有绑定预期的 staging MCP resource，已阻止打开。" ;;
esac

CALLBACK_PORT="$(printf '%s\n' "$AUTH_URL" | sed -n 's/.*redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\([0-9][0-9]*\)%2Fcallback%2F.*/\1/p')"
case "$CALLBACK_PORT" in
  ''|*[!0-9]*) fail "OAuth 地址没有有效的 127.0.0.1 loopback 回调端口。" ;;
esac
[ "$CALLBACK_PORT" -ge 1 ] && [ "$CALLBACK_PORT" -le 65535 ] \
  || fail "OAuth loopback 回调端口超出有效范围。"

LISTENER_READY=0
LISTENER_WAITED=0
while [ "$LISTENER_WAITED" -lt 10 ]; do
  if /usr/sbin/lsof -nP -a -p "$APP_SERVER_PID" -iTCP:"$CALLBACK_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    LISTENER_READY=1
    break
  fi
  process_is_running || break
  sleep 1
  LISTENER_WAITED=$((LISTENER_WAITED + 1))
done
[ "$LISTENER_READY" -eq 1 ] \
  || fail "Codex 没有在 127.0.0.1:${CALLBACK_PORT} 启动回调监听器，已阻止打开无效授权页。"

printf '\n%s\n' "✅ 本机回调监听器已就绪：127.0.0.1:${CALLBACK_PORT}"
printf '%s\n' "即将打开一个全新的授权页。只使用最新标签，并且只点一次 Allow。"
printf '%s\n' "请保持本终端窗口打开，直到这里显示 OAuth 成功。"

if [ "$NO_OPEN" -eq 1 ]; then
  printf '%s\n' "测试模式：已跳过打开浏览器。"
else
  /usr/bin/open "$AUTH_URL" || {
    printf '%s\n' "浏览器没有自动打开，请立即复制下面的新链接；不要使用旧标签：" >&2
    printf '%s\n' "$AUTH_URL" >&2
  }
fi

COMPLETION_WAIT_SECONDS=$((OAUTH_TIMEOUT_SECONDS + 30))
if ! wait_for_text '"method":"mcpServer/oauthLogin/completed"' "$COMPLETION_WAIT_SECONDS"; then
  fail "没有收到 OAuth 完成通知。当前授权页已失效，请重新运行本脚本生成新会话。"
fi

COMPLETION_RESPONSE="$(grep -F '"method":"mcpServer/oauthLogin/completed"' "$PROTOCOL_LOG" | tail -n 1)"
case "$COMPLETION_RESPONSE" in
  *'"name":"atlascloud-staging"'*'"success":true'*)
    printf '\n%s\n' "✅ OAuth 成功：Codex 已收到 loopback 回调、完成 code exchange 并保存 token。"
    ;;
  *'"name":"atlascloud-staging"'*)
    fail "OAuth 未完成。当前授权页已经失效，请重新运行本脚本，并只点新页一次 Allow。"
    ;;
  *)
    fail "收到的 OAuth 完成通知不属于 atlascloud-staging。"
    ;;
esac

printf '%s\n' "现在可以完全退出并重开 Codex，再进行只读零费用测试。"
