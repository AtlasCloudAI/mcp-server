#!/bin/bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
HELPER="$SCRIPT_DIR/codex-oauth-app-server-login.sh"
MOCK_CODEX="$SCRIPT_DIR/test-fixtures/mock-codex-app-server.mjs"
TEST_ROOT=""

fail() {
  printf '%s\n' "FAIL: $1" >&2
  exit 1
}

cleanup() {
  [ -n "${TEST_ROOT:-}" ] || return 0
  [ -d "$TEST_ROOT" ] || return 0
  [ ! -L "$TEST_ROOT" ] || return 0

  local resolved_parent test_name
  resolved_parent="$(CDPATH= cd -- "$(dirname -- "$TEST_ROOT")" && pwd -P)" || return 1
  test_name="$(basename -- "$TEST_ROOT")" || return 1
  [ "$resolved_parent" = "${TMPDIR_RESOLVED:?}" ] || return 1
  case "$test_name" in
    atlascloud-oauth-helper-test.*) ;;
    *) return 1 ;;
  esac
  rm -rf -- "$TEST_ROOT"
}

trap cleanup EXIT HUP INT TERM

[ -x "$HELPER" ] || fail "helper is not executable: $HELPER"
[ -x "$MOCK_CODEX" ] || fail "mock Codex is not executable: $MOCK_CODEX"

TMPDIR_RAW="${TMPDIR:-/tmp}"
TMPDIR_RESOLVED="$(CDPATH= cd -- "$TMPDIR_RAW" && pwd -P)" || fail "cannot resolve temp directory"
umask 077
TEST_ROOT="$(mktemp -d "$TMPDIR_RESOLVED/atlascloud-oauth-helper-test.XXXXXX")" \
  || fail "cannot create test directory"
[ -d "$TEST_ROOT" ] && [ ! -L "$TEST_ROOT" ] || fail "invalid test directory"

run_case() {
  local name expected_status result_mode origin_mode listener_mode output_file status
  name="$1"
  expected_status="$2"
  result_mode="$3"
  origin_mode="$4"
  listener_mode="$5"
  output_file="$TEST_ROOT/$name.log"

  MOCK_OAUTH_RESULT="$result_mode" \
  MOCK_AUTH_ORIGIN="$origin_mode" \
  MOCK_LISTENER="$listener_mode" \
  ATLAS_OAUTH_TIMEOUT_SECONDS=5 \
  ATLAS_OAUTH_NO_OPEN=1 \
    "$HELPER" --codex-bin "$MOCK_CODEX" >"$output_file" 2>&1
  status=$?

  [ "$status" -eq "$expected_status" ] \
    || fail "$name returned $status; expected $expected_status"
  printf '%s\n' "PASS: $name"
}

run_case success 0 success staging present
grep -Fq 'OAuth 成功' "$TEST_ROOT/success.log" \
  || fail "success case did not report OAuth success"

run_case rejected 1 rejected staging present
grep -Fq 'OAuth 未完成' "$TEST_ROOT/rejected.log" \
  || fail "rejected case did not report failure"

run_case wrong-origin 1 success wrong present
grep -Fq '非 staging 的 OAuth 授权地址' "$TEST_ROOT/wrong-origin.log" \
  || fail "wrong-origin case was not blocked"

run_case missing-listener 1 success staging missing
grep -Fq '没有在 127.0.0.1' "$TEST_ROOT/missing-listener.log" \
  || fail "missing-listener case was not blocked"

printf '%s\n' 'All OAuth helper regression tests passed.'
