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
