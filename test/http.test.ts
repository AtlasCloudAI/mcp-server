import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { REMOTE_SCOPES, loadHttpServerConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { isExactAllowedHost } from "../src/http/host-validation.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { REMOTE_TOOL_NAMES, TOOL_POLICIES } from "../src/tool-policy.js";

class StubVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token === "invalid") throw new InvalidTokenError("invalid test token");
    const scopes = token === "models" ? ["atlas:models:read"] : [...REMOTE_SCOPES];
    return {
      token,
      clientId: "chatgpt-test-client",
      scopes,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      resource: new URL("http://127.0.0.1/mcp"),
      extra: { sub: "test-user" },
    };
  }
}

async function startHarness(
  overrides: NodeJS.ProcessEnv = {}
): Promise<{ baseUrl: string; server: Server }> {
  const config = loadHttpServerConfig({
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
    OPENAI_APPS_CHALLENGE_TOKEN: "exact-challenge-token",
    ...overrides,
  });
  const app = createHttpApp(config, {
    verifier: new StubVerifier(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    credentialResolver: {
      async resolve() {
        return { subject: "test-user", apiKey: "test-atlas-key" };
      },
    },
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function rpcBody(method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
}

test("production Host validation accepts only the exact HTTPS authority", () => {
  const allowed = ["atlascloud-mcp.dev.atlascloud.ai"];
  assert.equal(
    isExactAllowedHost("atlascloud-mcp.dev.atlascloud.ai", allowed, "production"),
    true
  );
  assert.equal(
    isExactAllowedHost("atlascloud-mcp.dev.atlascloud.ai:443", allowed, "production"),
    true
  );
  assert.equal(
    isExactAllowedHost("atlascloud-mcp.dev.atlascloud.ai:8443", allowed, "production"),
    false
  );
  assert.equal(
    isExactAllowedHost("evil.example@atlascloud-mcp.dev.atlascloud.ai", allowed, "production"),
    false
  );
});

async function statusWithHost(url: string, host: string): Promise<number> {
  const target = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "GET",
        headers: { Host: host },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );
    request.once("error", reject);
    request.end();
  });
}

test("real HTTP MCP surface enforces protocol, auth and security boundaries", async (t) => {
  const { baseUrl, server } = await startHarness();
  t.after(() => closeServer(server));

  await t.test("challenge, metadata, health and security headers are exact", async () => {
    const challenge = await fetch(`${baseUrl}/.well-known/openai-apps-challenge`);
    assert.equal(challenge.status, 200);
    assert.equal(await challenge.text(), "exact-challenge-token");
    assert.match(challenge.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(challenge.headers.get("x-content-type-options"), "nosniff");
    assert.equal(challenge.headers.get("cache-control"), "no-store");

    const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    const body = await metadata.json() as Record<string, unknown>;
    assert.equal(body.resource, "http://127.0.0.1/mcp");
    assert.deepEqual(body.scopes_supported, [...REMOTE_SCOPES]);
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
  });

  await t.test("CORS accepts exact origins and rejects all others", async () => {
    const accepted = await fetch(`${baseUrl}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: "https://chatgpt.com" },
    });
    assert.equal(accepted.status, 204);
    assert.equal(accepted.headers.get("access-control-allow-origin"), "https://chatgpt.com");

    const rejected = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "content-type": "application/json" },
      body: rpcBody("initialize"),
    });
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), { error: "origin_not_allowed" });
  });

  await t.test("DNS rebinding protection rejects an unlisted Host header", async () => {
    assert.equal(await statusWithHost(`${baseUrl}/healthz`, "evil.example"), 403);
    assert.equal(
      await statusWithHost(`${baseUrl}/healthz`, "evil.example@127.0.0.1"),
      403
    );
  });

  await t.test("unauthenticated and invalid bearer requests return 401 challenge", async () => {
    for (const authorization of [undefined, "Bearer invalid"] as const) {
      const headers: Record<string, string> = {
        Origin: "https://chatgpt.com",
        "content-type": "application/json",
      };
      if (authorization) headers.Authorization = authorization;
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: rpcBody("initialize"),
      });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    }
  });

  await t.test("official MCP client initializes and lists exactly 12 remote tools", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer all",
          Origin: "https://chatgpt.com",
        },
      },
    });
    const client = new Client({ name: "http-contract-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 12);
      assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        [...REMOTE_TOOL_NAMES].sort()
      );
      assert.ok(!listed.tools.some((tool) => tool.name === "atlas_chat"));
      assert.ok(!listed.tools.some((tool) => tool.name === "atlas_upload_media"));
      for (const tool of listed.tools) {
        const name = tool.name as keyof typeof TOOL_POLICIES;
        assert.ok(tool.outputSchema);
        assert.deepEqual(tool.annotations, TOOL_POLICIES[name].annotations);
      }
    } finally {
      await client.close();
    }
  });

  await t.test("raw tools/list exposes per-tool OAuth security schemes", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer all",
        Accept: "application/json, text/event-stream",
        Origin: "https://chatgpt.com",
        "content-type": "application/json",
      },
      body: rpcBody("tools/list"),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as Record<string, unknown>;
    const result = payload.result as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    assert.equal(tools.length, 12);
    for (const tool of tools) {
      const name = tool.name as keyof typeof TOOL_POLICIES;
      const expected = [{ type: "oauth2", scopes: [TOOL_POLICIES[name].scope] }];
      assert.deepEqual(tool.securitySchemes, expected);
      assert.deepEqual(
        (tool._meta as Record<string, unknown>).securitySchemes,
        expected
      );
    }
  });

  await t.test("scope and remote-tool allowlists fail before tool execution", async () => {
    const insufficient = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer models",
        Origin: "https://chatgpt.com",
        "content-type": "application/json",
      },
      body: rpcBody("tools/call", { name: "atlas_get_balance", arguments: {} }),
    });
    assert.equal(insufficient.status, 403);
    assert.match(insufficient.headers.get("www-authenticate") ?? "", /insufficient_scope/);

    const localOnly = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer all",
        Origin: "https://chatgpt.com",
        "content-type": "application/json",
      },
      body: rpcBody("tools/call", { name: "atlas_chat", arguments: {} }),
    });
    assert.equal(localOnly.status, 404);
    assert.deepEqual(await localOnly.json(), { error: "tool_not_available" });
  });

  await t.test("stateless endpoint rejects GET/DELETE and oversized JSON", async () => {
    assert.equal((await fetch(`${baseUrl}/mcp`)).status, 405);
    assert.equal((await fetch(`${baseUrl}/mcp`, { method: "DELETE" })).status, 405);

    const oversized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer all",
        Origin: "https://chatgpt.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(120 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "request_too_large" });
    assert.equal((await fetch(`${baseUrl}/not-mcp`)).status, 404);
  });
});

test("pre-auth and authenticated-subject rate limits return 429", async () => {
  const preAuthHarness = await startHarness({
    MCP_PREAUTH_REQUESTS_PER_MINUTE: "2",
    MCP_SUBJECT_REQUESTS_PER_MINUTE: "100",
  });
  try {
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${preAuthHarness.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rpcBody("initialize"),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [401, 401, 429]);
  } finally {
    await closeServer(preAuthHarness.server);
  }

  const subjectHarness = await startHarness({
    MCP_PREAUTH_REQUESTS_PER_MINUTE: "100",
    MCP_SUBJECT_REQUESTS_PER_MINUTE: "2",
  });
  try {
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${subjectHarness.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: "Bearer all",
          Accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: rpcBody("tools/list"),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    await closeServer(subjectHarness.server);
  }
});
