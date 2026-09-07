import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { HttpServerConfig } from "../config.js";

const MAX_METADATA_BYTES = 64 * 1024;

/** 协议层 scope：不属于任何资源，两套授权服务器都可能带，不该被当成「不支持的 scope」。 */
const PROTOCOL_SCOPES = new Set(["openid", "email", "profile", "offline_access"]);

/**
 * 出现即拒绝的 claim。契约明确：带 scope 的令牌永不携带管理员身份，也不承载身份资料
 * （那属于 ID token）。这里列的是常见写法，命中任何一个都当签发侧异常处理。
 */
const FORBIDDEN_CLAIMS = [
  "admin",
  "is_admin",
  "isAdmin",
  "superuser",
  "is_superuser",
  "is_staff",
  "roles",
  "role",
] as const;

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function scopesFromPayload(payload: JWTPayload): string[] {
  const scope = payload.scope;
  if (typeof scope === "string") {
    return [...new Set(scope.split(/\s+/).filter(Boolean))];
  }
  const scp = payload.scp;
  if (Array.isArray(scp) && scp.every((value) => typeof value === "string")) {
    return [...new Set(scp)];
  }
  return [];
}

export class JwtAccessTokenVerifier implements OAuthTokenVerifier {
  private readonly key: JWTVerifyGetKey;

  constructor(
    private readonly config: HttpServerConfig,
    key?: JWTVerifyGetKey
  ) {
    // 契约 v3 §2：本地固定缓存 5 分钟，忽略响应的 Cache-Control / Age / Date；
    // 未知 kid 允许刷新一次，外发刷新按独立的 30 秒窗口节流。jose 不读 HTTP 缓存
    // 头，这两个值就是全部的缓存语义——不要改成从响应头推导。
    this.key =
      key ??
      createRemoteJWKSet(config.jwksUri, {
        cacheMaxAge: 300_000,
        cooldownDuration: 30_000,
      });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.config.authorizationServer.toString().replace(/\/$/, ""),
        audience: this.config.resourceId,
        algorithms: this.config.oauthAlgorithms,
        clockTolerance: this.config.oauthClockToleranceSeconds,
        // grant_id 不在这里要求：它是本地 oidc-provider 的产物，Atlas 授权服务器的令牌
        // 契约里没有这个 claim（只有 jti）。两套授权服务器都要能吃，所以只要求两边都签的。
        requiredClaims: ["sub", "exp", "iat", "jti"],
      });

      const subject = stringClaim(payload, "sub");
      if (!subject || typeof payload.exp !== "number") {
        throw new InvalidTokenError("Access token is missing required claims");
      }
      // 带 scope 的令牌永不携带管理员身份。出现即当异常拒绝，而不是忽略——
      // 忽略的话一旦上游签发逻辑出错，这里会静默放行一枚越权令牌。
      const forbidden = FORBIDDEN_CLAIMS.find((claim) => payload[claim] !== undefined);
      if (forbidden) {
        throw new InvalidTokenError("Access token carries a forbidden claim");
      }
      const clientId =
        stringClaim(payload, "client_id") ??
        stringClaim(payload, "azp") ??
        stringClaim(payload, "clientId");
      if (!clientId) {
        throw new InvalidTokenError("Access token is missing client identity");
      }
      // 授权标识：本地 AS 给 grant_id，Atlas 给 jti。取到哪个都行，用于把一次授权的
      // 请求串起来做审计与幂等，缺了才是异常。
      const grantId = stringClaim(payload, "grant_id") ?? stringClaim(payload, "jti");
      if (!grantId) {
        throw new InvalidTokenError("Access token is missing grant identity");
      }
      // account_id 是「这枚令牌唯一允许消费的账户」，按契约必须以它为准、忽略请求头里的
      // 账户标识。这里先带进 AuthInfo，供下游消费与审计。
      const accountId =
        typeof payload.account_id === "number" || typeof payload.account_id === "string"
          ? String(payload.account_id)
          : undefined;
      const scopes = scopesFromPayload(payload);
      const unsupported = scopes.filter(
        (scope) => !this.config.scopesSupported.includes(scope) &&
          !PROTOCOL_SCOPES.has(scope)
      );
      if (unsupported.length > 0) {
        throw new InvalidTokenError("Access token includes unsupported scopes");
      }

      return {
        token,
        clientId,
        scopes,
        expiresAt: payload.exp,
        resource: new URL(this.config.resourceId),
        // 契约 v3 §3：email / name / avatar 属于 ID token，access token 不承载，
        // 「资源服务器不得依赖」。即使签发方多带了，也不往下游传——传下去就会长出
        // 依赖，等签发方按契约停发时再拆就是破坏性变更了。
        extra: {
          sub: subject,
          grant_id: grantId,
          ...(accountId ? { account_id: accountId } : {}),
        },
      };
    } catch (error) {
      if (error instanceof InvalidTokenError) throw error;
      throw new InvalidTokenError("Access token is invalid, expired, or for another resource");
    }
  }
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  registration_endpoint?: string;
  client_id_metadata_document_supported?: boolean;
  scopes_supported?: string[];
  userinfo_endpoint?: string;
}

function metadataCandidates(issuer: URL): URL[] {
  const normalized = new URL(issuer.toString());
  normalized.pathname = normalized.pathname.replace(/\/$/, "");
  const oauth = new URL(normalized);
  oauth.pathname = `/.well-known/oauth-authorization-server${normalized.pathname}`;
  const oidc = new URL(normalized);
  oidc.pathname = `${normalized.pathname}/.well-known/openid-configuration`.replace(
    /\/+/g,
    "/"
  );
  return [oauth, oidc];
}

function validateMetadataEndpoint(
  name: string,
  value: string,
  config: HttpServerConfig
): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol)
    || (config.nodeEnv === "production" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.hash
    || (config.nodeEnv === "production" && url.port !== "" && url.port !== "443")
    || !config.oauthEndpointHosts.includes(url.hostname.toLowerCase())
  ) {
    throw new Error(`${name} is not a safe authorization server endpoint`);
  }
  return url;
}

async function readMetadata(response: Response): Promise<AuthorizationServerMetadata> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("authorization server metadata did not return JSON");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_METADATA_BYTES) {
    throw new Error("authorization server metadata response is too large");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_METADATA_BYTES) {
    throw new Error("authorization server metadata response is too large");
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("authorization server metadata is not an object");
  }
  return parsed as AuthorizationServerMetadata;
}

export async function fetchAndValidateAuthorizationServerMetadata(
  config: HttpServerConfig,
  fetcher: typeof fetch = fetch
): Promise<AuthorizationServerMetadata> {
  let lastError: unknown;
  for (const url of metadataCandidates(config.authorizationServer)) {
    try {
      const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) {
        lastError = new Error(`metadata returned HTTP ${response.status}`);
        continue;
      }
      const metadata = await readMetadata(response);
      const expectedIssuer = config.authorizationServer.toString().replace(/\/$/, "");
      if (metadata.issuer?.replace(/\/$/, "") !== expectedIssuer) {
        throw new Error("authorization server metadata issuer does not match");
      }
      if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
        throw new Error("authorization server metadata lacks authorization or token endpoint");
      }
      validateMetadataEndpoint(
        "authorization_endpoint",
        metadata.authorization_endpoint,
        config
      );
      validateMetadataEndpoint("token_endpoint", metadata.token_endpoint, config);
      if (!metadata.code_challenge_methods_supported?.includes("S256")) {
        throw new Error("authorization server must advertise PKCE S256");
      }
      const clientDiscovery =
        Boolean(metadata.client_id_metadata_document_supported) ||
        Boolean(metadata.registration_endpoint);
      if (!clientDiscovery) {
        throw new Error("authorization server must support CIMD or dynamic client registration");
      }
      if (!metadata.jwks_uri) {
        throw new Error("authorization server metadata lacks jwks_uri");
      }
      if (new URL(metadata.jwks_uri).toString() !== config.jwksUri.toString()) {
        throw new Error("configured JWKS URI does not match authorization server metadata");
      }
      validateMetadataEndpoint("jwks_uri", metadata.jwks_uri, config);
      // scope 公示只做「我们要用的资源 scope 在不在」这一项。openid / email 不再强制：
      // 那是 ChatGPT 的 workspace 域限制才需要的（要配 userinfo + email_verified），
      // Atlas 授权服务器既没有 userinfo 端点、ID token 也不含 email，强制会让启动直接失败。
      const advertisedScopes = new Set(metadata.scopes_supported ?? []);
      if (metadata.scopes_supported && config.scopesSupported.some((scope) => !advertisedScopes.has(scope))) {
        throw new Error(
          "authorization server metadata does not advertise the scopes this resource requires"
        );
      }
      // userinfo 是可选的：公示了就校验它是不是安全端点，没公示不影响令牌校验。
      if (metadata.userinfo_endpoint) {
        validateMetadataEndpoint("userinfo_endpoint", metadata.userinfo_endpoint, config);
      }
      if (metadata.registration_endpoint) {
        validateMetadataEndpoint(
          "registration_endpoint",
          metadata.registration_endpoint,
          config
        );
      }
      const supportedClientAuthMethods = new Set([
        "none",
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
      ]);
      if (
        !metadata.token_endpoint_auth_methods_supported?.some((method) =>
          supportedClientAuthMethods.has(method)
        )
      ) {
        throw new Error(
          "authorization server does not advertise a supported token endpoint authentication method"
        );
      }
      return metadata;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "unknown metadata error";
  throw new Error(`OAuth authorization server metadata validation failed: ${detail}`);
}

export interface AuthorizationMetadataRetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function fetchAndValidateAuthorizationServerMetadataWithRetry(
  config: HttpServerConfig,
  fetcher: typeof fetch = fetch,
  options: AuthorizationMetadataRetryOptions = {}
): Promise<AuthorizationServerMetadata> {
  const attempts = options.attempts ?? 12;
  const initialDelayMs = options.initialDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const sleep = options.sleep ?? wait;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new Error("OAuth metadata retry attempts must be an integer from 1 to 100");
  }
  if (
    !Number.isFinite(initialDelayMs) ||
    initialDelayMs < 0 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < initialDelayMs
  ) {
    throw new Error("OAuth metadata retry delays are invalid");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchAndValidateAuthorizationServerMetadata(config, fetcher);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
