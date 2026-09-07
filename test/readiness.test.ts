import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { loadHttpServerConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { startAuthorizationServerProbe } from "../src/http/readiness.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";

class OkVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return {
      token,
      clientId: "c",
      scopes: ["tasks:read"],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      resource: new URL("http://127.0.0.1/mcp"),
      extra: { sub: "u" },
    } as AuthInfo;
  }
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    MCP_PUBLIC_URL: "http://127.0.0.1/mcp",
    MCP_OAUTH_ISSUER: "http://issuer.test",
    MCP_OAUTH_JWKS_URI: "http://issuer.test/jwks",
    MCP_OAUTH_ENDPOINT_HOSTS: "issuer.test",
    MCP_ALLOWED_HOSTS: "127.0.0.1",
    MCP_ALLOWED_ORIGINS: "https://chatgpt.com",
    ATLASCLOUD_API_KEY: "test-atlas-key",
    MCP_IDEMPOTENCY_BACKEND: "memory",
  };
}

async function harness(ready: boolean): Promise<{ baseUrl: string; server: Server }> {
  const config = loadHttpServerConfig(baseEnv());
  const app = createHttpApp(config, {
    verifier: new OkVerifier(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    credentialResolver: {
      async resolve() {
        return { subject: "u", apiKey: "k" };
      },
    },
    readiness: {
      ready: () => ready,
      lastError: () => (ready ? undefined : "metadata returned HTTP 401"),
      whenReady: () => Promise.resolve(),
      stop: () => {},
    },
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

test("授权服务器未就绪时，MCP 端点一律 503 而不是把令牌当坏的", async () => {
  const { baseUrl, server } = await harness(false);
  try {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    // 503 而不是 401：令牌没问题，是我们暂时无法验证它。客户端据此重试，
    // 而不是把凭据当成失效去重新授权。
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    const body = await res.json() as { error?: { message?: string } };
    assert.match(body.error?.message ?? "", /not yet validated/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("readyz 在授权服务器不通时返回 503，并说明原因", async () => {
  const { baseUrl, server } = await harness(false);
  try {
    const res = await fetch(`${baseUrl}/readyz`);
    assert.equal(res.status, 503);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.status, "not_ready");
    assert.equal(body.authorization_server, "unreachable");
    // 原因要能直接看出来，不然「一直 not_ready」得翻日志才知道是谁的问题
    assert.match(String(body.detail), /401/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("就绪之后 readyz 正常、MCP 端点放行", async () => {
  const { baseUrl, server } = await harness(true);
  try {
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.notEqual(res.status, 503);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("探针失败会持续重试，授权服务器恢复后自动转就绪（不需要重启进程）", async () => {
  const config = loadHttpServerConfig(baseEnv());
  const metadata = {
    issuer: "http://issuer.test",
    authorization_endpoint: "http://issuer.test/authorize",
    token_endpoint: "http://issuer.test/token",
    jwks_uri: "http://issuer.test/jwks",
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    registration_endpoint: "http://issuer.test/register",
    scopes_supported: [...config.scopesSupported, "openid", "email", "profile"],
    userinfo_endpoint: "http://issuer.test/userinfo",
  };
  let calls = 0;
  // 前两次像 backend 被换掉时那样返回 401，之后恢复正常
  const fetcher: typeof fetch = (async () => {
    calls += 1;
    // 一轮校验会打两个 discovery 路径，所以 4 次 401 才够两轮失败
    if (calls <= 4) return new Response("null", { status: 401 });
    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const failures: number[] = [];
  const probe = startAuthorizationServerProbe(config, {
    fetcher,
    initialDelayMs: 5,
    maxDelayMs: 10,
    onAttemptFailed: (_e, attempt) => failures.push(attempt),
  });
  try {
    await Promise.race([
      probe.whenReady(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("探针 3 秒内没有转为就绪")), 3_000)
      ),
    ]);
    assert.equal(probe.ready(), true);
    assert.equal(probe.lastError(), undefined, "就绪后要清掉上次错误");
    assert.ok(failures.length >= 2, `应跨两轮重试，实际失败 ${failures.length} 轮`);
    // 关键：原实现重试 12 次就 process.exit，这里必须是「一直等到恢复」
    assert.ok(calls >= 5, "恢复后应当自己重试成功，而不是放弃");
  } finally {
    probe.stop();
  }
});
