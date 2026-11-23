// 2026-11-22/23 生产巡检：卡片调用被限流、连续 HTTP 400，埋点只有状态码，日志里什么都没有，
// 看不出是哪份额度、什么原因、同一份报价被几张卡问了几次。这里验证补上的观测字段和日志。
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import test from "node:test";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { loadHttpServerConfig, REMOTE_SCOPES } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import type { AnalyticsEvent, AnalyticsSink } from "../src/http/tool-call-analytics.js";
import { rejectionReason } from "../src/http/rejections.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { quoteHash } from "../src/services/tool-call-telemetry.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "3000",
  MCP_PUBLIC_URL: "http://127.0.0.1/mcp",
  MCP_OAUTH_ISSUER: "http://issuer.test",
  MCP_OAUTH_JWKS_URI: "http://issuer.test/jwks",
  MCP_OAUTH_ALGORITHMS: "RS256",
  MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
  MCP_ALLOWED_ORIGINS: "https://chatgpt.com",
  ATLASCLOUD_API_KEY: "test-atlas-key",
  MCP_IDEMPOTENCY_BACKEND: "memory",
  POSTHOG_KEY: "phc_test",
};

const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";

// 令牌就是 sub（数字用户 ID），客户端固定是 Claude 网页版。
class Verifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return {
      token,
      clientId: CLAUDE,
      scopes: [...REMOTE_SCOPES],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      resource: new URL("http://127.0.0.1/mcp"),
      extra: { sub: token },
    };
  }
}

async function harness(overrides: NodeJS.ProcessEnv = {}) {
  const captured: AnalyticsEvent[] = [];
  const sink: AnalyticsSink = { capture: (e) => captured.push(e), shutdown: async () => {} };
  const app = createHttpApp(loadHttpServerConfig({ ...BASE_ENV, ...overrides }), {
    verifier: new Verifier(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    credentialResolver: {
      async resolve(auth) {
        return { subject: String(auth.extra?.sub), apiKey: "test-atlas-key" };
      },
    },
    analytics: sink,
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (sub: string, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sub}`,
        Accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
  const events = async (count: number): Promise<AnalyticsEvent[]> => {
    for (let i = 0; i < 100 && captured.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return captured;
  };
  return {
    call,
    events,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function withConsoleWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => (console.warn = original) };
}

test("拒绝原因按本服务的错误码和 SDK 的报错文字归类", () => {
  assert.equal(rejectionReason('{"error":"rate_limit_exceeded"}'), "rate_limited");
  assert.equal(rejectionReason('{"error":"tool_not_available"}'), "tool_not_available");
  assert.equal(rejectionReason('{"error":"insufficient_scope"}'), "insufficient_scope");
  assert.equal(
    rejectionReason('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Unsupported protocol version: 2099-01-01 (supported versions: ...)"}}'),
    "unsupported_protocol_version"
  );
  assert.equal(rejectionReason('{"error":{"message":"Not Acceptable: Client must accept both application/json and text/event-stream"}}'), "not_acceptable");
  assert.equal(rejectionReason('{"error":{"message":"Unsupported Media Type: Content-Type must be application/json"}}'), "unsupported_media_type");
  assert.equal(rejectionReason('{"error":{"message":"Parse error: Invalid JSON-RPC message"}}'), "invalid_jsonrpc");
  assert.equal(rejectionReason('{"error":{"message":"Parse error: Invalid JSON"}}'), "parse_error");
  assert.equal(rejectionReason('{"error":{"message":"Batch requests may carry at most 10 messages"}}'), "batch_limit");
  assert.equal(rejectionReason("something else"), "other");
});

test("quote_hash 是 16 位十六进制，不带原始幂等键", () => {
  const hash = quoteHash("7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11");
  assert.match(String(hash), /^[0-9a-f]{16}$/);
  assert.equal(quoteHash("7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11"), hash, "同一个键同一个值");
  assert.equal(quoteHash(""), undefined);
  assert.equal(quoteHash(undefined), undefined);
});

test("协议版本不支持：埋点记原因和版本，服务端打一行日志（不带用户 ID）", async (t) => {
  const warn = withConsoleWarn();
  const h = await harness();
  t.after(async () => {
    warn.restore();
    await h.close();
  });
  const response = await h.call("42", "atlas_get_balance", {}, { "mcp-protocol-version": "2099-01-01" });
  assert.equal(response.status, 400);
  const [event] = await h.events(1);
  assert.equal(event?.properties.http_status, 400);
  assert.equal(event?.properties.rejection_reason, "unsupported_protocol_version");
  assert.equal(event?.properties.protocol_version, "2099-01-01");
  assert.equal(event?.properties.tool_surface, "full");
  const line = warn.lines.find((l) => l.startsWith("[mcp-rejected]"));
  assert.ok(line, "打了一行拒绝日志");
  assert.match(line!, /status=400 reason=unsupported_protocol_version method=tools\/call tool=atlas_get_balance platform=claude protocol=2099-01-01/);
  assert.equal(line!.includes("42"), false, "日志里没有用户 ID");
});

test("限流：埋点和日志分得清是卡片额度还是总额度", async (t) => {
  const warn = withConsoleWarn();
  const h = await harness({ MCP_SUBJECT_REQUESTS_PER_MINUTE: "1", MCP_CARD_REQUESTS_PER_MINUTE: "1" });
  t.after(async () => {
    warn.restore();
    await h.close();
  });
  await h.call("7", "atlas_card_status", { prediction_id: "p-1" });
  const cardLimited = await h.call("7", "atlas_card_status", { prediction_id: "p-1" });
  assert.equal(cardLimited.status, 429);
  await h.call("7", "atlas_get_balance", {});
  const subjectLimited = await h.call("7", "atlas_get_balance", {});
  assert.equal(subjectLimited.status, 429);

  const events = await h.events(4);
  const limited = events.filter((e) => e.properties.http_status === 429);
  assert.deepEqual(
    limited.map((e) => [e.properties.command, e.properties.rejection_reason, e.properties.rate_limit_bucket]),
    [
      ["atlas_card_status", "rate_limited", "card"],
      ["atlas_get_balance", "rate_limited", "subject"],
    ]
  );
  const lines = warn.lines.filter((l) => l.startsWith("[mcp-rejected]"));
  assert.ok(lines.some((l) => /status=429 reason=rate_limited bucket=card .*tool=atlas_card_status/.test(l)));
  assert.ok(lines.some((l) => /status=429 reason=rate_limited bucket=subject .*tool=atlas_get_balance/.test(l)));
});

test("卡片查「提交过没有」：埋点带报价哈希、是不是加载时问的、结论", async (t) => {
  // 卡片开关读的是进程环境变量（generationCardEnabled），不是 HTTP 配置。
  const savedCards = process.env.MCP_UI_CARDS;
  process.env.MCP_UI_CARDS = "1";
  const h = await harness();
  t.after(async () => {
    await h.close();
    if (savedCards === undefined) delete process.env.MCP_UI_CARDS;
    else process.env.MCP_UI_CARDS = savedCards;
  });
  const key = "7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11";
  const response = await h.call("9", "atlas_card_check_submission", {
    tool: "atlas_generate_image",
    idempotency_key: key,
    on_load: true,
  });
  assert.equal(response.status, 200);
  const [event] = await h.events(1);
  assert.equal(event?.properties.command, "atlas_card_check_submission");
  assert.equal(event?.properties.quote_hash, quoteHash(key));
  assert.equal(event?.properties.check_on_load, true);
  assert.equal(typeof event?.properties.check_outcome, "string");
  assert.equal(JSON.stringify(event).includes(key), false, "不带原始幂等键");
  assert.equal("rejection_reason" in (event?.properties ?? {}), false, "没被拒的调用不带拒绝原因");
});
