import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:net";
import test from "node:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JWK,
} from "jose";
import {
  errors,
  type Adapter,
  type AdapterFactory,
  type AdapterPayload,
  type JWKS,
} from "oidc-provider";
import {
  createAuthorizationApp,
  listenAuthorizationApp,
  type AuthorizationAuditEvent,
  type AuthorizationStore,
} from "../src/auth/app.js";
import {
  loadAuthorizationServerConfig,
  type AuthorizationServerConfig,
} from "../src/auth/config.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import type {
  CredentialLinkTicket,
  FederatedAccount,
  FederatedIdentityStore,
  FederatedLoginCompletion,
  UpstreamAuthorizationState,
} from "../src/auth/federated-store.js";
import type {
  UpstreamAuthorizationRequest,
  UpstreamCodeExchange,
  UpstreamIdentityClient,
} from "../src/auth/upstream-oidc.js";
import { REMOTE_SCOPES } from "../src/config.js";
import type { LinkedAtlasCredentialStore } from "../src/services/linked-credential-store.js";

const REVIEWER_PASSWORD = "correct-horse-battery-staple";
const CALLBACK = "https://chatgpt.com/connector/oauth/atlascloud-test-callback";
const CODEX_CALLBACK = "http://127.0.0.1:43123/callback/0jfyHq2aS9Px";

interface TestAuthorizationStore extends AuthorizationStore {
  clearModel(modelName: string): void;
}

function inMemoryStore(
  refreshTokenReuseGraceSeconds = 0,
  refreshTokenReuseMaxAttempts = 0,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000)
): TestAuthorizationStore {
  const models = new Map<string, Map<string, AdapterPayload>>();
  const revokeGrant = (grantId: string): void => {
    for (const records of models.values()) {
      for (const [id, payload] of records) {
        if (payload.grantId === grantId) records.delete(id);
      }
    }
    models.get("Grant")?.delete(grantId);
  };
  const factory: AdapterFactory = (name: string): Adapter => {
    const records = models.get(name) ?? new Map<string, AdapterPayload>();
    models.set(name, records);
    return {
      async upsert(id, payload) {
        records.set(id, structuredClone(payload));
      },
      async find(id) {
        const payload = records.get(id);
        if (!payload) return undefined;
        const visible = structuredClone(payload);
        if (
          name === "RefreshToken"
          && refreshTokenReuseGraceSeconds > 0
          && refreshTokenReuseMaxAttempts > 0
          && typeof visible.consumed === "number"
        ) {
          const reuseCount = typeof visible.atlasRefreshTokenReuseCount === "number"
            ? visible.atlasRefreshTokenReuseCount
            : 0;
          const ageSeconds = nowSeconds() - visible.consumed;
          if (
            ageSeconds >= 0
            && ageSeconds <= refreshTokenReuseGraceSeconds
            && reuseCount < refreshTokenReuseMaxAttempts
          ) delete visible.consumed;
        }
        return visible;
      },
      async findByUserCode(userCode) {
        const payload = [...records.values()].find((candidate) => candidate.userCode === userCode);
        return payload ? structuredClone(payload) : undefined;
      },
      async findByUid(uid) {
        const payload = [...records.values()].find((candidate) => candidate.uid === uid);
        return payload ? structuredClone(payload) : undefined;
      },
      async consume(id) {
        const payload = records.get(id);
        if (!payload) throw new errors.InvalidGrant("grant source no longer exists");
        if (payload.consumed === undefined) {
          payload.consumed = nowSeconds();
          payload.atlasRefreshTokenReuseCount = 0;
          return;
        }
        const reuseCount = typeof payload.atlasRefreshTokenReuseCount === "number"
          ? payload.atlasRefreshTokenReuseCount
          : 0;
        const withinRefreshGrace = name === "RefreshToken"
          && refreshTokenReuseGraceSeconds > 0
          && refreshTokenReuseMaxAttempts > 0
          && typeof payload.consumed === "number"
          && nowSeconds() >= payload.consumed
          && nowSeconds() - payload.consumed <= refreshTokenReuseGraceSeconds
          && reuseCount < refreshTokenReuseMaxAttempts;
        if (!withinRefreshGrace) {
          if (typeof payload.grantId === "string") revokeGrant(payload.grantId);
          throw new errors.InvalidGrant(
            name === "RefreshToken" ? "refresh token already used" : "grant source already consumed"
          );
        }
        payload.atlasRefreshTokenReuseCount = reuseCount + 1;
      },
      async destroy(id) {
        records.delete(id);
      },
      async revokeByGrantId(grantId) {
        revokeGrant(grantId);
      },
    };
  };
  return {
    adapter: factory,
    async ready() { return true; },
    clearModel(modelName) {
      models.get(modelName)?.clear();
    },
  };
}

class MemoryFederatedStore implements FederatedIdentityStore {
  readonly accounts = new Map<string, FederatedAccount>();
  readonly authorizations = new Map<string, UpstreamAuthorizationState>();
  readonly completions = new Map<string, FederatedLoginCompletion>();
  readonly links = new Map<string, CredentialLinkTicket>();

  async getAccount(subject: string): Promise<FederatedAccount | undefined> {
    const account = this.accounts.get(subject);
    return account ? structuredClone(account) : undefined;
  }

  async putAccount(account: FederatedAccount): Promise<void> {
    this.accounts.set(account.sub, structuredClone(account));
  }

  async beginUpstreamAuthorization(
    state: string,
    value: UpstreamAuthorizationState
  ): Promise<void> {
    assert.equal(this.authorizations.has(state), false);
    this.authorizations.set(state, structuredClone(value));
  }

  async consumeUpstreamAuthorization(
    state: string
  ): Promise<UpstreamAuthorizationState | undefined> {
    const value = this.authorizations.get(state);
    this.authorizations.delete(state);
    return value ? structuredClone(value) : undefined;
  }

  async beginLoginCompletion(
    ticket: string,
    value: FederatedLoginCompletion
  ): Promise<void> {
    assert.equal(this.completions.has(ticket), false);
    this.completions.set(ticket, structuredClone(value));
  }

  async consumeLoginCompletion(ticket: string): Promise<FederatedLoginCompletion | undefined> {
    const value = this.completions.get(ticket);
    this.completions.delete(ticket);
    return value ? structuredClone(value) : undefined;
  }

  async beginCredentialLink(ticket: string, value: CredentialLinkTicket): Promise<void> {
    assert.equal(this.links.has(ticket), false);
    this.links.set(ticket, structuredClone(value));
  }

  async getCredentialLink(ticket: string): Promise<CredentialLinkTicket | undefined> {
    const value = this.links.get(ticket);
    return value ? structuredClone(value) : undefined;
  }

  async consumeCredentialLink(ticket: string): Promise<CredentialLinkTicket | undefined> {
    const value = this.links.get(ticket);
    this.links.delete(ticket);
    return value ? structuredClone(value) : undefined;
  }
}

class MemoryCredentialStore implements LinkedAtlasCredentialStore {
  readonly values = new Map<string, string>();

  async get(subject: string): Promise<string | undefined> {
    return this.values.get(subject);
  }

  async put(subject: string, apiKey: string): Promise<void> {
    this.values.set(subject, apiKey);
  }

  async delete(subject: string): Promise<void> {
    this.values.delete(subject);
  }

  async ready(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.listen(0, "127.0.0.1", resolve);
    probe.once("error", reject);
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function fixture(): Promise<{
  baseUrl: string;
  config: AuthorizationServerConfig;
  server: import("node:http").Server;
  publicJwk: JWK;
  auditEvents: AuthorizationAuditEvent[];
  store: TestAuthorizationStore;
}> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
    modulusLength: 2048,
  });
  const privateJwk = await exportJWK(privateKey);
  Object.assign(privateJwk, { kid: "auth-test-key", use: "sig", alg: "RS256" });
  const publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { kid: "auth-test-key", use: "sig", alg: "RS256" });
  const passwordHash = await hashPassword(REVIEWER_PASSWORD);
  const config: AuthorizationServerConfig = {
    nodeEnv: "test",
    releaseTier: "staging",
    listenHost: "127.0.0.1",
    port,
    issuer: new URL(baseUrl),
    resource: new URL(`${baseUrl}/mcp`),
    redisUrl: "redis://127.0.0.1:6379",
    redisPrefix: "test:oidc",
    jwks: { keys: [privateJwk] } as JWKS,
    cookieKeys: [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")],
    identityMode: "local-reviewer",
    users: [{
      sub: "reviewer-1",
      email: "reviewer@example.com",
      name: "Plugin Reviewer",
      passwordHash,
    }],
    credentialEncryptionKeys: [],
    credentialRedisPrefix: "test:credential",
    allowedHosts: ["127.0.0.1"],
    trustProxy: false,
    registrationRequestsPerHour: 100,
    loginAttemptsPer15Minutes: 100,
    dynamicClientTtlSeconds: 86400,
    grantTtlSeconds: 86400,
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 3600,
    refreshTokenReuseGraceSeconds: 30,
    refreshTokenReuseMaxAttempts: 2,
  };
  const auditEvents: AuthorizationAuditEvent[] = [];
  const store = inMemoryStore(
    config.refreshTokenReuseGraceSeconds,
    config.refreshTokenReuseMaxAttempts
  );
  const { app } = createAuthorizationApp(
    config,
    store,
    { auditLogger: (event) => auditEvents.push(event) }
  );
  return {
    baseUrl,
    config,
    server: await listenAuthorizationApp(app, config),
    publicJwk,
    auditEvents,
    store,
  };
}

class StubUpstreamClient implements UpstreamIdentityClient {
  lastAuthorization?: UpstreamAuthorizationRequest;
  exchanges = 0;

  authorizationUrl(request: UpstreamAuthorizationRequest): URL {
    this.lastAuthorization = structuredClone(request);
    const url = new URL("https://identity.example/authorize");
    url.searchParams.set("state", request.state);
    url.searchParams.set("nonce", request.nonce);
    return url;
  }

  async exchangeCode(request: UpstreamCodeExchange): Promise<FederatedAccount> {
    this.exchanges += 1;
    assert.equal(request.code, "valid-upstream-code");
    assert.equal(request.nonce, this.lastAuthorization?.nonce);
    assert.equal(request.codeVerifier, this.lastAuthorization?.codeVerifier);
    return {
      sub: "oidc-federated-user-1",
      email: "federated@example.com",
      name: "Federated User",
    };
  }

  async ready(): Promise<boolean> {
    return true;
  }
}

async function federatedFixture(): Promise<{
  baseUrl: string;
  config: AuthorizationServerConfig;
  server: import("node:http").Server;
  publicJwk: JWK;
  identityStore: MemoryFederatedStore;
  credentialStore: MemoryCredentialStore;
  upstreamClient: StubUpstreamClient;
  validationCalls(): number;
}> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
    modulusLength: 2048,
  });
  const privateJwk = await exportJWK(privateKey);
  Object.assign(privateJwk, { kid: "federated-auth-key", use: "sig", alg: "RS256" });
  const publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { kid: "federated-auth-key", use: "sig", alg: "RS256" });
  const config: AuthorizationServerConfig = {
    nodeEnv: "test",
    releaseTier: "staging",
    listenHost: "127.0.0.1",
    port,
    issuer: new URL(baseUrl),
    resource: new URL(`${baseUrl}/mcp`),
    redisUrl: "redis://127.0.0.1:6379",
    redisPrefix: "test:federated-oidc",
    jwks: { keys: [privateJwk] } as JWKS,
    cookieKeys: [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")],
    identityMode: "upstream-oidc",
    users: [],
    upstream: {
      issuer: new URL("https://identity.example"),
      clientId: "plugin-test-client",
      clientSecret: "test-client-secret-that-is-long-enough",
      scopes: ["openid", "email", "profile"],
      endpointHosts: ["identity.example"],
      callbackUrl: new URL(`${baseUrl}/upstream/callback`),
    },
    credentialEncryptionKeys: [],
    credentialRedisPrefix: "test:federated-credential",
    allowedHosts: ["127.0.0.1"],
    trustProxy: false,
    registrationRequestsPerHour: 100,
    loginAttemptsPer15Minutes: 100,
    dynamicClientTtlSeconds: 86400,
    grantTtlSeconds: 86400,
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 3600,
    refreshTokenReuseGraceSeconds: 30,
    refreshTokenReuseMaxAttempts: 2,
  };
  const identityStore = new MemoryFederatedStore();
  const credentialStore = new MemoryCredentialStore();
  const upstreamClient = new StubUpstreamClient();
  let validationCallCount = 0;
  const { app } = createAuthorizationApp(config, inMemoryStore(
    config.refreshTokenReuseGraceSeconds,
    config.refreshTokenReuseMaxAttempts
  ), {
    federatedStore: identityStore,
    credentialStore,
    upstreamClient,
    async validateAtlasCredential(apiKey) {
      validationCallCount += 1;
      if (apiKey !== "atlas-valid-key-1234567890") {
        throw new Error("invalid test credential");
      }
    },
  });
  return {
    baseUrl,
    config,
    server: await listenAuthorizationApp(app, config),
    publicJwk,
    identityStore,
    credentialStore,
    upstreamClient,
    validationCalls: () => validationCallCount,
  };
}

async function closeServer(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

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

type StoredCookie = {
  name: string;
  value: string;
  path: string;
  secure: boolean;
};

type CookieJar = StoredCookie[];

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const boundary = pathname.lastIndexOf("/");
  return boundary <= 0 ? "/" : pathname.slice(0, boundary);
}

function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function rememberCookies(response: Response, requestUrl: URL, jar: CookieJar): void {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  for (const value of values) {
    const [pair, ...rawAttributes] = value.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    const attributes = rawAttributes.map((attribute) => attribute.toLowerCase());
    const pathAttribute = rawAttributes.find((attribute) =>
      attribute.toLowerCase().startsWith("path=")
    );
    const configuredPath = pathAttribute?.slice("path=".length);
    const path = configuredPath?.startsWith("/")
      ? configuredPath
      : defaultCookiePath(requestUrl.pathname);
    const secure = attributes.includes("secure");
    const maxAgeAttribute = attributes.find((attribute) => attribute.startsWith("max-age="));
    const maxAge = maxAgeAttribute
      ? Number.parseInt(maxAgeAttribute.slice("max-age=".length), 10)
      : undefined;
    const existingIndex = jar.findIndex(
      (candidate) => candidate.name === name && candidate.path === path
    );
    if (!cookieValue || (maxAge !== undefined && maxAge <= 0)) {
      if (existingIndex >= 0) jar.splice(existingIndex, 1);
      continue;
    }
    const cookie = { name, value: cookieValue, path, secure } satisfies StoredCookie;
    if (existingIndex >= 0) jar[existingIndex] = cookie;
    else jar.push(cookie);
  }
}

async function requestWithCookies(
  jar: CookieJar,
  input: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  const target = new URL(input);
  const headers = new Headers(init.headers);
  const cookies = jar
    .filter((cookie) =>
      (!cookie.secure || target.protocol === "https:")
      && cookiePathMatches(target.pathname, cookie.path)
    )
    .sort((left, right) => right.path.length - left.path.length);
  if (cookies.length > 0) {
    headers.set("Cookie", cookies.map(({ name, value }) => `${name}=${value}`).join("; "));
  }
  const response = await fetch(target, { ...init, headers, redirect: "manual" });
  rememberCookies(response, target, jar);
  return response;
}

function location(response: Response, baseUrl: string): URL {
  const value = response.headers.get("location");
  assert.ok(value, `expected Location header on HTTP ${response.status}`);
  return new URL(value, baseUrl);
}

function hidden(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  assert.ok(match, `missing hidden field ${name}`);
  return match[1];
}

async function assertStatus(response: Response, expected: number): Promise<void> {
  if (response.status !== expected) {
    assert.fail(`expected HTTP ${expected}, received ${response.status}: ${await response.text()}`);
  }
}

async function dynamicRegister(
  baseUrl: string,
  redirectUri: string = CALLBACK,
  applicationType: "web" | "native" = "web"
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT Atlas Cloud Connector",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: applicationType,
    }),
  });
  await assertStatus(response, 201);
  return response.json() as Promise<Record<string, unknown>>;
}

test("password hashes verify without storing plaintext", async () => {
  const encoded = await hashPassword(REVIEWER_PASSWORD);
  assert.match(encoded, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword(REVIEWER_PASSWORD, encoded), true);
  assert.equal(await verifyPassword("incorrect-password-value", encoded), false);
});

test("production auth config requires HTTPS and password-protected Redis", async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
  const jwk = await exportJWK(privateKey);
  Object.assign(jwk, { kid: "config-test-key", use: "sig", alg: "RS256" });
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    OIDC_ISSUER_URL: "https://auth.example.com",
    OIDC_MCP_RESOURCE: "https://mcp.example.com/mcp",
    OIDC_REDIS_URL: "redis://redis.example.com:6379",
    OIDC_JWKS_JSON: JSON.stringify({ keys: [jwk] }),
    OIDC_COOKIE_KEYS_JSON: JSON.stringify(["a".repeat(32), "b".repeat(32)]),
    OIDC_USERS_JSON: JSON.stringify([{
      sub: "reviewer-1",
      email: "reviewer@example.com",
      name: "Reviewer",
      password_hash: await hashPassword(REVIEWER_PASSWORD),
    }]),
  };
  assert.throws(() => loadAuthorizationServerConfig(env), /Redis password/);
  const loaded = loadAuthorizationServerConfig({
    ...env,
    OIDC_REDIS_URL: "redis://:secret@redis.example.com:6379",
  });
  assert.equal(loaded.resource.toString(), "https://mcp.example.com/mcp");
  assert.equal(loaded.refreshTokenReuseGraceSeconds, 30);
  assert.equal(loaded.refreshTokenReuseMaxAttempts, 2);
  assert.equal(loaded.refreshTokenTtlSeconds, 90 * 24 * 60 * 60);
  assert.equal(loaded.grantTtlSeconds, loaded.dynamicClientTtlSeconds);
  assert.throws(
    () => loadAuthorizationServerConfig({
      ...env,
      OIDC_REDIS_URL: "redis://:secret@redis.example.com:6379",
      AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS: "121",
    }),
    /less than or equal to 120/
  );
  assert.throws(
    () => loadAuthorizationServerConfig({
      ...env,
      OIDC_REDIS_URL: "redis://:secret@redis.example.com:6379",
      AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS: "0",
    }),
    /must both be zero or both be positive/
  );
  assert.throws(
    () => loadAuthorizationServerConfig({
      ...env,
      OIDC_REDIS_URL: "redis://:secret@redis.example.com:6379",
      AUTH_GRANT_TTL_SECONDS: "3600",
    }),
    /must be at least AUTH_REFRESH_TOKEN_TTL_SECONDS/
  );
  assert.throws(
    () => loadAuthorizationServerConfig({
      ...env,
      OIDC_ISSUER_URL: "https://user:secret@auth.example.com",
      OIDC_REDIS_URL: "redis://:secret@redis.example.com:6379",
    }),
    /must not contain URL credentials/
  );
  assert.throws(
    () => loadAuthorizationServerConfig({
      ...env,
      OIDC_REDIS_URL: "redis://:secret@redis.example.com:6379",
      OIDC_JWKS_JSON: JSON.stringify({ keys: [jwk, jwk] }),
    }),
    /duplicate key IDs/
  );
});

test("public release auth requires upstream OIDC and encrypted credential linking", async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
  const jwk = await exportJWK(privateKey);
  Object.assign(jwk, { kid: "public-config-key", use: "sig", alg: "RS256" });
  const encryptionKeys = JSON.stringify([
    { kid: "primary-2026-08", key: randomBytes(32).toString("base64url") },
    { kid: "previous-2026-07", key: randomBytes(32).toString("base64url") },
  ]);
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    PLUGIN_RELEASE_TIER: "production",
    OIDC_ISSUER_URL: "https://mcp-auth.atlascloud.ai",
    OIDC_MCP_RESOURCE: "https://mcp.atlascloud.ai/mcp",
    OIDC_REDIS_URL: "redis://:secret@redis.example.com:6379",
    OIDC_JWKS_JSON: JSON.stringify({ keys: [jwk] }),
    OIDC_COOKIE_KEYS_JSON: JSON.stringify(["a".repeat(32), "b".repeat(32)]),
    AUTH_IDENTITY_MODE: "upstream-oidc",
    AUTH_UPSTREAM_ISSUER_URL: "https://accounts.atlascloud.ai",
    AUTH_UPSTREAM_CLIENT_ID: "openai-plugin-production",
    AUTH_UPSTREAM_CLIENT_SECRET: "s".repeat(32),
    AUTH_UPSTREAM_SCOPES: "openid,email,profile",
    AUTH_CREDENTIAL_ENCRYPTION_KEYS_JSON: encryptionKeys,
  };

  const config = loadAuthorizationServerConfig(base);
  assert.equal(config.releaseTier, "production");
  assert.equal(config.identityMode, "upstream-oidc");
  assert.equal(config.upstream?.callbackUrl.toString(), "https://mcp-auth.atlascloud.ai/upstream/callback");
  assert.deepEqual(config.upstream?.scopes, ["openid", "email", "profile"]);
  assert.deepEqual(config.upstream?.endpointHosts, ["accounts.atlascloud.ai"]);
  assert.equal(config.credentialEncryptionKeys.length, 2);

  // 凭据自动换取是可选增强：未配置时保持 undefined，首次登录走手工粘贴。
  assert.equal(config.credentialExchange, undefined);

  const withExchange = loadAuthorizationServerConfig({
    ...base,
    AUTH_CREDENTIAL_EXCHANGE_URL: "https://api.atlascloud.ai/api/v1/federated/credential",
    AUTH_CREDENTIAL_EXCHANGE_TOKEN: "x".repeat(32),
  });
  assert.equal(
    withExchange.credentialExchange?.url.toString(),
    "https://api.atlascloud.ai/api/v1/federated/credential"
  );

  // 只给一半属于配置错误：静默忽略会让"以为开了自动绑定、其实全员还在手贴"长期不被发现。
  for (const half of [
    { AUTH_CREDENTIAL_EXCHANGE_URL: "https://api.atlascloud.ai/api/v1/federated/credential" },
    { AUTH_CREDENTIAL_EXCHANGE_TOKEN: "x".repeat(32) },
  ]) {
    assert.throws(
      () => loadAuthorizationServerConfig({ ...base, ...half }),
      /must be set together/
    );
  }

  // 这个请求携带能换出用户 API key 的密钥，生产必须 TLS。
  assert.throws(
    () => loadAuthorizationServerConfig({
      ...base,
      AUTH_CREDENTIAL_EXCHANGE_URL: "http://api.atlascloud.ai/api/v1/federated/credential",
      AUTH_CREDENTIAL_EXCHANGE_TOKEN: "x".repeat(32),
    }),
    /AUTH_CREDENTIAL_EXCHANGE_URL/
  );

  const localReviewer = { ...base, AUTH_IDENTITY_MODE: "local-reviewer" };
  localReviewer.OIDC_USERS_JSON = JSON.stringify([{
    sub: "reviewer-1",
    email: "reviewer@example.com",
    name: "Reviewer",
    password_hash: await hashPassword(REVIEWER_PASSWORD),
  }]);
  assert.throws(
    () => loadAuthorizationServerConfig(localReviewer),
    /production release requires AUTH_IDENTITY_MODE=upstream-oidc/
  );

  assert.throws(
    () => loadAuthorizationServerConfig({ ...base, AUTH_UPSTREAM_SCOPES: "openid,profile" }),
    /must include openid and email/
  );
  assert.throws(
    () => loadAuthorizationServerConfig({ ...base, AUTH_UPSTREAM_CLIENT_SECRET: "short" }),
    /client secret of at least 32 characters/
  );
  assert.throws(
    () => loadAuthorizationServerConfig({
      ...base,
      AUTH_UPSTREAM_ENDPOINT_HOSTS: "tokens.atlascloud.ai",
    }),
    /must include the upstream issuer host/
  );
  assert.throws(
    () => loadAuthorizationServerConfig({
      ...base,
      AUTH_UPSTREAM_ISSUER_URL: "https://127.0.0.1",
      AUTH_UPSTREAM_ENDPOINT_HOSTS: "127.0.0.1",
    }),
    /private or local host/
  );
});

test("OAuth server exposes compliant metadata and rejects unsafe DCR", async (t) => {
  const harness = await fixture();
  t.after(() => closeServer(harness.server));

  assert.equal(
    await statusWithHost(`${harness.baseUrl}/healthz`, "evil.example@127.0.0.1"),
    421
  );

  const metadataResponse = await fetch(`${harness.baseUrl}/.well-known/openid-configuration`);
  assert.equal(metadataResponse.status, 200);
  assert.equal(metadataResponse.headers.get("content-security-policy"), null);
  const metadata = await metadataResponse.json() as Record<string, unknown>;
  assert.equal(metadata.issuer, harness.baseUrl);
  assert.equal(metadata.registration_endpoint, `${harness.baseUrl}/reg`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.ok((metadata.scopes_supported as string[]).includes("atlas:generation:write"));

  const authScriptResponse = await fetch(`${harness.baseUrl}/assets/auth.js`);
  assert.equal(authScriptResponse.status, 200);
  assert.match(authScriptResponse.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.equal(authScriptResponse.headers.get("content-security-policy"), null);
  assert.equal(authScriptResponse.headers.get("cache-control"), "no-store");
  const authScript = await authScriptResponse.text();
  assert.match(authScript, /form\[data-submit-once\]/);
  assert.match(authScript, /event\.preventDefault\(\)/);

  const unsafe = await fetch(`${harness.baseUrl}/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"] }),
  });
  assert.equal(unsafe.status, 400);
  assert.equal((await unsafe.json() as Record<string, unknown>).error, "invalid_redirect_uri");

  const codexClient = await dynamicRegister(harness.baseUrl, CODEX_CALLBACK, "native");
  assert.deepEqual(codexClient.redirect_uris, [CODEX_CALLBACK]);
  assert.equal(codexClient.application_type, "native");

  const codexWithProfile = await fetch(`${harness.baseUrl}/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Codex",
      redirect_uris: [CODEX_CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "native",
      scope: "openid profile email",
    }),
  });
  assert.equal(codexWithProfile.status, 201);

  const mismatchedClientTypes = [
    { application_type: "native", redirect_uris: [CALLBACK] },
    { application_type: "web", redirect_uris: [CODEX_CALLBACK] },
    { application_type: "native", redirect_uris: [CODEX_CALLBACK, CALLBACK] },
  ];
  for (const mismatch of mismatchedClientTypes) {
    const response = await fetch(`${harness.baseUrl}/reg`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...mismatch,
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(response.status, 400, JSON.stringify(mismatch));
    assert.equal(
      (await response.json() as Record<string, unknown>).error,
      "invalid_client_metadata",
      JSON.stringify(mismatch)
    );
  }

  const unsafeCodexCallbacks = [
    "http://localhost:43123/callback/0jfyHq2aS9Px",
    "http://[::1]:43123/callback/0jfyHq2aS9Px",
    "http://127.0.0.1/callback/0jfyHq2aS9Px",
    "http://127.0.0.1:43123/callback",
    "http://127.0.0.1:43123/callback/0jfyHq2aS9P",
    "http://127.0.0.1:43123/callback/0jfyHq2aS9Px/extra",
    "http://127.0.0.1:43123/callback/0jfyHq2aS9Px?next=https://evil.example",
    "http://127.0.0.1:43123/callback/0jfyHq2aS9Px#fragment",
    "http://user@127.0.0.1:43123/callback/0jfyHq2aS9Px",
    "http://127.0.0.2:43123/callback/0jfyHq2aS9Px",
    "http://192.168.1.10:43123/callback/0jfyHq2aS9Px",
    "https://127.0.0.1:43123/callback/0jfyHq2aS9Px",
  ];
  for (const redirectUri of unsafeCodexCallbacks) {
    const response = await fetch(`${harness.baseUrl}/reg`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(response.status, 400, redirectUri);
    assert.equal(
      (await response.json() as Record<string, unknown>).error,
      "invalid_redirect_uri",
      redirectUri
    );
  }

  const remoteJwks = await fetch(`${harness.baseUrl}/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "private_key_jwt",
      jwks_uri: "https://127.0.0.1/oauth/jwks.json",
    }),
  });
  assert.equal(remoteJwks.status, 400);

  const strippedPrivateJwks = await fetch(`${harness.baseUrl}/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      jwks_uri: "https://127.0.0.1/oauth/jwks.json",
      id_token_encrypted_response_alg: "RSA-OAEP",
      request_object_signing_alg: "RS256",
      userinfo_encrypted_response_alg: "RSA-OAEP",
    }),
  });
  assert.equal(strippedPrivateJwks.status, 201);
  const strippedPrivateJwksClient = await strippedPrivateJwks.json() as Record<string, unknown>;
  assert.equal(strippedPrivateJwksClient.token_endpoint_auth_method, "none");
  assert.equal(strippedPrivateJwksClient.jwks_uri, undefined);
  assert.equal(strippedPrivateJwksClient.id_token_encrypted_response_alg, undefined);
  assert.equal(strippedPrivateJwksClient.request_object_signing_alg, undefined);
  assert.equal(strippedPrivateJwksClient.userinfo_encrypted_response_alg, undefined);

  const withUnknownExtension = await fetch(`${harness.baseUrl}/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CALLBACK], admin: true }),
  });
  assert.equal(withUnknownExtension.status, 201);
  const stripped = await withUnknownExtension.json() as Record<string, unknown>;
  assert.equal(stripped.admin, undefined);
});

test("Codex scopes keep refresh tokens valid after the browser session expires", async (t) => {
  const harness = await fixture();
  t.after(() => closeServer(harness.server));
  const client = await dynamicRegister(harness.baseUrl);
  const clientId = client.client_id;
  assert.equal(typeof clientId, "string");
  assert.equal(client.token_endpoint_auth_method, "none");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL(`${harness.baseUrl}/auth`);
  authorization.searchParams.set("client_id", clientId as string);
  authorization.searchParams.set("redirect_uri", CALLBACK);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", ["openid", "email", ...REMOTE_SCOPES].join(" "));
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("resource", harness.config.resource.toString());
  authorization.searchParams.set("state", "test-state");

  const jar: CookieJar = [];
  let response = await requestWithCookies(jar, authorization);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("content-security-policy"), null);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'"
  );
  let html = await response.text();
  assert.match(html, /Connect ChatGPT to Atlas Cloud/);
  assert.match(
    html,
    /<script src="\/assets\/auth\.js\?v=single-submit-v1" defer><\/script>/
  );
  assert.match(html, /data-submit-once/);
  const loginUid = hidden(html, "interaction_uid");
  const loginCsrf = hidden(html, "csrf_token");

  response = await requestWithCookies(jar, `${harness.baseUrl}/interaction/${loginUid}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf_token: loginCsrf,
      interaction_uid: loginUid,
      email: "reviewer@example.com",
      password: REVIEWER_PASSWORD,
    }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("content-security-policy"), null);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("content-security-policy"), null);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'"
  );
  html = await response.text();
  assert.match(html, /Generation calls may consume Atlas Cloud credits/);
  const consentUid = hidden(html, "interaction_uid");
  const consentCsrf = hidden(html, "csrf_token");

  const consentBody = new URLSearchParams({
    csrf_token: consentCsrf,
    interaction_uid: consentUid,
    decision: "allow",
  });
  response = await requestWithCookies(jar, `${harness.baseUrl}/interaction/${consentUid}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: consentBody,
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("content-security-policy"), null);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("content-security-policy"), null);
  const callback = location(response, harness.baseUrl);
  assert.equal(callback.origin + callback.pathname, CALLBACK);
  assert.equal(callback.searchParams.get("state"), "test-state");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const staleConsent = await requestWithCookies(
    jar,
    `${harness.baseUrl}/interaction/${consentUid}/confirm`,
    {
      method: "POST",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(consentBody),
    }
  );
  assert.equal(staleConsent.status, 400);
  assert.match(staleConsent.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(
    staleConsent.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  const recoveryHtml = await staleConsent.text();
  assert.match(recoveryHtml, /authorization link is no longer valid/i);
  assert.match(recoveryHtml, /Return to ChatGPT or Codex/);
  assert.doesNotMatch(recoveryHtml, /\{"error":"invalid_request"/);
  assert.deepEqual(harness.auditEvents.at(-1), {
    event: "authorization_request_error",
    method: "POST",
    route: "/interaction/:uid/confirm",
    reason: "session_mismatch",
    status: 400,
  });

  const tokenResponse = await fetch(`${harness.baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId as string,
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      resource: harness.config.resource.toString(),
    }),
  });
  await assertStatus(tokenResponse, 200);
  assert.equal(tokenResponse.headers.get("content-security-policy"), null);
  const tokens = await tokenResponse.json() as Record<string, unknown>;
  assert.equal(typeof tokens.access_token, "string");
  assert.equal(typeof tokens.id_token, "string");
  assert.equal(typeof tokens.refresh_token, "string");

  const jwks = createLocalJWKSet({ keys: [harness.publicJwk] });
  const access = await jwtVerify(tokens.access_token as string, jwks, {
    issuer: harness.baseUrl,
    audience: harness.config.resource.toString(),
    algorithms: ["RS256"],
  });
  assert.equal(access.payload.sub, "reviewer-1");
  assert.equal(access.payload.client_id, clientId);
  assert.ok(String(access.payload.scope).includes("atlas:generation:write"));

  const identity = await jwtVerify(tokens.id_token as string, jwks, {
    issuer: harness.baseUrl,
    audience: clientId as string,
    algorithms: ["RS256"],
  });
  assert.equal(identity.payload.email, "reviewer@example.com");
  assert.equal(identity.payload.email_verified, true);

  const providerMetadata = await fetch(
    `${harness.baseUrl}/.well-known/openid-configuration`
  ).then((metadataResponse) => metadataResponse.json()) as Record<string, unknown>;
  assert.equal(typeof providerMetadata.userinfo_endpoint, "string");
  const userinfoResponse = await fetch(providerMetadata.userinfo_endpoint as string, {
    headers: { Authorization: `Bearer ${tokens.access_token as string}` },
  });
  await assertStatus(userinfoResponse, 200);
  const userinfo = await userinfoResponse.json() as Record<string, unknown>;
  assert.equal(userinfo.sub, "reviewer-1");
  assert.equal(userinfo.email, "reviewer@example.com");
  assert.equal(userinfo.email_verified, true);

  const returningClient = await dynamicRegister(harness.baseUrl);
  const returningClientId = returningClient.client_id;
  assert.equal(typeof returningClientId, "string");
  const returningVerifier = randomBytes(32).toString("base64url");
  const returningAuthorization = new URL(`${harness.baseUrl}/auth`);
  returningAuthorization.searchParams.set("client_id", returningClientId as string);
  returningAuthorization.searchParams.set("redirect_uri", CALLBACK);
  returningAuthorization.searchParams.set("response_type", "code");
  returningAuthorization.searchParams.set(
    "scope",
    "openid email profile offline_access atlas:models:read atlas:predictions:read atlas:billing:read"
  );
  returningAuthorization.searchParams.set(
    "code_challenge",
    createHash("sha256").update(returningVerifier).digest("base64url")
  );
  returningAuthorization.searchParams.set("code_challenge_method", "S256");
  returningAuthorization.searchParams.set("resource", harness.config.resource.toString());
  returningAuthorization.searchParams.set("state", "returning-browser-session");

  response = await requestWithCookies(jar, returningAuthorization);
  assert.equal(response.status, 303);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, /Authorize ChatGPT/);
  assert.doesNotMatch(html, /Connect ChatGPT to Atlas Cloud/);
  assert.doesNotMatch(html, /Generation calls may consume Atlas Cloud credits/);
  const returningConsentUid = hidden(html, "interaction_uid");
  const returningConsentCsrf = hidden(html, "csrf_token");
  response = await requestWithCookies(
    jar,
    `${harness.baseUrl}/interaction/${returningConsentUid}/confirm`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf_token: returningConsentCsrf,
        interaction_uid: returningConsentUid,
        decision: "allow",
      }),
    }
  );
  assert.equal(response.status, 303);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 303);
  const returningCallback = location(response, harness.baseUrl);
  assert.equal(returningCallback.origin + returningCallback.pathname, CALLBACK);
  assert.equal(returningCallback.searchParams.get("state"), "returning-browser-session");
  assert.ok(returningCallback.searchParams.get("code"));

  const invalidUserinfoResponse = await fetch(providerMetadata.userinfo_endpoint as string, {
    headers: { Authorization: `Bearer ${tokens.access_token as string}x` },
  });
  assert.equal(invalidUserinfoResponse.status, 401);
  assert.match(invalidUserinfoResponse.headers.get("www-authenticate") ?? "", /invalid_token/);

  // Codex does not request offline_access. Its refresh token must remain usable
  // after the interactive browser session has expired or been removed.
  harness.store.clearModel("Session");

  const refreshWithOriginal = () => fetch(`${harness.baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId as string,
      refresh_token: tokens.refresh_token as string,
      resource: harness.config.resource.toString(),
    }),
  });
  const concurrentRefreshes = await Promise.all([refreshWithOriginal(), refreshWithOriginal()]);
  for (const refreshResponse of concurrentRefreshes) {
    await assertStatus(refreshResponse, 200);
    const refreshed = await refreshResponse.json() as Record<string, unknown>;
    assert.equal(typeof refreshed.access_token, "string");
    assert.equal(typeof refreshed.refresh_token, "string");
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
  }

  const boundedRetry = await refreshWithOriginal();
  await assertStatus(boundedRetry, 200);
  const boundedRetryTokens = await boundedRetry.json() as Record<string, unknown>;
  assert.equal(typeof boundedRetryTokens.refresh_token, "string");

  const exhaustedRetry = await refreshWithOriginal();
  await assertStatus(exhaustedRetry, 400);
  assert.equal((await exhaustedRetry.json() as Record<string, unknown>).error, "invalid_grant");

  const refreshSuccesses = harness.auditEvents.filter(
    (event) => event.event === "oidc_refresh_success"
  );
  assert.equal(refreshSuccesses.length, 3);
  const consentSuccesses = harness.auditEvents.filter(
    (event) => event.event === "authorization_consent_success"
  );
  assert.equal(consentSuccesses.length, 2);
  assert.ok(consentSuccesses.every((event) => event.callback_type === "chatgpt"));
  const authorizationCodeSuccesses = harness.auditEvents.filter(
    (event) => event.event === "oidc_authorization_code_success"
  );
  assert.equal(authorizationCodeSuccesses.length, 1);
  assert.match(authorizationCodeSuccesses[0].client_hash, /^[a-f0-9]{16}$/);
  const replayEvent = harness.auditEvents.find(
    (event) => event.event === "oidc_grant_error" && event.reason === "refresh_token_replay"
  );
  assert.ok(replayEvent);
  assert.equal(replayEvent.grant_type, "refresh_token");
  assert.match(replayEvent.client_hash, /^[a-f0-9]{16}$/);
  const serializedAudit = JSON.stringify(harness.auditEvents);
  assert.equal(serializedAudit.includes(tokens.refresh_token as string), false);
  assert.equal(serializedAudit.includes(clientId as string), false);
});

test("parallel browser authorization interactions keep path-scoped cookies isolated", async (t) => {
  const harness = await fixture();
  t.after(() => closeServer(harness.server));
  const client = await dynamicRegister(harness.baseUrl, CODEX_CALLBACK, "native");
  assert.equal(typeof client.client_id, "string");

  const jar: CookieJar = [];
  const begin = async (state: string): Promise<{
    csrf: string;
    uid: string;
  }> => {
    const verifier = randomBytes(32).toString("base64url");
    const authorization = new URL(`${harness.baseUrl}/auth`);
    authorization.searchParams.set("client_id", client.client_id as string);
    authorization.searchParams.set("redirect_uri", CODEX_CALLBACK);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set(
      "scope",
      "openid email profile offline_access atlas:models:read atlas:billing:read"
    );
    authorization.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url")
    );
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("resource", harness.config.resource.toString());
    authorization.searchParams.set("state", state);

    let response = await requestWithCookies(jar, authorization);
    assert.equal(response.status, 303);
    response = await requestWithCookies(jar, location(response, harness.baseUrl));
    assert.equal(response.status, 200);
    const html = await response.text();
    return {
      csrf: hidden(html, "csrf_token"),
      uid: hidden(html, "interaction_uid"),
    };
  };

  const first = await begin("parallel-first");
  const second = await begin("parallel-second");
  assert.notEqual(first.uid, second.uid);

  const interactionCookies = jar.filter((cookie) =>
    cookie.name.endsWith("atlascloud_interaction")
  );
  assert.deepEqual(
    new Set(interactionCookies.map((cookie) => cookie.path)),
    new Set([`/interaction/${first.uid}`, `/interaction/${second.uid}`])
  );
  const csrfCookies = jar.filter((cookie) => cookie.name.endsWith("atlascloud_csrf"));
  assert.deepEqual(
    new Set(csrfCookies.map((cookie) => cookie.path)),
    new Set([`/interaction/${first.uid}`, `/interaction/${second.uid}`])
  );

  const firstLogin = await requestWithCookies(
    jar,
    `${harness.baseUrl}/interaction/${first.uid}/login`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf_token: first.csrf,
        interaction_uid: first.uid,
        email: "reviewer@example.com",
        password: REVIEWER_PASSWORD,
      }),
    }
  );
  assert.equal(firstLogin.status, 303);
});

test("legacy browser session cookies are ignored and expired during OAuth migration", async (t) => {
  const harness = await fixture();
  t.after(() => closeServer(harness.server));
  const client = await dynamicRegister(harness.baseUrl, CODEX_CALLBACK, "native");
  assert.equal(typeof client.client_id, "string");
  const verifier = randomBytes(32).toString("base64url");
  const authorization = new URL(`${harness.baseUrl}/auth`);
  authorization.searchParams.set("client_id", client.client_id as string);
  authorization.searchParams.set("redirect_uri", CODEX_CALLBACK);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", "openid email atlas:models:read");
  authorization.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url")
  );
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("resource", harness.config.resource.toString());
  authorization.searchParams.set("state", "legacy-session-migration");

  const jar: CookieJar = [{
    name: "atlascloud_op",
    value: "legacy-signed-session-value",
    path: "/",
    secure: false,
  }];
  let response = await requestWithCookies(jar, authorization);
  assert.equal(response.status, 303);
  assert.equal(jar.some((cookie) => cookie.name === "atlascloud_op"), false);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Connect ChatGPT to Atlas Cloud/);
});

test("Codex native DCR flow returns a loopback authorization code for read-only scopes", async (t) => {
  const harness = await fixture();
  t.after(() => closeServer(harness.server));
  const client = await dynamicRegister(harness.baseUrl, CODEX_CALLBACK, "native");
  const clientId = client.client_id;
  assert.equal(typeof clientId, "string");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL(`${harness.baseUrl}/auth`);
  authorization.searchParams.set("client_id", clientId as string);
  authorization.searchParams.set("redirect_uri", CODEX_CALLBACK);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set(
    "scope",
    [
      "openid",
      "email",
      "profile",
      "offline_access",
      "atlas:models:read",
      "atlas:billing:read",
    ].join(" ")
  );
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("resource", harness.config.resource.toString());
  authorization.searchParams.set("state", "codex-read-only-state");

  const jar: CookieJar = [];
  let response = await requestWithCookies(jar, authorization);
  assert.equal(response.status, 303);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self' http://127.0.0.1:43123; frame-ancestors 'none'; base-uri 'none'"
  );
  let html = await response.text();
  const loginUid = hidden(html, "interaction_uid");
  const loginCsrf = hidden(html, "csrf_token");

  response = await requestWithCookies(jar, `${harness.baseUrl}/interaction/${loginUid}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf_token: loginCsrf,
      interaction_uid: loginUid,
      email: "reviewer@example.com",
      password: REVIEWER_PASSWORD,
    }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("content-security-policy"), null);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("content-security-policy"), null);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 200);
  html = await response.text();
  assert.doesNotMatch(html, /Start billable AI media generation jobs/);
  assert.doesNotMatch(html, /Generation calls may consume Atlas Cloud credits/);
  const consentUid = hidden(html, "interaction_uid");
  const consentCsrf = hidden(html, "csrf_token");

  response = await requestWithCookies(jar, `${harness.baseUrl}/interaction/${consentUid}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf_token: consentCsrf,
      interaction_uid: consentUid,
      decision: "allow",
    }),
  });
  assert.equal(response.status, 303);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 303);
  const callback = location(response, harness.baseUrl);
  assert.equal(callback.origin + callback.pathname, CODEX_CALLBACK);
  assert.equal(callback.searchParams.get("state"), "codex-read-only-state");
  assert.ok(callback.searchParams.get("code"));
  const consentSuccess = harness.auditEvents.find(
    (event) => event.event === "authorization_consent_success"
  );
  assert.ok(consentSuccess);
  assert.equal(consentSuccess.callback_type, "codex_loopback");
});

test("federated OIDC login links a validated Atlas key before issuing downstream tokens", async (t) => {
  const harness = await federatedFixture();
  t.after(() => closeServer(harness.server));
  const client = await dynamicRegister(harness.baseUrl);
  const clientId = client.client_id;
  assert.equal(typeof clientId, "string");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL(`${harness.baseUrl}/auth`);
  authorization.searchParams.set("client_id", clientId as string);
  authorization.searchParams.set("redirect_uri", CALLBACK);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", ["openid", "email", ...REMOTE_SCOPES].join(" "));
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("resource", harness.config.resource.toString());
  authorization.searchParams.set("state", "federated-downstream-state");

  const jar: CookieJar = [];
  let response = await requestWithCookies(jar, authorization);
  assert.equal(response.status, 303);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 303);
  const upstreamAuthorization = location(response, harness.baseUrl);
  assert.equal(upstreamAuthorization.origin, "https://identity.example");
  const upstreamState = upstreamAuthorization.searchParams.get("state");
  assert.ok(upstreamState);
  assert.equal(harness.identityStore.authorizations.size, 1);

  const malformedUpstreamCallback = new URL(`${harness.baseUrl}/upstream/callback`);
  malformedUpstreamCallback.searchParams.set("state", upstreamState);
  malformedUpstreamCallback.searchParams.set("iss", "https://identity.example");
  response = await requestWithCookies(jar, malformedUpstreamCallback);
  assert.equal(response.status, 400);
  assert.equal(harness.identityStore.authorizations.size, 1);

  const upstreamCallback = new URL(`${harness.baseUrl}/upstream/callback`);
  upstreamCallback.searchParams.set("code", "valid-upstream-code");
  upstreamCallback.searchParams.set("state", upstreamState);
  upstreamCallback.searchParams.set("iss", "https://identity.example");
  upstreamCallback.searchParams.set("scope", "openid email profile");
  upstreamCallback.searchParams.set("authuser", "0");
  upstreamCallback.searchParams.set("hd", "atlascloud.ai");
  upstreamCallback.searchParams.set("prompt", "consent");
  response = await requestWithCookies(jar, upstreamCallback);
  assert.equal(response.status, 200);
  let html = await response.text();
  assert.match(html, /Link your Atlas Cloud API key/);
  assert.match(html, /federated@example\.com/);
  assert.equal(harness.upstreamClient.exchanges, 1);
  assert.equal(harness.identityStore.authorizations.size, 0);
  const linkUid = hidden(html, "interaction_uid");
  let linkCsrf = hidden(html, "csrf_token");
  const linkTicket = hidden(html, "link_ticket");

  const replay = await requestWithCookies(jar, upstreamCallback);
  assert.equal(replay.status, 400);
  assert.equal(harness.upstreamClient.exchanges, 1);

  const invalidKey = "atlas-invalid-key-1234567890";
  response = await requestWithCookies(jar, `${harness.baseUrl}/interaction/${linkUid}/link`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf_token: linkCsrf,
      interaction_uid: linkUid,
      link_ticket: linkTicket,
      atlas_api_key: invalidKey,
    }),
  });
  assert.equal(response.status, 401);
  html = await response.text();
  assert.match(html, /could not be verified/);
  assert.equal(html.includes(invalidKey), false);
  assert.equal(harness.credentialStore.values.size, 0);
  assert.equal(harness.validationCalls(), 1);
  linkCsrf = hidden(html, "csrf_token");

  const validKey = "atlas-valid-key-1234567890";
  response = await requestWithCookies(jar, `${harness.baseUrl}/interaction/${linkUid}/link`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf_token: linkCsrf,
      interaction_uid: linkUid,
      link_ticket: linkTicket,
      atlas_api_key: validKey,
    }),
  });
  assert.equal(response.status, 303);
  assert.equal(harness.validationCalls(), 2);
  assert.equal(harness.credentialStore.values.get("oidc-federated-user-1"), validKey);
  assert.equal(harness.identityStore.links.size, 0);

  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 303);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, /Generation calls may consume Atlas Cloud credits/);
  const consentUid = hidden(html, "interaction_uid");
  const consentCsrf = hidden(html, "csrf_token");
  response = await requestWithCookies(jar, `${harness.baseUrl}/interaction/${consentUid}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf_token: consentCsrf,
      interaction_uid: consentUid,
      decision: "allow",
    }),
  });
  assert.equal(response.status, 303);
  response = await requestWithCookies(jar, location(response, harness.baseUrl));
  assert.equal(response.status, 303);
  const callback = location(response, harness.baseUrl);
  assert.equal(callback.origin + callback.pathname, CALLBACK);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(`${harness.baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId as string,
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      resource: harness.config.resource.toString(),
    }),
  });
  await assertStatus(tokenResponse, 200);
  const tokens = await tokenResponse.json() as Record<string, unknown>;
  const jwks = createLocalJWKSet({ keys: [harness.publicJwk] });
  const identity = await jwtVerify(tokens.id_token as string, jwks, {
    issuer: harness.baseUrl,
    audience: clientId as string,
    algorithms: ["RS256"],
  });
  assert.equal(identity.payload.sub, "oidc-federated-user-1");
  assert.equal(identity.payload.email, "federated@example.com");
  assert.equal(identity.payload.email_verified, true);

  const userinfoResponse = await fetch(`${harness.baseUrl}/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token as string}` },
  });
  await assertStatus(userinfoResponse, 200);
  const userinfo = await userinfoResponse.json() as Record<string, unknown>;
  assert.equal(userinfo.sub, "oidc-federated-user-1");
  assert.equal(userinfo.email, "federated@example.com");
  assert.equal(userinfo.email_verified, true);

  const returningJar: CookieJar = [];
  const returningVerifier = randomBytes(32).toString("base64url");
  const returningAuthorization = new URL(authorization);
  returningAuthorization.searchParams.set(
    "code_challenge",
    createHash("sha256").update(returningVerifier).digest("base64url")
  );
  returningAuthorization.searchParams.set("state", "returning-downstream-state");
  response = await requestWithCookies(returningJar, returningAuthorization);
  response = await requestWithCookies(returningJar, location(response, harness.baseUrl));
  assert.equal(response.status, 303);
  const returningUpstream = location(response, harness.baseUrl);
  const returningState = returningUpstream.searchParams.get("state");
  assert.ok(returningState);
  const returningCallback = new URL(`${harness.baseUrl}/upstream/callback`);
  returningCallback.searchParams.set("code", "valid-upstream-code");
  returningCallback.searchParams.set("state", returningState);
  returningCallback.searchParams.set("iss", "https://identity.example/");
  response = await requestWithCookies(returningJar, returningCallback);
  assert.equal(response.status, 303);
  const completionUrl = location(response, harness.baseUrl);
  assert.match(
    completionUrl.pathname,
    /^\/interaction\/[A-Za-z0-9_-]+\/complete$/
  );
  assert.equal(harness.identityStore.completions.size, 1);
  response = await requestWithCookies(returningJar, completionUrl);
  assert.equal(response.status, 303);
  assert.match(location(response, harness.baseUrl).pathname, /^\/auth\/[A-Za-z0-9_-]+$/);
  assert.equal(harness.identityStore.completions.size, 0);
  const completionReplay = await requestWithCookies(returningJar, completionUrl);
  assert.equal(completionReplay.status, 400);
  assert.equal(harness.validationCalls(), 2);
  assert.equal(harness.upstreamClient.exchanges, 2);

  const mismatchJar: CookieJar = [];
  const mismatchAuthorization = new URL(authorization);
  mismatchAuthorization.searchParams.set("state", "issuer-mismatch-downstream-state");
  response = await requestWithCookies(mismatchJar, mismatchAuthorization);
  response = await requestWithCookies(mismatchJar, location(response, harness.baseUrl));
  const mismatchUpstream = location(response, harness.baseUrl);
  const mismatchState = mismatchUpstream.searchParams.get("state");
  assert.ok(mismatchState);
  const mismatchCallback = new URL(`${harness.baseUrl}/upstream/callback`);
  mismatchCallback.searchParams.set("code", "valid-upstream-code");
  mismatchCallback.searchParams.set("state", mismatchState);
  mismatchCallback.searchParams.set("iss", "https://evil.example");
  response = await requestWithCookies(mismatchJar, mismatchCallback);
  assert.equal(response.status, 400);
  assert.equal(harness.identityStore.authorizations.size, 1);
  assert.equal(harness.upstreamClient.exchanges, 2);
});
