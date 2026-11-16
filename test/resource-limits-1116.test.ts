import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { loadHttpServerConfig } from "../src/config.js";
import { acquireBufferSlot, resetBufferSlotsForTest, withBufferSlot, BufferSlotsBusyError } from "../src/services/buffer-slots.js";
import { limitJsonRpcBatches, MAX_JSONRPC_BATCH } from "../src/http/middleware.js";
import { createTokenExchanger, MAX_CACHE_ENTRIES } from "../src/services/token-exchange.js";

// 11-16 review：整包进内存的上传同时只放几个，排不上的先等，等太久才放弃。
test("buffered uploads queue for a slot and give up after the wait", async () => {
  resetBufferSlotsForTest(1);
  const first = await acquireBufferSlot(1_000);
  assert.ok(first);
  let secondGranted = false;
  const second = acquireBufferSlot(1_000).then((release) => {
    secondGranted = Boolean(release);
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondGranted, false, "the second upload waits while the first holds the only slot");
  first();
  first(); // 重复释放不多还名额
  const releaseSecond = await second;
  assert.ok(releaseSecond);
  assert.equal(await acquireBufferSlot(30), undefined, "only one slot exists, so a third times out");
  releaseSecond();
  await assert.rejects(
    Promise.all([withBufferSlot(() => new Promise((r) => setTimeout(r, 100))), withBufferSlot(async () => 1, 20)]),
    BufferSlotsBusyError
  );
  resetBufferSlotsForTest();
});

function runBatchGuard(body: unknown): { status?: number; passed: boolean } {
  let status: number | undefined;
  let passed = false;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  limitJsonRpcBatches()({ body } as Request, res, () => {
    passed = true;
  });
  return { status, passed };
}

// 一个批量请求塞上千个 tools/call 会绕过按请求计数的限流。
test("JSON-RPC batches carry at most one tool call", () => {
  const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "atlas_list_models", arguments: {} } });
  assert.equal(runBatchGuard(call(1)).passed, true);
  assert.equal(runBatchGuard([call(1)]).passed, true);
  assert.equal(runBatchGuard([{ jsonrpc: "2.0", method: "notifications/initialized" }, call(2)]).passed, true);
  assert.deepEqual(runBatchGuard([call(1), call(2)]), { status: 400, passed: false });
  assert.deepEqual(
    runBatchGuard(Array.from({ length: MAX_JSONRPC_BATCH + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }))),
    { status: 400, passed: false }
  );
});

// 刷新令牌每次换新 jti，旧缓存键不会再被访问：缓存要有上限。
test("the token exchange cache stays bounded", async () => {
  const config = loadHttpServerConfig({
    NODE_ENV: "test",
    MCP_PUBLIC_URL: "https://mcp.test/mcp",
    MCP_OAUTH_ISSUER: "https://console.dev.atlascloud.ai",
    MCP_OAUTH_JWKS_URI: "https://console.dev.atlascloud.ai/api/v1/oidc/jwks",
    MCP_OAUTH_ENDPOINT_HOSTS: "console.dev.atlascloud.ai",
    MCP_ALLOWED_HOSTS: "mcp.test",
    MCP_ALLOWED_ORIGINS: "https://chatgpt.com",
    MCP_IDEMPOTENCY_BACKEND: "memory",
    MCP_CREDENTIAL_MODE: "oauth-exchange",
    MCP_TOKEN_EXCHANGE_URL: "https://console.dev.atlascloud.ai/api/v1/oidc/token",
    MCP_TOKEN_EXCHANGE_CLIENT_ID: "atlas-mcp-server-dev",
    MCP_TOKEN_EXCHANGE_CLIENT_SECRET: "s3cret-value",
    MCP_TOKEN_EXCHANGE_RESOURCE: "https://api.dev.atlascloud.ai",
    MCP_TOKEN_EXCHANGE_SCOPE: "tasks:read tasks:write",
  });
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ access_token: `t${calls}`, token_type: "Bearer", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const exchanger = createTokenExchanger(config.tokenExchange!, fetcher);
  for (let i = 0; i <= MAX_CACHE_ENTRIES; i += 1) await exchanger.exchange("subject-token", `user jti-${i}`);
  assert.equal(calls, MAX_CACHE_ENTRIES + 1);
  // 最新的还在缓存里；最早的那条被挤掉了，再来要重新换。
  await exchanger.exchange("subject-token", `user jti-${MAX_CACHE_ENTRIES}`);
  assert.equal(calls, MAX_CACHE_ENTRIES + 1);
  await exchanger.exchange("subject-token", "user jti-0");
  assert.equal(calls, MAX_CACHE_ENTRIES + 2);
});
