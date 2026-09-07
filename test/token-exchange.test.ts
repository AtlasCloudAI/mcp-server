import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { loadHttpServerConfig } from "../src/config.js";
import {
  ConfiguredCredentialResolver,
  CredentialResolutionError,
} from "../src/services/credential-resolver.js";
import { createTokenExchanger, TokenExchangeError } from "../src/services/token-exchange.js";

const AS_TOKEN_URL = "https://console.dev.atlascloud.ai/api/v1/oidc/token";
const TARGET = "https://api.dev.atlascloud.ai";

function exchangeConfig() {
  return loadHttpServerConfig({
    NODE_ENV: "test",
    MCP_PUBLIC_URL: "https://mcp.test/mcp",
    MCP_OAUTH_ISSUER: "https://console.dev.atlascloud.ai",
    MCP_OAUTH_JWKS_URI: "https://console.dev.atlascloud.ai/api/v1/oidc/jwks",
    MCP_OAUTH_ENDPOINT_HOSTS: "console.dev.atlascloud.ai",
    MCP_ALLOWED_HOSTS: "mcp.test",
    MCP_ALLOWED_ORIGINS: "https://chatgpt.com",
    MCP_IDEMPOTENCY_BACKEND: "memory",
    MCP_CREDENTIAL_MODE: "oauth-exchange",
    MCP_TOKEN_EXCHANGE_URL: AS_TOKEN_URL,
    MCP_TOKEN_EXCHANGE_CLIENT_ID: "atlas-mcp-server-dev",
    MCP_TOKEN_EXCHANGE_CLIENT_SECRET: "s3cret-value",
    MCP_TOKEN_EXCHANGE_RESOURCE: TARGET,
    MCP_TOKEN_EXCHANGE_SCOPE: "tasks:read tasks:write",
  });
}

function authInfo(token: string, extra: Record<string, unknown> = {}): AuthInfo {
  return {
    token,
    clientId: "https://chatgpt.com/oauth/codex/client.json",
    scopes: ["tasks:read"],
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    extra: { sub: "123456", grant_id: "jti-1", ...extra },
  } as AuthInfo;
}

function stubExchange(
  responses: Array<{ status?: number; body: Record<string, unknown> }>
): { fetch: typeof fetch; calls: Array<{ url: string; auth: string; body: URLSearchParams }> } {
  const calls: Array<{ url: string; auth: string; body: URLSearchParams }> = [];
  let i = 0;
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      auth: headers.get("authorization") ?? "",
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    const next = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: impl, calls };
}

test("交换成功后，凭据就是换来的令牌，用户不需要任何 API key", async () => {
  const config = exchangeConfig();
  const stub = stubExchange([
    { body: { access_token: "exchanged-token-1", token_type: "Bearer", expires_in: 900, scope: "tasks:read" } },
  ]);
  const resolver = new ConfiguredCredentialResolver(
    config,
    undefined,
    createTokenExchanger(config.tokenExchange!, stub.fetch)
  );

  const credential = await resolver.resolve(authInfo("subject-token-abc"));
  assert.equal(credential.apiKey, "exchanged-token-1");
  assert.equal(credential.subject, "123456");

  // 请求形状按 RFC 8693 与契约第 6 节
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].url, AS_TOKEN_URL);
  const body = stub.calls[0].body;
  assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(body.get("subject_token"), "subject-token-abc");
  assert.equal(body.get("subject_token_type"), "urn:ietf:params:oauth:token-type:access_token");
  assert.equal(body.get("resource"), TARGET);
  assert.equal(body.get("scope"), "tasks:read tasks:write");
  assert.equal(body.get("actor_token"), null, "契约明说不接受 actor_token");

  // 机密客户端用 client_secret_basic
  const expected = "Basic " + Buffer.from("atlas-mcp-server-dev:s3cret-value").toString("base64");
  assert.equal(stub.calls[0].auth, expected);
});

test("同一身份在有效期内只换一次，并发也只换一次", async () => {
  const config = exchangeConfig();
  const stub = stubExchange([
    { body: { access_token: "t1", expires_in: 900 } },
    { body: { access_token: "t2", expires_in: 900 } },
  ]);
  const resolver = new ConfiguredCredentialResolver(
    config,
    undefined,
    createTokenExchanger(config.tokenExchange!, stub.fetch)
  );

  const [a, b] = await Promise.all([
    resolver.resolve(authInfo("subject-token-abc")),
    resolver.resolve(authInfo("subject-token-abc")),
  ]);
  assert.equal(a.apiKey, "t1");
  assert.equal(b.apiKey, "t1");
  const third = await resolver.resolve(authInfo("subject-token-abc"));
  assert.equal(third.apiKey, "t1");
  assert.equal(stub.calls.length, 1, "缓存与并发去重都生效，令牌端点只被打了一次（限流 60 次/分钟）");
});

test("令牌快过期时重新交换", async () => {
  const config = exchangeConfig();
  const stub = stubExchange([
    { body: { access_token: "short-lived", expires_in: 30 } },
    { body: { access_token: "fresh", expires_in: 900 } },
  ]);
  // expires_in 30 秒 − 60 秒提前量 → 立刻算过期，下次调用应重新换
  const exchanger = createTokenExchanger(config.tokenExchange!, stub.fetch);
  const resolver = new ConfiguredCredentialResolver(config, undefined, exchanger);
  assert.equal((await resolver.resolve(authInfo("s"))).apiKey, "short-lived");
  assert.equal((await resolver.resolve(authInfo("s"))).apiKey, "fresh");
  assert.equal(stub.calls.length, 2);
});

test("invalid_scope 的报错要点出「两端词表没统一」", async () => {
  const config = exchangeConfig();
  const stub = stubExchange([{ status: 400, body: { error: "invalid_scope" } }]);
  const resolver = new ConfiguredCredentialResolver(
    config,
    undefined,
    createTokenExchanger(config.tokenExchange!, stub.fetch)
  );
  await assert.rejects(
    () => resolver.resolve(authInfo("s")),
    (error: unknown) => {
      assert.ok(error instanceof CredentialResolutionError);
      assert.match(error.message, /invalid_scope/);
      assert.match(error.message, /词表/);
      return true;
    }
  );
});

test("交换被拒时报错分类清楚，且失败不进缓存", async () => {
  const config = exchangeConfig();
  const stub = stubExchange([
    { status: 401, body: { error: "invalid_client" } },
    { body: { access_token: "after-fix", expires_in: 900 } },
  ]);
  const exchanger = createTokenExchanger(config.tokenExchange!, stub.fetch);
  await assert.rejects(() => exchanger.exchange("s", "k"), TokenExchangeError);
  // 上一次失败没有被缓存住，修好之后立刻能拿到令牌
  const ok = await exchanger.exchange("s", "k");
  assert.equal(ok.accessToken, "after-fix");
});

test("没有主体令牌时明确报错，不静默退回贴 key", async () => {
  const config = exchangeConfig();
  const stub = stubExchange([{ body: { access_token: "t", expires_in: 900 } }]);
  const resolver = new ConfiguredCredentialResolver(
    config,
    undefined,
    createTokenExchanger(config.tokenExchange!, stub.fetch)
  );
  const withoutToken = { ...authInfo("x"), token: "" } as AuthInfo;
  await assert.rejects(() => resolver.resolve(withoutToken), /not available for exchange/);
});

test("oauth-exchange 模式缺配置时，加载配置就报错", () => {
  const base = {
    NODE_ENV: "test",
    MCP_PUBLIC_URL: "https://mcp.test/mcp",
    MCP_OAUTH_ISSUER: "https://console.dev.atlascloud.ai",
    MCP_OAUTH_JWKS_URI: "https://console.dev.atlascloud.ai/api/v1/oidc/jwks",
    MCP_OAUTH_ENDPOINT_HOSTS: "console.dev.atlascloud.ai",
    MCP_ALLOWED_HOSTS: "mcp.test",
    MCP_ALLOWED_ORIGINS: "https://chatgpt.com",
    MCP_IDEMPOTENCY_BACKEND: "memory",
    MCP_CREDENTIAL_MODE: "oauth-exchange",
  };
  assert.throws(() => loadHttpServerConfig(base), /requires the MCP_TOKEN_EXCHANGE_/);
  assert.throws(
    () => loadHttpServerConfig({ ...base, MCP_TOKEN_EXCHANGE_URL: AS_TOKEN_URL }),
    /must be set together/
  );
});

test("上游 401 之后丢弃缓存，下一次重新交换（撤销授权能当场生效）", async () => {
  const config = exchangeConfig();
  const stub = stubExchange([
    { body: { access_token: "before-revoke", expires_in: 900 } },
    { body: { access_token: "after-reauth", expires_in: 900 } },
  ]);
  const exchanger = createTokenExchanger(config.tokenExchange!, stub.fetch);
  const resolver = new ConfiguredCredentialResolver(config, undefined, exchanger);

  const first = await resolver.resolve(authInfo("subject-token-abc"));
  assert.equal(first.apiKey, "before-revoke");
  // 不丢缓存的话，同一身份会一直拿到那枚已经被撤销的令牌直到它自然过期
  assert.equal((await resolver.resolve(authInfo("subject-token-abc"))).apiKey, "before-revoke");

  assert.equal(typeof first.onRejected, "function", "交换模式必须给出失效回调");
  first.onRejected!();

  const afterReject = await resolver.resolve(authInfo("subject-token-abc"));
  assert.equal(afterReject.apiKey, "after-reauth");
  assert.equal(stub.calls.length, 2, "只应在缓存被丢弃后多换一次");
});
