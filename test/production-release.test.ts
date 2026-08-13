import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";
import { loadAuthorizationServerConfig } from "../src/auth/config.js";
import { loadHttpServerConfig } from "../src/config.js";
import { validateProductionReleasePair } from "../src/production-release.js";

async function productionEnv(): Promise<NodeJS.ProcessEnv> {
  const { privateKey } = await generateKeyPair("RS256", {
    extractable: true,
    modulusLength: 2048,
  });
  const jwk = await exportJWK(privateKey);
  Object.assign(jwk, { kid: "production-pair-key", use: "sig", alg: "RS256" });
  const credentialKeys = JSON.stringify([
    { kid: "primary-2026-08", key: randomBytes(32).toString("base64url") },
    { kid: "previous-2026-07", key: randomBytes(32).toString("base64url") },
  ]);
  return {
    NODE_ENV: "production",
    PLUGIN_RELEASE_TIER: "production",
    MCP_PUBLIC_URL: "https://mcp.atlascloud.ai/mcp",
    MCP_OAUTH_ISSUER: "https://mcp-auth.atlascloud.ai",
    MCP_OAUTH_JWKS_URI: "https://mcp-auth.atlascloud.ai/jwks",
    MCP_ALLOWED_HOSTS: "mcp.atlascloud.ai",
    MCP_ALLOWED_ORIGINS: "https://chatgpt.com",
    MCP_CREDENTIAL_MODE: "redis-subject-map",
    MCP_CREDENTIAL_ENCRYPTION_KEYS_JSON: credentialKeys,
    MCP_CREDENTIAL_REDIS_PREFIX: "atlascloud:production:credential",
    MCP_IDEMPOTENCY_BACKEND: "redis",
    MCP_REDIS_URL: "redis://:secret@redis.example.com:6379",
    MCP_GENERATION_CONFIRMATION_SECRET: randomBytes(32).toString("base64url"),
    OPENAI_APPS_CHALLENGE_TOKEN: "portal-generated-challenge",
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
    AUTH_CREDENTIAL_ENCRYPTION_KEYS_JSON: credentialKeys,
    AUTH_CREDENTIAL_REDIS_PREFIX: "atlascloud:production:credential",
  };
}

test("production MCP and Auth configuration validates as one release contract", async () => {
  const env = await productionEnv();
  assert.doesNotThrow(() => validateProductionReleasePair(
    loadHttpServerConfig(env),
    loadAuthorizationServerConfig(env)
  ));
});

test("production release contract rejects cross-process credential drift", async () => {
  const env = await productionEnv();
  const mcp = loadHttpServerConfig(env);
  const prefixDrift = loadAuthorizationServerConfig({
    ...env,
    AUTH_CREDENTIAL_REDIS_PREFIX: "atlascloud:production:other",
  });
  assert.throws(
    () => validateProductionReleasePair(mcp, prefixDrift),
    /prefixes do not match/
  );
  const keyringDrift = loadAuthorizationServerConfig({
    ...env,
    AUTH_CREDENTIAL_ENCRYPTION_KEYS_JSON: JSON.stringify([
      { kid: "primary-2026-08", key: randomBytes(32).toString("base64url") },
      { kid: "previous-2026-07", key: randomBytes(32).toString("base64url") },
    ]),
  });
  assert.throws(
    () => validateProductionReleasePair(mcp, keyringDrift),
    /keyrings do not match exactly/
  );
});
