import { z } from "zod";
import { AUTHORIZATION_RESOURCE_SCOPES } from "./config.js";

export class ClientRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientRegistrationError";
  }
}

const allowedProperties = new Set([
  "redirect_uris",
  "token_endpoint_auth_method",
  "grant_types",
  "response_types",
  "application_type",
  "client_name",
  "client_uri",
  "contacts",
  "logo_uri",
  "policy_uri",
  "tos_uri",
  "scope",
  "id_token_signed_response_alg",
]);

const unsupportedStandardProperties = new Set([
  "jwks",
  "jwks_uri",
  "token_endpoint_auth_signing_alg",
  "request_object_signing_alg",
  "request_object_encryption_alg",
  "request_object_encryption_enc",
  "userinfo_signed_response_alg",
  "userinfo_encrypted_response_alg",
  "userinfo_encrypted_response_enc",
  "id_token_encrypted_response_alg",
  "id_token_encrypted_response_enc",
]);

const httpsUrl = z.string().url().max(2048).refine((raw) => {
  const url = new URL(raw);
  return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443");
}, "must be an HTTPS URL without credentials or a non-standard port");

const metadataSchema = z
  .object({
    redirect_uris: z.array(z.string().url().max(2048)).min(1).max(5),
    token_endpoint_auth_method: z.literal("none").optional(),
    grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).min(1).max(2).optional(),
    response_types: z.array(z.literal("code")).length(1).optional(),
    application_type: z.enum(["web", "native"]).optional(),
    client_name: z.string().trim().min(1).max(128).optional(),
    client_uri: httpsUrl.optional(),
    contacts: z.array(z.string().email().max(254)).max(5).optional(),
    logo_uri: httpsUrl.optional(),
    policy_uri: httpsUrl.optional(),
    tos_uri: httpsUrl.optional(),
    scope: z.string().max(1024).optional(),
    id_token_signed_response_alg: z.literal("RS256").optional(),
  })
  .passthrough();

function isChatGptCallback(raw: string): boolean {
  const url = new URL(raw);
  return (
    url.protocol === "https:" &&
    url.hostname === "chatgpt.com" &&
    (!url.port || url.port === "443") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/connector\/oauth\/[A-Za-z0-9._~-]{1,256}$/.test(url.pathname)
  );
}

function isCodexLoopbackCallback(raw: string): boolean {
  const url = new URL(raw);
  const port = Number(url.port);
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65_535 &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/callback\/[A-Za-z0-9_-]{12}$/.test(url.pathname)
  );
}

export function isSupportedCallback(raw: string): boolean {
  return isChatGptCallback(raw) || isCodexLoopbackCallback(raw);
}

export function validateDynamicClientRegistration(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ClientRegistrationError("registration body must be a JSON object");
  }
  const keys = Object.keys(body);
  const forbidden = keys.find(
    (key) => key === "__proto__" || key === "prototype" || key === "constructor"
  );
  if (forbidden) {
    throw new ClientRegistrationError(`registration metadata contains forbidden property ${forbidden}`);
  }
  const unsupported = keys.filter((key) => !allowedProperties.has(key));
  if (unsupported.length > 0) {
    throw new ClientRegistrationError(
      `unsupported registration metadata: ${unsupported.sort().join(", ")}`
    );
  }

  const result = metadataSchema.safeParse(body);
  if (!result.success) {
    throw new ClientRegistrationError(result.error.issues[0]?.message ?? "invalid client metadata");
  }
  const metadata = result.data;
  if (!metadata.redirect_uris.every(isSupportedCallback)) {
    throw new ClientRegistrationError(
      "redirect_uris must use a supported ChatGPT or Codex callback"
    );
  }
  const applicationType = metadata.application_type ?? "web";
  const callbacksMatchApplicationType = applicationType === "native"
    ? metadata.redirect_uris.every(isCodexLoopbackCallback)
    : metadata.redirect_uris.every(isChatGptCallback);
  if (!callbacksMatchApplicationType) {
    throw new ClientRegistrationError(
      `${applicationType} clients must use the matching supported callback type`
    );
  }

  const grantTypes = [...new Set(metadata.grant_types ?? ["authorization_code", "refresh_token"])]
    .sort();
  if (!grantTypes.includes("authorization_code")) {
    throw new ClientRegistrationError("grant_types must include authorization_code");
  }
  const tokenMethod = metadata.token_endpoint_auth_method ?? "none";

  if (metadata.scope) {
    const allowedScopes = new Set([
      "openid",
      "email",
      "profile",
      "offline_access",
      ...AUTHORIZATION_RESOURCE_SCOPES,
    ]);
    const scopes = metadata.scope.split(/\s+/).filter(Boolean);
    const unknownScopes = scopes.filter((scope) => !allowedScopes.has(scope));
    if (unknownScopes.length > 0) {
      throw new ClientRegistrationError(`unsupported client scopes: ${unknownScopes.join(", ")}`);
    }
  }

  return {
    ...metadata,
    token_endpoint_auth_method: tokenMethod,
    grant_types: grantTypes,
    response_types: ["code"],
    application_type: applicationType,
  };
}

export function enforceRegisteredClientMetadata(metadata: Record<string, unknown>): void {
  for (const key of unsupportedStandardProperties) {
    delete metadata[key];
  }
  const policyInput = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => allowedProperties.has(key))
  );
  const normalized = validateDynamicClientRegistration(policyInput);
  Object.assign(metadata, normalized);
}

/**
 * CIMD（OAuth Client ID Metadata Document, draft-02）：client_id 直接是客户端自托管的
 * HTTPS 元数据文档地址，授权时按需抓取、不落库。OpenAI 对 ChatGPT 与 Codex 两个 surface
 * 都以 CIMD 为首选、DCR 只作兜底，所以两套策略必须并存而不是互相替代：上面那套 DCR 策略
 * 套不到 CIMD 上——CIMD 文档里登记的 loopback 回调不带端口（Codex 每次监听随机端口，
 * 按 RFC 8252 匹配时忽略端口），而 DCR 提交上来的带端口。
 */
export interface ClientIdMetadataPolicy {
  hosts: readonly string[];
  allowPrivateKeyJwt: boolean;
}

const LOOPBACK_CALLBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// 路径只做结构约束，不写死 /callback 或 /connector/oauth/<id>：这些是 OpenAI 侧的实现
// 细节（ChatGPT 已经从 /connector/oauth/<id> 换到 /connector_platform_oauth_redirect），
// 信任锚点是「文档来自白名单主机」而不是某一个具体路径。
const SAFE_PATH = /^(?:\/[A-Za-z0-9._~-]{1,64}){1,6}$/;

function safeUrl(raw: unknown): URL | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  return url;
}

/**
 * 判断一个 client_id 是否走的 CIMD 路径。CIMD 的 client_id 一定是 https URL；DCR 的
 * client_id 由本服务生成（oidc-provider 在注册响应里用生成值覆盖客户端提交的同名字段），
 * 所以这个判据不会被外部请求污染，可以安全地用来分派两套策略。
 */
export function isClientIdMetadataDocumentId(clientId: unknown): boolean {
  return safeUrl(clientId)?.protocol === "https:";
}

/** 抓取前与建客户端后的同一道闸：只信白名单主机上的 https 文档。 */
export function isAllowedClientIdMetadataUrl(
  clientId: unknown,
  policy: ClientIdMetadataPolicy
): boolean {
  const url = safeUrl(clientId);
  return (
    url !== undefined &&
    url.protocol === "https:" &&
    (!url.port || url.port === "443") &&
    policy.hosts.includes(url.hostname.toLowerCase()) &&
    SAFE_PATH.test(url.pathname)
  );
}

function isLoopbackCallback(raw: unknown): boolean {
  const url = safeUrl(raw);
  if (!url) return false;
  const port = url.port === "" ? undefined : Number(url.port);
  return (
    url.protocol === "http:" &&
    LOOPBACK_CALLBACK_HOSTS.has(url.hostname) &&
    (port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65_535)) &&
    SAFE_PATH.test(url.pathname)
  );
}

export type SupportedCallbackKind = "chatgpt" | "codex_loopback";

/**
 * 判定授权请求上的 redirect_uri 属于哪一种受支持的回调。交互页要用回调 origin 收紧
 * form-action，形状不认识就必须拒。DCR 与 CIMD 两套形状都要认：CIMD 文档登记的 loopback
 * 回调既不带端口、也不一定带 callback id（Codex 用稳定客户端文档时就是
 * http://127.0.0.1/callback）。policy 缺省表示 CIMD 关闭，此时只认 DCR 那套形状。
 */
export function classifyCallback(
  raw: string,
  policy?: ClientIdMetadataPolicy
): SupportedCallbackKind | undefined {
  if (safeUrl(raw) === undefined) return undefined;
  if (isCodexLoopbackCallback(raw) || (policy !== undefined && isLoopbackCallback(raw))) {
    return "codex_loopback";
  }
  if (isChatGptCallback(raw) || (policy !== undefined && isAllowedClientIdMetadataUrl(raw, policy))) {
    return "chatgpt";
  }
  return undefined;
}

/**
 * CIMD 客户端的策略校验。只管本服务自己的取舍（文档主机、客户端认证方式、认证公钥来源、
 * 回调形状）；grant_types / response_types / native 客户端只能用 loopback http 这类
 * 协议通用约束由 oidc-provider 的 client schema 负责，重复实现只会让两处发散。
 */
export function enforceClientIdMetadataDocument(
  metadata: Record<string, unknown>,
  policy: ClientIdMetadataPolicy
): void {
  if (!isAllowedClientIdMetadataUrl(metadata.client_id, policy)) {
    throw new ClientRegistrationError(
      "client_id metadata documents are only accepted from allowed hosts"
    );
  }

  const authMethod =
    typeof metadata.token_endpoint_auth_method === "string"
      ? metadata.token_endpoint_auth_method
      : "none";
  const allowedAuthMethods = policy.allowPrivateKeyJwt
    ? ["none", "private_key_jwt"]
    : ["none"];
  if (!allowedAuthMethods.includes(authMethod)) {
    throw new ClientRegistrationError(
      `client_id metadata document token endpoint auth method ${authMethod} is not accepted`
    );
  }
  if (authMethod === "private_key_jwt") {
    // 只接受白名单主机上的 jwks_uri：内联 jwks 无法轮换，而任意主机的 jwks_uri 等于把
    // 客户端认证的信任根外包给未知第三方。
    if (metadata.jwks !== undefined) {
      throw new ClientRegistrationError("client_id metadata document must not inline jwks");
    }
    if (!isAllowedClientIdMetadataUrl(metadata.jwks_uri, policy)) {
      throw new ClientRegistrationError(
        "client_id metadata document jwks_uri is not on an allowed host"
      );
    }
  } else if (metadata.jwks !== undefined || metadata.jwks_uri !== undefined) {
    throw new ClientRegistrationError(
      "a public client_id metadata document must not declare client authentication keys"
    );
  }

  const redirectUris = metadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 8) {
    throw new ClientRegistrationError(
      "client_id metadata document must declare 1 to 8 redirect_uris"
    );
  }
  const applicationType = metadata.application_type === "native" ? "native" : "web";
  const acceptable =
    applicationType === "native"
      ? (uri: unknown) => isLoopbackCallback(uri)
      : (uri: unknown) => isAllowedClientIdMetadataUrl(uri, policy);
  if (!redirectUris.every((uri) => acceptable(uri))) {
    throw new ClientRegistrationError(
      `a ${applicationType} client_id metadata document must only declare matching callbacks`
    );
  }

  if (typeof metadata.scope === "string" && metadata.scope.length > 0) {
    const allowedScopes = new Set([
      "openid",
      "email",
      "profile",
      "offline_access",
      ...AUTHORIZATION_RESOURCE_SCOPES,
    ]);
    const unknownScopes = metadata.scope
      .split(/\s+/)
      .filter(Boolean)
      .filter((scope) => !allowedScopes.has(scope));
    if (unknownScopes.length > 0) {
      throw new ClientRegistrationError(`unsupported client scopes: ${unknownScopes.join(", ")}`);
    }
  }
}
