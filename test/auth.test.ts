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
    omitJti?: boolean;
    issuer?: string;
    accountId?: number | string;
    extraClaims?: Record<string, unknown>;
  } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = new SignJWT({
    client_id: "chatgpt-test-client",
    scope: overrides.scope ?? fixture.config.scopesSupported.join(" "),
    email: "user@example.com",
    email_verified: true,
    ...(!overrides.omitGrantId ? { grant_id: "grant-test-1" } : {}),
    ...(!overrides.omitJti ? { jti: "jti-test-1" } : {}),
    ...(overrides.accountId !== undefined ? { account_id: overrides.accountId } : {}),
    ...(overrides.extraClaims ?? {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("user-1")
    .setIssuer(overrides.issuer ?? fixture.config.authorizationServer.toString().replace(/\/$/, ""))
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
  // 新语义：grant_id 与 jti 任取其一即可（本地 AS 给前者，Atlas 给后者），两个都缺才拒。
  await assert.rejects(
    fixture.verifier.verifyAccessToken(
      await signToken(fixture, { omitGrantId: true, omitJti: true })
    ),
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
  assert.ok(result.scopes_supported?.includes("tasks:write"));
  assert.equal(redirectMode, "error");
});

test("authorization-server metadata accepts an issuer without userinfo or email scope", async () => {
  // Atlas 的授权服务器没有 userinfo 端点，ID token 也不含 email。那两项只有 ChatGPT 的
  // workspace 域限制才需要，强制它们会让插件对着 Atlas 直接启动失败。
  const config = authConfig();
  const lean = metadata(config);
  lean.scopes_supported = config.scopesSupported;
  delete lean.userinfo_endpoint;
  const accepted = await fetchAndValidateAuthorizationServerMetadata(
    config,
    metadataFetcher(lean)
  );
  assert.equal(accepted.issuer, config.authorizationServer.toString().replace(/\/$/, ""));
  assert.equal(accepted.userinfo_endpoint, undefined);

  // 但资源自己要用的 scope 若没被公示，仍然要拒。
  const missingScope = metadata(config);
  missingScope.scopes_supported = ["openid"];
  delete missingScope.userinfo_endpoint;
  await assert.rejects(
    fetchAndValidateAuthorizationServerMetadata(config, metadataFetcher(missingScope)),
    /does not advertise the scopes/
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

test("契约 5.4 的拒绝向量全部被拒，基线用例仍通过", async () => {
  const fixture = await signingFixture();
  const resource = fixture.config.resourceId;

  // 基线：一枚符合 Atlas 契约的令牌（没有 grant_id，只有 jti + account_id）应当通过，
  // 确保后面那些拒绝不是因为整体坏掉。
  const baseline = await fixture.verifier.verifyAccessToken(
    await signToken(fixture, { omitGrantId: true, accountId: 789 })
  );
  assert.equal(baseline.extra?.sub, "user-1");
  assert.equal(baseline.extra?.grant_id, "jti-test-1", "缺 grant_id 时应回退用 jti");
  assert.equal(baseline.extra?.account_id, "789", "account_id 要带进 AuthInfo");

  const rejected: Array<[string, Parameters<typeof signToken>[1]]> = [
    ["exp 已过期", { expired: true }],
    ["iss 不匹配", { issuer: "http://evil.test" }],
    ["aud 是别的资源", { audience: "http://other.test/mcp" }],
    ["scope 越界", { scope: "atlas:models:read admin:root" }],
    ["既无 grant_id 也无 jti", { omitGrantId: true, omitJti: true }],
    ["携带管理员标志 is_admin", { extraClaims: { is_admin: true } }],
    ["携带 roles", { extraClaims: { roles: ["admin"] } }],
  ];
  for (const [name, overrides] of rejected) {
    const token = await signToken(fixture, overrides);
    await assert.rejects(
      () => fixture.verifier.verifyAccessToken(token),
      /invalid|expired|another resource|unsupported|forbidden|grant identity/i,
      name
    );
  }

  // alg 混淆：拿 RSA 公钥当 HMAC 密钥签的 HS256 令牌
  const publicJwk = await exportJWK((await generateKeyPair("RS256")).publicKey);
  const hmacKey = new TextEncoder().encode(JSON.stringify(publicJwk));
  const now = Math.floor(Date.now() / 1000);
  const confused = await new SignJWT({ client_id: "x", scope: "tasks:read", jti: "j" })
    .setProtectedHeader({ alg: "HS256", kid: "test-key" })
    .setSubject("user-1")
    .setIssuer(fixture.config.authorizationServer.toString().replace(/\/$/, ""))
    .setAudience(resource)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(hmacKey);
  await assert.rejects(() => fixture.verifier.verifyAccessToken(confused), /invalid/i, "HS256 alg 混淆");

  // alg: none
  const header = Buffer.from(JSON.stringify({ alg: "none", kid: "test-key" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    sub: "user-1", jti: "j", iss: fixture.config.authorizationServer.toString().replace(/\/$/, ""),
    aud: resource, iat: now, exp: now + 300, client_id: "x", scope: "tasks:read",
  })).toString("base64url");
  await assert.rejects(() => fixture.verifier.verifyAccessToken(`${header}.${body}.`), /invalid/i, "alg:none");

  // kid 未知
  const otherPair = await generateKeyPair("RS256");
  const unknownKid = await new SignJWT({ client_id: "x", scope: "tasks:read", jti: "j" })
    .setProtectedHeader({ alg: "RS256", kid: "no-such-kid" })
    .setSubject("user-1")
    .setIssuer(fixture.config.authorizationServer.toString().replace(/\/$/, ""))
    .setAudience(resource)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(otherPair.privateKey);
  await assert.rejects(() => fixture.verifier.verifyAccessToken(unknownKid), /invalid/i, "kid 未知");
});

test("契约 v3 §2：无 kid 时仅当 JWKS 恰好一把密钥才接受", async () => {
  const config = authConfig();
  const a = await generateKeyPair("RS256");
  const b = await generateKeyPair("RS256");
  const jwkOf = async (pair: Awaited<ReturnType<typeof generateKeyPair>>, kid: string) => {
    const jwk: JWK = await exportJWK(pair.publicKey);
    jwk.alg = "RS256";
    jwk.use = "sig";
    jwk.kid = kid;
    return jwk;
  };
  const jwkA = await jwkOf(a, "key-a");
  const jwkB = await jwkOf(b, "key-b");

  const now = Math.floor(Date.now() / 1000);
  // 关键：protected header 里不带 kid
  const tokenWithoutKid = await new SignJWT({
    client_id: "x",
    scope: "tasks:read",
    jti: "j",
    grant_id: "g",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("user-1")
    .setIssuer(config.authorizationServer.toString().replace(/\/$/, ""))
    .setAudience(config.resourceId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(a.privateKey);

  // 恰好一把 → 接受
  const single = new JwtAccessTokenVerifier(config, createLocalJWKSet({ keys: [jwkA] }));
  const ok = await single.verifyAccessToken(tokenWithoutKid);
  assert.equal(ok.extra?.sub, "user-1");

  // 多把 → 拒绝（无从选择公钥，不得猜）
  const multi = new JwtAccessTokenVerifier(config, createLocalJWKSet({ keys: [jwkA, jwkB] }));
  await assert.rejects(
    () => multi.verifyAccessToken(tokenWithoutKid),
    /invalid/i,
    "无 kid 且 JWKS 含多把密钥必须拒绝"
  );
});

test("契约 v3 §3：签发方多带的身份 claim 不会流向下游", async () => {
  const fixture = await signingFixture();
  const token = await signToken(fixture, {
    extraClaims: { name: "Someone", avatar: "https://example.test/a.png" },
  });
  const auth = await fixture.verifier.verifyAccessToken(token);
  const extra = (auth.extra ?? {}) as Record<string, unknown>;
  for (const claim of ["email", "email_verified", "name", "avatar"]) {
    assert.equal(extra[claim], undefined, `${claim} 不应出现在下游可见的 extra 里`);
  }
  // 该带的仍然在
  assert.equal(extra.sub, "user-1");
});

test("契约 v3 §5：消费账户只认 account_id claim，不受请求头影响", async () => {
  const fixture = await signingFixture();
  // 令牌里写 789；如果实现读了 X-Account-ID 这类请求头就会串账
  const token = await signToken(fixture, { accountId: 789 });
  const auth = await fixture.verifier.verifyAccessToken(token);
  assert.equal((auth.extra as Record<string, unknown>).account_id, "789");

  // 校验器只接受令牌本身，没有任何入口能从请求头注入账户
  assert.equal(fixture.verifier.verifyAccessToken.length, 1, "verifyAccessToken 只接受令牌一个入参");
});
