import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";
import { loadHttpServerConfig, type HttpServerConfig } from "../src/config.js";
import {
  fetchAndValidateAuthorizationServerMetadata,
  fetchAndValidateAuthorizationServerMetadataWithRetry,
  JwtAccessTokenVerifier,
  type AuthorizationServerMetadata,
} from "../src/http/auth.js";

function authConfig(): HttpServerConfig {
  return loadHttpServerConfig({
    NODE_ENV: "test",
    MCP_PUBLIC_URL: "http://127.0.0.1/mcp",
    MCP_OAUTH_ISSUER: "http://issuer.test",
    MCP_OAUTH_JWKS_URI: "http://issuer.test/jwks",
    MCP_OAUTH_ALGORITHMS: "RS256",
    MCP_ALLOWED_HOSTS: "127.0.0.1",
    MCP_ALLOWED_ORIGINS: "https://chatgpt.com",
    ATLASCLOUD_API_KEY: "test-atlas-key",
    MCP_IDEMPOTENCY_BACKEND: "memory",
  });
}

async function signingFixture() {
  const config = authConfig();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = await exportJWK(publicKey);
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwk.kid = "test-key";
  const verifier = new JwtAccessTokenVerifier(
    config,
    createLocalJWKSet({ keys: [jwk] })
  );
  return { config, privateKey, verifier };
}

async function signToken(
  fixture: Awaited<ReturnType<typeof signingFixture>>,
  overrides: {
    audience?: string;
    scope?: string;
    expired?: boolean;
    omitGrantId?: boolean;
  } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = new SignJWT({
    client_id: "chatgpt-test-client",
    scope: overrides.scope ?? fixture.config.scopesSupported.join(" "),
    email: "user@example.com",
    email_verified: true,
    ...(!overrides.omitGrantId ? { grant_id: "grant-test-1" } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("user-1")
    .setIssuer(fixture.config.authorizationServer.toString().replace(/\/$/, ""))
    .setAudience(overrides.audience ?? fixture.config.resourceId)
    .setIssuedAt(overrides.expired ? now - 120 : now)
    .setExpirationTime(overrides.expired ? now - 60 : now + 300);
  return token.sign(fixture.privateKey);
}

test("JWT verifier accepts a signed, audience-bound access token", async () => {
  const fixture = await signingFixture();
  const auth = await fixture.verifier.verifyAccessToken(await signToken(fixture));
  assert.equal(auth.extra?.sub, "user-1");
  assert.equal(auth.clientId, "chatgpt-test-client");
  assert.equal(auth.resource?.toString(), fixture.config.resourceId);
});

test("JWT verifier rejects wrong audience, expired and unsupported scopes", async () => {
  const fixture = await signingFixture();
  await assert.rejects(
    fixture.verifier.verifyAccessToken(
      await signToken(fixture, { audience: "http://other-resource.test/mcp" })
    ),
    /invalid|expired|another resource/i
  );
  await assert.rejects(
    fixture.verifier.verifyAccessToken(await signToken(fixture, { expired: true })),
    /invalid|expired|another resource/i
  );
  await assert.rejects(
    fixture.verifier.verifyAccessToken(
      await signToken(fixture, { scope: "atlas:models:read admin:root" })
    ),
    /unsupported scopes/i
  );
  await assert.rejects(
    fixture.verifier.verifyAccessToken(await signToken(fixture, { omitGrantId: true })),
    /invalid|grant identity/i
  );
});

function metadata(config: HttpServerConfig): AuthorizationServerMetadata {
  return {
    issuer: config.authorizationServer.toString().replace(/\/$/, ""),
    authorization_endpoint: "http://issuer.test/authorize",
    token_endpoint: "http://issuer.test/token",
    jwks_uri: config.jwksUri.toString(),
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    registration_endpoint: "http://issuer.test/register",
    scopes_supported: [...config.scopesSupported, "openid", "email", "profile"],
    userinfo_endpoint: "http://issuer.test/userinfo",
  };
}

function metadataFetcher(value: AuthorizationServerMetadata): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

test("authorization-server metadata validates PKCE, discovery, OIDC and scopes", async () => {
  const config = authConfig();
  let redirectMode: RequestRedirect | undefined;
  const result = await fetchAndValidateAuthorizationServerMetadata(
    config,
    (async (_input, init) => {
      redirectMode = init?.redirect;
      return new Response(JSON.stringify(metadata(config)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch
  );
  assert.ok(result.code_challenge_methods_supported?.includes("S256"));
  assert.ok(result.scopes_supported?.includes("atlas:generation:write"));
  assert.equal(redirectMode, "error");
});

test("authorization-server metadata fails closed when OIDC email support is absent", async () => {
  const config = authConfig();
  const invalid = metadata(config);
  invalid.scopes_supported = config.scopesSupported;
  delete invalid.userinfo_endpoint;
  await assert.rejects(
    fetchAndValidateAuthorizationServerMetadata(config, metadataFetcher(invalid)),
    /metadata validation failed/
  );
});

test("authorization-server metadata rejects cross-host endpoints and unsafe responses", async () => {
  const config = authConfig();
  const crossHost = metadata(config);
  crossHost.token_endpoint = "https://attacker.example/token";
  await assert.rejects(
    fetchAndValidateAuthorizationServerMetadata(config, metadataFetcher(crossHost)),
    /not a safe authorization server endpoint/
  );
  await assert.rejects(
    fetchAndValidateAuthorizationServerMetadata(
      config,
      (async () => new Response("<html>not metadata</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch
    ),
    /did not return JSON/
  );
  await assert.rejects(
    fetchAndValidateAuthorizationServerMetadata(
      config,
      (async () => new Response(JSON.stringify(metadata(config)), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(64 * 1024 + 1),
        },
      })) as typeof fetch
    ),
    /too large/
  );
});

test("authorization-server metadata retries transient startup failures", async () => {
  const config = authConfig();
  let fetchCalls = 0;
  const fetcher = (async () => {
    fetchCalls += 1;
    if (fetchCalls <= 2) {
      return new Response("temporarily unavailable", { status: 503 });
    }
    return new Response(JSON.stringify(metadata(config)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const delays: number[] = [];

  const result = await fetchAndValidateAuthorizationServerMetadataWithRetry(
    config,
    fetcher,
    {
      attempts: 2,
      initialDelayMs: 5,
      maxDelayMs: 10,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    }
  );

  assert.equal(result.issuer, config.authorizationServer.toString().replace(/\/$/, ""));
  assert.equal(fetchCalls, 3);
  assert.deepEqual(delays, [5]);
});

test("authorization-server metadata retry remains fail-closed", async () => {
  const config = authConfig();
  let fetchCalls = 0;
  const fetcher = (async () => {
    fetchCalls += 1;
    return new Response("temporarily unavailable", { status: 503 });
  }) as typeof fetch;
  const delays: number[] = [];

  await assert.rejects(
    fetchAndValidateAuthorizationServerMetadataWithRetry(config, fetcher, {
      attempts: 3,
      initialDelayMs: 2,
      maxDelayMs: 3,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    }),
    /metadata validation failed/
  );
  assert.equal(fetchCalls, 6);
  assert.deepEqual(delays, [2, 3]);
});
