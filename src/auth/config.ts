import { isIP } from "node:net";
import { z } from "zod";
import type { JWKS } from "oidc-provider";
import { REMOTE_SCOPES } from "../config.js";
import {
  parseCredentialEncryptionKeys,
  type CredentialEncryptionKey,
} from "../services/credential-envelope.js";

export type AuthorizationIdentityMode = "local-reviewer" | "upstream-oidc";

export interface UpstreamOidcConfig {
  issuer: URL;
  clientId: string;
  clientSecret?: string;
  scopes: readonly string[];
  endpointHosts: readonly string[];
  callbackUrl: URL;
}

export interface AuthorizationUser {
  sub: string;
  email: string;
  name: string;
  passwordHash: string;
}

/**
 * Optional backend that maps a verified upstream identity onto the Atlas API
 * key of the matching account, so a first-time user does not have to paste one.
 * Absent means every new user links a key manually.
 */
export interface CredentialExchangeConfig {
  url: URL;
  token: string;
}

export interface AuthorizationServerConfig {
  nodeEnv: "development" | "test" | "production";
  releaseTier: "staging" | "production";
  listenHost: string;
  port: number;
  issuer: URL;
  resource: URL;
  redisUrl: string;
  redisPrefix: string;
  jwks: JWKS;
  cookieKeys: string[];
  identityMode: AuthorizationIdentityMode;
  users: readonly AuthorizationUser[];
  upstream?: UpstreamOidcConfig;
  credentialExchange?: CredentialExchangeConfig;
  credentialEncryptionKeys: readonly CredentialEncryptionKey[];
  credentialRedisPrefix: string;
  allowedHosts: readonly string[];
  trustProxy: number | boolean;
  registrationRequestsPerHour: number;
  loginAttemptsPer15Minutes: number;
  dynamicClientTtlSeconds: number;
  grantTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  refreshTokenReuseGraceSeconds: number;
  refreshTokenReuseMaxAttempts: number;
}

const encodedBytes = /^[A-Za-z0-9_-]+$/;
const passwordHash = /^scrypt\$(16384|32768)\$8\$1\$[A-Za-z0-9_-]{16,128}\$[A-Za-z0-9_-]{43,128}$/;

const userSchema = z
  .object({
    sub: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/),
    email: z.string().email().max(254).transform((value) => value.toLowerCase()),
    name: z.string().trim().min(1).max(128),
    password_hash: z.string().regex(passwordHash),
  })
  .strict();

const rsaPrivateJwkSchema = z
  .object({
    kty: z.literal("RSA"),
    kid: z.string().min(8).max(128),
    use: z.literal("sig").optional(),
    alg: z.literal("RS256").optional(),
    n: z.string().regex(encodedBytes),
    e: z.string().regex(encodedBytes),
    d: z.string().regex(encodedBytes),
    p: z.string().regex(encodedBytes),
    q: z.string().regex(encodedBytes),
    dp: z.string().regex(encodedBytes),
    dq: z.string().regex(encodedBytes),
    qi: z.string().regex(encodedBytes),
  })
  .passthrough();

const jwksSchema = z.object({ keys: z.array(rsaPrivateJwkSchema).min(1).max(3) }).strict();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PLUGIN_RELEASE_TIER: z.enum(["staging", "production"]).default("staging"),
  AUTH_HOST: z.string().default("127.0.0.1"),
  AUTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  OIDC_ISSUER_URL: z.string().url(),
  OIDC_MCP_RESOURCE: z.string().url(),
  OIDC_REDIS_URL: z.string().url(),
  OIDC_REDIS_PREFIX: z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/).default("atlascloud:oidc"),
  OIDC_JWKS_JSON: z.string().min(1),
  OIDC_COOKIE_KEYS_JSON: z.string().min(1),
  AUTH_IDENTITY_MODE: z
    .enum(["local-reviewer", "upstream-oidc"])
    .default("local-reviewer"),
  OIDC_USERS_JSON: z.string().min(1).optional(),
  AUTH_UPSTREAM_ISSUER_URL: z.string().url().optional(),
  AUTH_UPSTREAM_CLIENT_ID: z.string().min(1).max(512).optional(),
  AUTH_UPSTREAM_CLIENT_SECRET: z.string().min(1).max(2048).optional(),
  AUTH_UPSTREAM_SCOPES: z.string().default("openid,email,profile"),
  AUTH_UPSTREAM_ENDPOINT_HOSTS: z.string().optional(),
  AUTH_CREDENTIAL_ENCRYPTION_KEYS_JSON: z.string().optional(),
  AUTH_CREDENTIAL_EXCHANGE_URL: z.string().url().optional(),
  AUTH_CREDENTIAL_EXCHANGE_TOKEN: z.string().min(32).max(512).optional(),
  AUTH_CREDENTIAL_REDIS_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9:_-]{1,96}$/)
    .default("atlascloud:openai-plugin:credential"),
  AUTH_ALLOWED_HOSTS: z.string().optional(),
  AUTH_TRUST_PROXY: z.string().default("0"),
  AUTH_REGISTRATION_REQUESTS_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(30),
  AUTH_LOGIN_ATTEMPTS_PER_15_MINUTES: z.coerce.number().int().min(1).max(1000).default(20),
  AUTH_DYNAMIC_CLIENT_TTL_SECONDS: z.coerce.number().int().min(86400).max(31536000).default(7776000),
  AUTH_GRANT_TTL_SECONDS: z.coerce.number().int().min(3600).max(31536000).optional(),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(600),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).max(604800).default(86400),
  AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(120).default(30),
  AUTH_REFRESH_TOKEN_REUSE_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(3).default(2),
});

function parseJson(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

function commaList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function parseTrustProxy(raw: string): number | boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  const hops = Number(normalized);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error("AUTH_TRUST_PROXY must be false, true, or an integer from 0 to 10");
  }
  return hops;
}

function requireHttps(name: string, url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
}

function requireCredentialFreeUrl(name: string, url: URL): void {
  if (url.username || url.password) {
    throw new Error(`${name} must not contain URL credentials`);
  }
}

function isPlainHostname(host: string): boolean {
  if (host.includes("*") || /[:\\/@?#\s]/.test(host)) return false;
  try {
    const parsed = new URL(`https://${host}`);
    return parsed.hostname.toLowerCase() === host.toLowerCase() && parsed.port === "";
  } catch {
    return false;
  }
}

function isDevelopmentOrStagingHostname(hostname: string): boolean {
  const labels = hostname.toLowerCase().split(".");
  return labels.some((label) => ["dev", "development", "stage", "staging", "test"].includes(label));
}

export function loadAuthorizationServerConfig(
  input: NodeJS.ProcessEnv = process.env
): AuthorizationServerConfig {
  const env = envSchema.parse(input);
  if (
    (env.AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS === 0)
    !== (env.AUTH_REFRESH_TOKEN_REUSE_MAX_ATTEMPTS === 0)
  ) {
    throw new Error(
      "AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS and AUTH_REFRESH_TOKEN_REUSE_MAX_ATTEMPTS must both be zero or both be positive"
    );
  }
  const grantTtlSeconds = env.AUTH_GRANT_TTL_SECONDS ?? env.AUTH_DYNAMIC_CLIENT_TTL_SECONDS;
  if (grantTtlSeconds < env.AUTH_REFRESH_TOKEN_TTL_SECONDS) {
    throw new Error("AUTH_GRANT_TTL_SECONDS must be at least AUTH_REFRESH_TOKEN_TTL_SECONDS");
  }
  const issuer = new URL(env.OIDC_ISSUER_URL);
  const resource = new URL(env.OIDC_MCP_RESOURCE);
  const redis = new URL(env.OIDC_REDIS_URL);
  requireCredentialFreeUrl("OIDC_ISSUER_URL", issuer);
  requireCredentialFreeUrl("OIDC_MCP_RESOURCE", resource);

  if (issuer.pathname !== "/" || issuer.search || issuer.hash) {
    throw new Error("OIDC_ISSUER_URL must be an origin without a path, query, or fragment");
  }
  if (!resource.pathname.endsWith("/mcp") || resource.search || resource.hash) {
    throw new Error("OIDC_MCP_RESOURCE must identify the Streamable HTTP endpoint ending in /mcp");
  }
  if (redis.protocol !== "redis:" && redis.protocol !== "rediss:") {
    throw new Error("OIDC_REDIS_URL must use redis:// or rediss://");
  }
  if (env.NODE_ENV === "production") {
    requireHttps("OIDC_ISSUER_URL", issuer);
    requireHttps("OIDC_MCP_RESOURCE", resource);
    if (!redis.password) {
      throw new Error("OIDC_REDIS_URL must include a Redis password in production");
    }
  }
  if (env.PLUGIN_RELEASE_TIER === "production") {
    if (env.NODE_ENV !== "production") {
      throw new Error("PLUGIN_RELEASE_TIER=production requires NODE_ENV=production");
    }
    if (
      isDevelopmentOrStagingHostname(issuer.hostname) ||
      isDevelopmentOrStagingHostname(resource.hostname)
    ) {
      throw new Error("A production release cannot use a development or staging hostname");
    }
    if (env.AUTH_IDENTITY_MODE !== "upstream-oidc") {
      throw new Error("A production release requires AUTH_IDENTITY_MODE=upstream-oidc");
    }
  }

  const jwks = jwksSchema.parse(parseJson("OIDC_JWKS_JSON", env.OIDC_JWKS_JSON));
  if (new Set(jwks.keys.map((key) => key.kid)).size !== jwks.keys.length) {
    throw new Error("OIDC_JWKS_JSON contains duplicate key IDs");
  }
  const cookieKeys = z
    .array(z.string().min(32).max(256))
    .min(2)
    .max(4)
    .parse(parseJson("OIDC_COOKIE_KEYS_JSON", env.OIDC_COOKIE_KEYS_JSON));
  if (new Set(cookieKeys).size !== cookieKeys.length) {
    throw new Error("OIDC_COOKIE_KEYS_JSON must contain distinct keys");
  }

  let users: AuthorizationUser[] = [];
  let upstream: UpstreamOidcConfig | undefined;
  let credentialExchange: CredentialExchangeConfig | undefined;
  let credentialEncryptionKeys: CredentialEncryptionKey[] = [];
  if (env.AUTH_IDENTITY_MODE === "local-reviewer") {
    if (!env.OIDC_USERS_JSON) {
      throw new Error("OIDC_USERS_JSON is required when AUTH_IDENTITY_MODE=local-reviewer");
    }
    const parsedUsers = z
      .array(userSchema)
      .min(1)
      .max(20)
      .parse(parseJson("OIDC_USERS_JSON", env.OIDC_USERS_JSON));
    users = parsedUsers.map((user) => ({
      sub: user.sub,
      email: user.email,
      name: user.name,
      passwordHash: user.password_hash,
    }));
  } else {
    if (env.OIDC_USERS_JSON) {
      throw new Error("OIDC_USERS_JSON must be omitted when AUTH_IDENTITY_MODE=upstream-oidc");
    }
    if (!env.AUTH_UPSTREAM_ISSUER_URL || !env.AUTH_UPSTREAM_CLIENT_ID) {
      throw new Error(
        "AUTH_UPSTREAM_ISSUER_URL and AUTH_UPSTREAM_CLIENT_ID are required for upstream OIDC"
      );
    }
    const upstreamIssuer = new URL(env.AUTH_UPSTREAM_ISSUER_URL);
    requireCredentialFreeUrl("AUTH_UPSTREAM_ISSUER_URL", upstreamIssuer);
    if (upstreamIssuer.pathname !== "/" || upstreamIssuer.search || upstreamIssuer.hash) {
      throw new Error("AUTH_UPSTREAM_ISSUER_URL must be an origin without a path, query, or fragment");
    }
    if (env.NODE_ENV === "production") requireHttps("AUTH_UPSTREAM_ISSUER_URL", upstreamIssuer);
    if (
      env.PLUGIN_RELEASE_TIER === "production" &&
      isDevelopmentOrStagingHostname(upstreamIssuer.hostname)
    ) {
      throw new Error("A production release cannot use a development or staging upstream issuer");
    }
    const scopes = commaList(env.AUTH_UPSTREAM_SCOPES);
    if (!scopes.includes("openid") || !scopes.includes("email")) {
      throw new Error("AUTH_UPSTREAM_SCOPES must include openid and email");
    }
    const requestedEndpointHosts = commaList(env.AUTH_UPSTREAM_ENDPOINT_HOSTS);
    const endpointHosts = requestedEndpointHosts.length > 0
      ? requestedEndpointHosts
      : [upstreamIssuer.hostname.toLowerCase()];
    if (!endpointHosts.includes(upstreamIssuer.hostname.toLowerCase())) {
      throw new Error("AUTH_UPSTREAM_ENDPOINT_HOSTS must include the upstream issuer host");
    }
    if (endpointHosts.some((host) => !isPlainHostname(host))) {
      throw new Error(
        "AUTH_UPSTREAM_ENDPOINT_HOSTS must contain exact host names without ports, wildcards, or paths"
      );
    }
    if (
      env.NODE_ENV === "production" &&
      endpointHosts.some(
        (host) =>
          isIP(host) !== 0 ||
          host === "localhost" ||
          host.endsWith(".localhost") ||
          host.endsWith(".local") ||
          !host.includes(".")
      )
    ) {
      throw new Error("AUTH_UPSTREAM_ENDPOINT_HOSTS contains a private or local host");
    }
    if (!env.AUTH_CREDENTIAL_ENCRYPTION_KEYS_JSON) {
      throw new Error(
        "AUTH_CREDENTIAL_ENCRYPTION_KEYS_JSON is required for upstream OIDC credential linking"
      );
    }
    credentialEncryptionKeys = parseCredentialEncryptionKeys(
      env.AUTH_CREDENTIAL_ENCRYPTION_KEYS_JSON
    );
    if (env.PLUGIN_RELEASE_TIER === "production") {
      if (!env.AUTH_UPSTREAM_CLIENT_SECRET || env.AUTH_UPSTREAM_CLIENT_SECRET.length < 32) {
        throw new Error("A production release requires an upstream OIDC client secret of at least 32 characters");
      }
      if (credentialEncryptionKeys.length < 2) {
        throw new Error("A production release requires at least two credential encryption keys for rotation");
      }
    }
    upstream = {
      issuer: upstreamIssuer,
      clientId: env.AUTH_UPSTREAM_CLIENT_ID,
      clientSecret: env.AUTH_UPSTREAM_CLIENT_SECRET,
      scopes,
      endpointHosts,
      callbackUrl: new URL("/upstream/callback", issuer),
    };
    // 凭据自动换取是可选增强：两个变量必须同时给出，只给一个属于配置错误——
    // 静默忽略会让"以为开了自动绑定、实际每个人还在手贴 key"长期不被发现。
    if (env.AUTH_CREDENTIAL_EXCHANGE_URL || env.AUTH_CREDENTIAL_EXCHANGE_TOKEN) {
      if (!env.AUTH_CREDENTIAL_EXCHANGE_URL || !env.AUTH_CREDENTIAL_EXCHANGE_TOKEN) {
        throw new Error(
          "AUTH_CREDENTIAL_EXCHANGE_URL and AUTH_CREDENTIAL_EXCHANGE_TOKEN must be set together"
        );
      }
      const exchangeUrl = new URL(env.AUTH_CREDENTIAL_EXCHANGE_URL);
      requireCredentialFreeUrl("AUTH_CREDENTIAL_EXCHANGE_URL", exchangeUrl);
      if (exchangeUrl.hash) {
        throw new Error("AUTH_CREDENTIAL_EXCHANGE_URL must not contain a fragment");
      }
      // 这个请求携带一把能换出用户 API key 的密钥，生产必须走 TLS。
      if (env.NODE_ENV === "production") {
        requireHttps("AUTH_CREDENTIAL_EXCHANGE_URL", exchangeUrl);
      }
      credentialExchange = { url: exchangeUrl, token: env.AUTH_CREDENTIAL_EXCHANGE_TOKEN };
    }
  }
  if (new Set(users.map((user) => user.sub)).size !== users.length) {
    throw new Error("OIDC_USERS_JSON contains duplicate subjects");
  }
  if (new Set(users.map((user) => user.email)).size !== users.length) {
    throw new Error("OIDC_USERS_JSON contains duplicate emails");
  }

  const requestedHosts = commaList(env.AUTH_ALLOWED_HOSTS);
  const allowedHosts = requestedHosts.length > 0
    ? requestedHosts
    : [issuer.hostname, "127.0.0.1", "localhost"];
  if (allowedHosts.some((host) => !isPlainHostname(host))) {
    throw new Error("AUTH_ALLOWED_HOSTS must contain exact host names without ports, wildcards, or paths");
  }

  return {
    nodeEnv: env.NODE_ENV,
    releaseTier: env.PLUGIN_RELEASE_TIER,
    listenHost: env.AUTH_HOST,
    port: env.AUTH_PORT,
    issuer,
    resource,
    redisUrl: env.OIDC_REDIS_URL,
    redisPrefix: env.OIDC_REDIS_PREFIX,
    jwks,
    cookieKeys,
    identityMode: env.AUTH_IDENTITY_MODE,
    users,
    upstream,
    credentialExchange,
    credentialEncryptionKeys,
    credentialRedisPrefix: env.AUTH_CREDENTIAL_REDIS_PREFIX,
    allowedHosts,
    trustProxy: parseTrustProxy(env.AUTH_TRUST_PROXY),
    registrationRequestsPerHour: env.AUTH_REGISTRATION_REQUESTS_PER_HOUR,
    loginAttemptsPer15Minutes: env.AUTH_LOGIN_ATTEMPTS_PER_15_MINUTES,
    dynamicClientTtlSeconds: env.AUTH_DYNAMIC_CLIENT_TTL_SECONDS,
    grantTtlSeconds,
    accessTokenTtlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: env.AUTH_REFRESH_TOKEN_TTL_SECONDS,
    refreshTokenReuseGraceSeconds: env.AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS,
    refreshTokenReuseMaxAttempts: env.AUTH_REFRESH_TOKEN_REUSE_MAX_ATTEMPTS,
  };
}

export const AUTHORIZATION_RESOURCE_SCOPES = [...REMOTE_SCOPES] as const;
