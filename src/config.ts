import { isIP } from "node:net";
import { z } from "zod";
import {
  parseCredentialEncryptionKeys,
  type CredentialEncryptionKey,
} from "./services/credential-envelope.js";

export const REMOTE_SCOPES = [
  "atlas:models:read",
  "atlas:predictions:read",
  "atlas:billing:read",
  "atlas:generation:write",
] as const;

export type ReleaseTier = "staging" | "production";
export type CredentialMode = "service-account" | "subject-map" | "redis-subject-map";
export type IdempotencyBackend = "memory" | "redis";

export interface HttpServerConfig {
  nodeEnv: "development" | "test" | "production";
  releaseTier: ReleaseTier;
  listenHost: string;
  port: number;
  publicMcpUrl: URL;
  resourceId: string;
  authorizationServer: URL;
  jwksUri: URL;
  oauthEndpointHosts: string[];
  oauthAlgorithms: string[];
  oauthClockToleranceSeconds: number;
  scopesSupported: string[];
  allowedHosts: string[];
  allowedOrigins: string[];
  trustProxy: number | boolean;
  preAuthRequestsPerMinute: number;
  subjectRequestsPerMinute: number;
  challengeToken?: string;
  resourceDocumentation?: URL;
  credentialMode: CredentialMode;
  atlasServiceAccountKey?: string;
  atlasSubjectKeys: Record<string, string>;
  credentialEncryptionKeys: readonly CredentialEncryptionKey[];
  credentialRedisPrefix: string;
  idempotencyBackend: IdempotencyBackend;
  idempotencyTtlSeconds: number;
  generationConfirmationSecret: string;
  generationConfirmationTtlSeconds: number;
  redisUrl?: string;
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PLUGIN_RELEASE_TIER: z.enum(["staging", "production"]).default("staging"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MCP_PUBLIC_URL: z.string().url(),
  MCP_OAUTH_ISSUER: z.string().url(),
  MCP_OAUTH_JWKS_URI: z.string().url(),
  MCP_OAUTH_ENDPOINT_HOSTS: z.string().optional(),
  MCP_OAUTH_AUDIENCE: z.string().url().optional(),
  MCP_OAUTH_ALGORITHMS: z.string().default("RS256,ES256"),
  MCP_OAUTH_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
  MCP_OAUTH_SCOPES: z.string().optional(),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_ALLOWED_ORIGINS: z.string().default(
    "https://chatgpt.com,https://chat.openai.com,https://platform.openai.com"
  ),
  MCP_TRUST_PROXY: z.string().default("0"),
  MCP_PREAUTH_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(120),
  MCP_SUBJECT_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(60),
  OPENAI_APPS_CHALLENGE_TOKEN: z.string().min(1).max(1024).optional(),
  MCP_RESOURCE_DOCUMENTATION: z.string().url().optional(),
  MCP_CREDENTIAL_MODE: z
    .enum(["service-account", "subject-map", "redis-subject-map"])
    .default("service-account"),
  ATLASCLOUD_API_KEY: z.string().min(1).optional(),
  MCP_ATLAS_SUBJECT_KEYS_JSON: z.string().optional(),
  MCP_CREDENTIAL_ENCRYPTION_KEYS_JSON: z.string().optional(),
  MCP_CREDENTIAL_REDIS_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9:_-]{1,96}$/)
    .default("atlascloud:openai-plugin:credential"),
  MCP_IDEMPOTENCY_BACKEND: z.enum(["memory", "redis"]).optional(),
  MCP_IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(60).max(604800).default(86400),
  MCP_GENERATION_CONFIRMATION_SECRET: z.string().min(32).optional(),
  MCP_GENERATION_CONFIRMATION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(600),
  MCP_REDIS_URL: z.string().url().optional(),
});

function commaList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseTrustProxy(raw: string): number | boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  const hops = Number(normalized);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error("MCP_TRUST_PROXY must be false, true, or an integer from 0 to 10");
  }
  return hops;
}

function parseSubjectKeys(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("MCP_ATLAS_SUBJECT_KEYS_JSON must be valid JSON");
  }
  const parsed = z.record(z.string().min(1), z.string().min(1)).safeParse(value);
  if (!parsed.success) {
    throw new Error("MCP_ATLAS_SUBJECT_KEYS_JSON must map OAuth subject IDs to Atlas API keys");
  }
  return parsed.data;
}

function rejectSymmetricAlgorithms(algorithms: string[]): void {
  if (algorithms.length === 0) {
    throw new Error("MCP_OAUTH_ALGORITHMS must include at least one asymmetric JWT algorithm");
  }
  const forbidden = algorithms.filter((algorithm) => algorithm.startsWith("HS") || algorithm === "none");
  if (forbidden.length > 0) {
    throw new Error(
      `MCP_OAUTH_ALGORITHMS cannot use symmetric or unsigned algorithms: ${forbidden.join(", ")}`
    );
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

export function loadHttpServerConfig(
  input: NodeJS.ProcessEnv = process.env
): HttpServerConfig {
  const env = envSchema.parse(input);
  const publicMcpUrl = new URL(env.MCP_PUBLIC_URL);
  const authorizationServer = new URL(env.MCP_OAUTH_ISSUER);
  const jwksUri = new URL(env.MCP_OAUTH_JWKS_URI);
  const resourceId = env.MCP_OAUTH_AUDIENCE ?? publicMcpUrl.toString();
  const resourceUrl = new URL(resourceId);
  const oauthAlgorithms = commaList(env.MCP_OAUTH_ALGORITHMS);
  rejectSymmetricAlgorithms(oauthAlgorithms);

  requireCredentialFreeUrl("MCP_PUBLIC_URL", publicMcpUrl);
  requireCredentialFreeUrl("MCP_OAUTH_ISSUER", authorizationServer);
  requireCredentialFreeUrl("MCP_OAUTH_JWKS_URI", jwksUri);
  requireCredentialFreeUrl("MCP_OAUTH_AUDIENCE", resourceUrl);

  if (
    publicMcpUrl.pathname === "/" ||
    !publicMcpUrl.pathname.endsWith("/mcp") ||
    publicMcpUrl.search ||
    publicMcpUrl.hash
  ) {
    throw new Error(
      "MCP_PUBLIC_URL must identify the Streamable HTTP endpoint ending in /mcp without a query or fragment"
    );
  }
  if (authorizationServer.pathname !== "/" || authorizationServer.search || authorizationServer.hash) {
    throw new Error("MCP_OAUTH_ISSUER must be an origin without a path, query, or fragment");
  }
  if (resourceUrl.search || resourceUrl.hash) {
    throw new Error("MCP_OAUTH_AUDIENCE must not contain a query or fragment");
  }
  const requestedOauthEndpointHosts = commaList(env.MCP_OAUTH_ENDPOINT_HOSTS)
    .map((host) => host.toLowerCase());
  const oauthEndpointHosts = requestedOauthEndpointHosts.length > 0
    ? requestedOauthEndpointHosts
    : [...new Set([
        authorizationServer.hostname.toLowerCase(),
        jwksUri.hostname.toLowerCase(),
      ])];
  if (!oauthEndpointHosts.includes(authorizationServer.hostname.toLowerCase())) {
    throw new Error("MCP_OAUTH_ENDPOINT_HOSTS must include the authorization server host");
  }
  if (!oauthEndpointHosts.includes(jwksUri.hostname.toLowerCase())) {
    throw new Error("MCP_OAUTH_ENDPOINT_HOSTS must include the configured JWKS host");
  }
  if (oauthEndpointHosts.some((host) => !isPlainHostname(host))) {
    throw new Error(
      "MCP_OAUTH_ENDPOINT_HOSTS must contain exact host names without ports, wildcards, or paths"
    );
  }
  if (
    env.NODE_ENV === "production" &&
    oauthEndpointHosts.some(
      (host) =>
        isIP(host) !== 0 ||
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        !host.includes(".")
    )
  ) {
    throw new Error("MCP_OAUTH_ENDPOINT_HOSTS contains a private or local host");
  }
  if (env.NODE_ENV === "production") {
    for (const [name, url] of [
      ["MCP_PUBLIC_URL", publicMcpUrl],
      ["MCP_OAUTH_ISSUER", authorizationServer],
      ["MCP_OAUTH_JWKS_URI", jwksUri],
      ["MCP_OAUTH_AUDIENCE", resourceUrl],
    ] as const) {
      if (url.protocol !== "https:") {
        throw new Error(`${name} must use HTTPS in production`);
      }
    }
    if (!env.OPENAI_APPS_CHALLENGE_TOKEN) {
      throw new Error("OPENAI_APPS_CHALLENGE_TOKEN is required in production");
    }
    if (!env.MCP_GENERATION_CONFIRMATION_SECRET) {
      throw new Error(
        "MCP_GENERATION_CONFIRMATION_SECRET is required in production"
      );
    }
  }
  if (env.PLUGIN_RELEASE_TIER === "production") {
    if (env.NODE_ENV !== "production") {
      throw new Error("PLUGIN_RELEASE_TIER=production requires NODE_ENV=production");
    }
    if (
      isDevelopmentOrStagingHostname(publicMcpUrl.hostname) ||
      isDevelopmentOrStagingHostname(authorizationServer.hostname)
    ) {
      throw new Error("A production release cannot use a development or staging hostname");
    }
    if (env.MCP_CREDENTIAL_MODE !== "redis-subject-map") {
      throw new Error(
        "A production release requires MCP_CREDENTIAL_MODE=redis-subject-map"
      );
    }
  }

  const scopesSupported = commaList(env.MCP_OAUTH_SCOPES);
  const finalScopes = scopesSupported.length > 0 ? scopesSupported : [...REMOTE_SCOPES];
  const unknownScopes = finalScopes.filter(
    (scope) => !REMOTE_SCOPES.includes(scope as (typeof REMOTE_SCOPES)[number])
  );
  if (unknownScopes.length > 0) {
    throw new Error(`MCP_OAUTH_SCOPES contains unsupported scopes: ${unknownScopes.join(", ")}`);
  }

  const allowedHosts = commaList(env.MCP_ALLOWED_HOSTS);
  const finalAllowedHosts =
    allowedHosts.length > 0 ? allowedHosts : [publicMcpUrl.hostname, "127.0.0.1", "localhost"];
  if (finalAllowedHosts.some((host) => !isPlainHostname(host))) {
    throw new Error(
      "MCP_ALLOWED_HOSTS must contain exact host names without ports, credentials, wildcards, or paths"
    );
  }

  const allowedOrigins = commaList(env.MCP_ALLOWED_ORIGINS);
  if (env.NODE_ENV === "production" && allowedOrigins.length === 0) {
    throw new Error("MCP_ALLOWED_ORIGINS must contain at least one exact HTTPS origin in production");
  }
  for (const origin of allowedOrigins) {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.origin !== origin.replace(/\/$/, "")) {
      throw new Error("MCP_ALLOWED_ORIGINS entries must be exact origins without paths");
    }
    if (env.NODE_ENV === "production" && parsedOrigin.protocol !== "https:") {
      throw new Error("MCP_ALLOWED_ORIGINS entries must use HTTPS in production");
    }
  }

  const atlasSubjectKeys = parseSubjectKeys(env.MCP_ATLAS_SUBJECT_KEYS_JSON);
  const credentialEncryptionKeys = env.MCP_CREDENTIAL_ENCRYPTION_KEYS_JSON
    ? parseCredentialEncryptionKeys(env.MCP_CREDENTIAL_ENCRYPTION_KEYS_JSON)
    : [];
  if (env.MCP_CREDENTIAL_MODE === "service-account" && !env.ATLASCLOUD_API_KEY) {
    throw new Error("ATLASCLOUD_API_KEY is required when MCP_CREDENTIAL_MODE=service-account");
  }
  if (env.MCP_CREDENTIAL_MODE === "subject-map" && Object.keys(atlasSubjectKeys).length === 0) {
    throw new Error(
      "MCP_ATLAS_SUBJECT_KEYS_JSON must contain at least one mapping when MCP_CREDENTIAL_MODE=subject-map"
    );
  }
  if (env.MCP_CREDENTIAL_MODE === "redis-subject-map" && credentialEncryptionKeys.length === 0) {
    throw new Error(
      "MCP_CREDENTIAL_ENCRYPTION_KEYS_JSON is required when MCP_CREDENTIAL_MODE=redis-subject-map"
    );
  }
  if (env.PLUGIN_RELEASE_TIER === "production" && credentialEncryptionKeys.length < 2) {
    throw new Error("A production release requires at least two credential encryption keys for rotation");
  }

  const idempotencyBackend =
    env.MCP_IDEMPOTENCY_BACKEND ?? (env.NODE_ENV === "production" ? "redis" : "memory");
  if (env.NODE_ENV === "production" && idempotencyBackend !== "redis") {
    throw new Error("Production requires MCP_IDEMPOTENCY_BACKEND=redis");
  }
  if (idempotencyBackend === "redis" && !env.MCP_REDIS_URL) {
    throw new Error("MCP_REDIS_URL is required when MCP_IDEMPOTENCY_BACKEND=redis");
  }
  if (env.MCP_CREDENTIAL_MODE === "redis-subject-map" && !env.MCP_REDIS_URL) {
    throw new Error("MCP_REDIS_URL is required when MCP_CREDENTIAL_MODE=redis-subject-map");
  }
  if (env.PLUGIN_RELEASE_TIER === "production" && env.MCP_REDIS_URL) {
    const redis = new URL(env.MCP_REDIS_URL);
    if (!redis.password) {
      throw new Error("A production release requires a password-protected Redis URL");
    }
  }

  return {
    nodeEnv: env.NODE_ENV,
    releaseTier: env.PLUGIN_RELEASE_TIER,
    listenHost: env.HOST,
    port: env.PORT,
    publicMcpUrl,
    resourceId,
    authorizationServer,
    jwksUri,
    oauthEndpointHosts,
    oauthAlgorithms,
    oauthClockToleranceSeconds: env.MCP_OAUTH_CLOCK_TOLERANCE_SECONDS,
    scopesSupported: finalScopes,
    allowedHosts: finalAllowedHosts,
    allowedOrigins,
    trustProxy: parseTrustProxy(env.MCP_TRUST_PROXY),
    preAuthRequestsPerMinute: env.MCP_PREAUTH_REQUESTS_PER_MINUTE,
    subjectRequestsPerMinute: env.MCP_SUBJECT_REQUESTS_PER_MINUTE,
    challengeToken: env.OPENAI_APPS_CHALLENGE_TOKEN,
    resourceDocumentation: env.MCP_RESOURCE_DOCUMENTATION
      ? new URL(env.MCP_RESOURCE_DOCUMENTATION)
      : undefined,
    credentialMode: env.MCP_CREDENTIAL_MODE,
    atlasServiceAccountKey: env.ATLASCLOUD_API_KEY,
    atlasSubjectKeys,
    credentialEncryptionKeys,
    credentialRedisPrefix: env.MCP_CREDENTIAL_REDIS_PREFIX,
    idempotencyBackend,
    idempotencyTtlSeconds: env.MCP_IDEMPOTENCY_TTL_SECONDS,
    generationConfirmationSecret:
      env.MCP_GENERATION_CONFIRMATION_SECRET ?? "development-confirmation-secret-change-me",
    generationConfirmationTtlSeconds:
      env.MCP_GENERATION_CONFIRMATION_TTL_SECONDS,
    redisUrl: env.MCP_REDIS_URL,
  };
}
