import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { loadHttpServerConfig } from "../src/config.js";

function developmentEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    MCP_PUBLIC_URL: "http://127.0.0.1/mcp",
    MCP_OAUTH_ISSUER: "http://issuer.test",
    MCP_OAUTH_JWKS_URI: "http://issuer.test/jwks",
    MCP_OAUTH_ALGORITHMS: "RS256",
    MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
    MCP_ALLOWED_ORIGINS: "https://chatgpt.com",
    MCP_CREDENTIAL_MODE: "service-account",
    ATLASCLOUD_API_KEY: "test-atlas-key",
    MCP_IDEMPOTENCY_BACKEND: "memory",
    MCP_GENERATION_CONFIRMATION_SECRET:
      "test-generation-confirmation-secret-123456",
    OPENAI_APPS_CHALLENGE_TOKEN: "challenge-test",
  };
}

function productionEnv(): NodeJS.ProcessEnv {
  return {
    ...developmentEnv(),
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    MCP_PUBLIC_URL: "https://plugin.example.com/mcp",
    MCP_OAUTH_ISSUER: "https://auth.example.com",
    MCP_OAUTH_JWKS_URI: "https://auth.example.com/.well-known/jwks.json",
    MCP_ALLOWED_HOSTS: "plugin.example.com",
    MCP_IDEMPOTENCY_BACKEND: "redis",
    MCP_REDIS_URL: "redis://redis.example.com:6379",
  };
}

function publicReleaseEnv(): NodeJS.ProcessEnv {
  const env = productionEnv();
  env.PLUGIN_RELEASE_TIER = "production";
  env.MCP_CREDENTIAL_MODE = "redis-subject-map";
  env.MCP_CREDENTIAL_ENCRYPTION_KEYS_JSON = JSON.stringify([
    { kid: "primary-2026-08", key: randomBytes(32).toString("base64url") },
    { kid: "previous-2026-07", key: randomBytes(32).toString("base64url") },
  ]);
  env.MCP_REDIS_URL = "redis://:secret@redis.example.com:6379";
  delete env.ATLASCLOUD_API_KEY;
  return env;
}

test("development config loads the bounded remote contract", () => {
  const config = loadHttpServerConfig(developmentEnv());
  assert.equal(config.publicMcpUrl.pathname, "/mcp");
  assert.deepEqual(config.oauthAlgorithms, ["RS256"]);
  assert.equal(config.idempotencyBackend, "memory");
  assert.equal(config.generationConfirmationTtlSeconds, 600);
  assert.deepEqual(config.allowedOrigins, ["https://chatgpt.com"]);
  assert.deepEqual(config.oauthEndpointHosts, ["issuer.test"]);
});

test("complete production config requires HTTPS, Redis and challenge", () => {
  const config = loadHttpServerConfig(productionEnv());
  assert.equal(config.nodeEnv, "production");
  assert.equal(config.publicMcpUrl.protocol, "https:");
  assert.equal(config.idempotencyBackend, "redis");
  assert.equal(config.challengeToken, "challenge-test");
});

test("public production release requires Redis-encrypted per-subject credentials", () => {
  const config = loadHttpServerConfig(publicReleaseEnv());
  assert.equal(config.releaseTier, "production");
  assert.equal(config.credentialMode, "redis-subject-map");

  const staticMap = publicReleaseEnv();
  staticMap.MCP_CREDENTIAL_MODE = "subject-map";
  staticMap.MCP_ATLAS_SUBJECT_KEYS_JSON = JSON.stringify({ reviewer: "atlas-test-key" });
  assert.throws(
    () => loadHttpServerConfig(staticMap),
    /production release requires MCP_CREDENTIAL_MODE=redis-subject-map/
  );

  const devHostname = publicReleaseEnv();
  devHostname.MCP_PUBLIC_URL = "https://atlascloud-mcp.dev.atlascloud.ai/mcp";
  assert.throws(
    () => loadHttpServerConfig(devHostname),
    /production release cannot use a development or staging hostname/
  );
});

test("production rejects an HTTP MCP URL", () => {
  const env = productionEnv();
  env.MCP_PUBLIC_URL = "http://plugin.example.com/mcp";
  assert.throws(() => loadHttpServerConfig(env), /must use HTTPS in production/);
});

test("production rejects symmetric JWT algorithms", () => {
  const env = productionEnv();
  env.MCP_OAUTH_ALGORITHMS = "HS256";
  assert.throws(() => loadHttpServerConfig(env), /cannot use symmetric or unsigned/);
});

test("production rejects memory idempotency", () => {
  const env = productionEnv();
  env.MCP_IDEMPOTENCY_BACKEND = "memory";
  assert.throws(() => loadHttpServerConfig(env), /Production requires.*redis/);
});

test("production rejects missing challenge token", () => {
  const env = productionEnv();
  delete env.OPENAI_APPS_CHALLENGE_TOKEN;
  assert.throws(() => loadHttpServerConfig(env), /CHALLENGE_TOKEN is required/);
});

test("production rejects missing generation confirmation secret", () => {
  const env = productionEnv();
  delete env.MCP_GENERATION_CONFIRMATION_SECRET;
  assert.throws(
    () => loadHttpServerConfig(env),
    /GENERATION_CONFIRMATION_SECRET is required/
  );
});

test("production rejects wildcard hosts and non-origin CORS entries", () => {
  const wildcard = productionEnv();
  wildcard.MCP_ALLOWED_HOSTS = "*";
  assert.throws(() => loadHttpServerConfig(wildcard), /exact host names/);

  const pathOrigin = productionEnv();
  pathOrigin.MCP_ALLOWED_ORIGINS = "https://chatgpt.com/path";
  assert.throws(() => loadHttpServerConfig(pathOrigin), /exact origins/);
});

test("production rejects URL credentials, non-canonical resources, and host ports", () => {
  const credentialedIssuer = productionEnv();
  credentialedIssuer.MCP_OAUTH_ISSUER = "https://user:secret@auth.example.com";
  assert.throws(() => loadHttpServerConfig(credentialedIssuer), /must not contain URL credentials/);

  const audienceQuery = productionEnv();
  audienceQuery.MCP_OAUTH_AUDIENCE = "https://plugin.example.com/mcp?tenant=one";
  assert.throws(() => loadHttpServerConfig(audienceQuery), /must not contain a query or fragment/);

  const hostPort = productionEnv();
  hostPort.MCP_ALLOWED_HOSTS = "plugin.example.com:443";
  assert.throws(() => loadHttpServerConfig(hostPort), /exact host names/);

  const missingIssuerHost = productionEnv();
  missingIssuerHost.MCP_OAUTH_ENDPOINT_HOSTS = "keys.example.com";
  assert.throws(
    () => loadHttpServerConfig(missingIssuerHost),
    /must include the authorization server host/
  );

  const localEndpointHost = productionEnv();
  localEndpointHost.MCP_OAUTH_ISSUER = "https://127.0.0.1";
  localEndpointHost.MCP_OAUTH_JWKS_URI = "https://127.0.0.1/jwks";
  localEndpointHost.MCP_OAUTH_ENDPOINT_HOSTS = "127.0.0.1";
  assert.throws(
    () => loadHttpServerConfig(localEndpointHost),
    /private or local host/
  );
});
