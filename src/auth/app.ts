import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Server as NodeHttpServer } from "node:http";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import Provider, {
  errors,
  type Configuration,
  type AdapterFactory,
  type Grant,
  type Interaction,
  type KoaContextWithOIDC,
  type UnknownObject,
} from "oidc-provider";
import { z } from "zod";
import {
  AUTHORIZATION_RESOURCE_SCOPES,
  type AuthorizationServerConfig,
  type AuthorizationUser,
} from "./config.js";
import type {
  FederatedAccount,
  FederatedIdentityStore,
} from "./federated-store.js";
import type { UpstreamIdentityClient } from "./upstream-oidc.js";
import {
  enforceRegisteredClientMetadata,
} from "./client-registration.js";
import { isExactAllowedHost } from "../http/host-validation.js";
import { verifyPassword } from "./password.js";
import type { LinkedAtlasCredentialStore } from "../services/linked-credential-store.js";
import type { AtlasCredentialValidator } from "../services/credential-validation.js";
import {
  AUTH_STYLES,
  renderAuthorizationRecovery,
  renderConsent,
  renderCredentialLink,
  renderLogin,
  renderUnsupportedPrompt,
} from "./views.js";

const CSRF_COOKIE_SECURE = "__Secure-atlascloud_csrf";
const CSRF_COOKIE_LOCAL = "atlascloud_csrf";
const LOGIN_COMPLETION_COOKIE_SECURE = "__Secure-atlascloud_login_completion";
const LOGIN_COMPLETION_COOKIE_LOCAL = "atlascloud_login_completion";
const SESSION_COOKIE_SECURE = "__Host-atlascloud_op_v2";
const SESSION_COOKIE_LOCAL = "atlascloud_op_v2";
const LEGACY_SESSION_COOKIE_SECURE = "__Host-atlascloud_op";
const LEGACY_SESSION_COOKIE_LOCAL = "atlascloud_op";
const oneTimeTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const formSchema = z
  .object({
    csrf_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    interaction_uid: z.string().min(1).max(256),
  })
  .passthrough();
const loginSchema = formSchema.extend({
  email: z.string().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(1024),
});
const consentSchema = formSchema.extend({ decision: z.enum(["allow", "deny"]) });
const upstreamCallbackSchema = z
  .object({
    code: z.string().min(1).max(4096),
    state: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    iss: z.string().url().optional(),
    session_state: z.string().min(1).max(4096).optional(),
  })
  .strict();
const credentialLinkSchema = formSchema.extend({
  link_ticket: oneTimeTokenSchema,
  atlas_api_key: z.string().min(16).max(4096),
});

export interface AuthorizationStore {
  adapter: AdapterFactory;
  ready(): Promise<boolean>;
}

export interface AuthorizationAppDependencies {
  federatedStore?: FederatedIdentityStore;
  credentialStore?: LinkedAtlasCredentialStore;
  upstreamClient?: UpstreamIdentityClient;
  validateAtlasCredential?: AtlasCredentialValidator;
  auditLogger?: AuthorizationAuditLogger;
}

export type AuthorizationAuditEvent =
  | {
      event: "oidc_grant_error";
      error: string;
      reason: OidcGrantErrorReason;
      status: number;
      grant_type: string;
      client_hash: string;
    }
  | {
      event: "oidc_refresh_success";
      grant_type: "refresh_token";
      client_hash: string;
      rotations: number;
    }
  | {
      event: "authorization_request_error";
      method: string;
      route: string;
      reason: AuthorizationRequestErrorReason;
      status: number;
    };

export type AuthorizationAuditLogger = (event: AuthorizationAuditEvent) => void;

type OidcGrantErrorReason =
  | "refresh_token_replay"
  | "expired_grant"
  | "client_mismatch"
  | "sender_constraint_failed"
  | "invalid_or_missing_grant"
  | "other";

type AuthorizationRequestErrorReason =
  | "interaction_cookie_missing"
  | "interaction_session_missing"
  | "authentication_session_missing"
  | "session_principal_changed"
  | "session_mismatch"
  | "consent_form_invalid"
  | "csrf_invalid"
  | "invalid_request"
  | "other";

interface FederatedRuntime {
  federatedStore: FederatedIdentityStore;
  credentialStore: LinkedAtlasCredentialStore;
  upstreamClient: UpstreamIdentityClient;
  validateAtlasCredential: AtlasCredentialValidator;
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function shortDigest(value: string | undefined): string {
  return value
    ? createHash("sha256").update(value).digest("hex").slice(0, 16)
    : "unknown";
}

function grantType(ctx: KoaContextWithOIDC): string {
  const value = ctx.oidc.params?.grant_type;
  return typeof value === "string" ? value : "unknown";
}

function classifyGrantError(error: errors.OIDCProviderError): OidcGrantErrorReason {
  const description = `${error.error_description ?? ""} ${error.error_detail ?? ""} ${error.message}`
    .toLowerCase();
  if (description.includes("refresh token already used")) return "refresh_token_replay";
  if (description.includes("expired")) return "expired_grant";
  if (description.includes("client mismatch")) return "client_mismatch";
  if (
    description.includes("dpop")
    || description.includes("jkt verification")
    || description.includes("x5t#s256")
    || description.includes("mutual tls")
  ) return "sender_constraint_failed";
  if (error.error === "invalid_grant") return "invalid_or_missing_grant";
  return "other";
}

function classifyAuthorizationRequestError(error: unknown): AuthorizationRequestErrorReason {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof errors.SessionNotFound) {
    if (message === "interaction session id cookie not found") {
      return "interaction_cookie_missing";
    }
    if (
      message === "interaction session not found"
      || message === "authorization request has expired"
    ) {
      return "interaction_session_missing";
    }
    if (message === "session not found") return "authentication_session_missing";
    if (message === "session principal changed") return "session_principal_changed";
    return "session_mismatch";
  }
  if (message === "invalid consent form") return "consent_form_invalid";
  if (message === "invalid or expired interaction CSRF token") return "csrf_invalid";
  if (error instanceof errors.InvalidRequest) return "invalid_request";
  return "other";
}

function authorizationAuditRoute(path: string): string {
  if (/^\/interaction\/[^/]+$/.test(path)) return "/interaction/:uid";
  if (/^\/interaction\/[^/]+\/(?:login|link|confirm|complete)$/.test(path)) {
    return path.replace(/^\/interaction\/[^/]+/, "/interaction/:uid");
  }
  if (/^\/auth\/[^/]+$/.test(path)) return "/auth/:uid";
  if (path === "/auth" || path === "/upstream/callback") return path;
  return "other";
}

function writeAudit(logger: AuthorizationAuditLogger, event: AuthorizationAuditEvent): void {
  try {
    logger(event);
  } catch {
    console.error(JSON.stringify({ event: "oidc_audit_logger_failure" }));
  }
}

function defaultAuditLogger(event: AuthorizationAuditEvent): void {
  console.error(JSON.stringify(event));
}

function cookieValue(request: Request, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

function equalTokens(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function csrfCookieName(config: AuthorizationServerConfig): string {
  return config.issuer.protocol === "https:" ? CSRF_COOKIE_SECURE : CSRF_COOKIE_LOCAL;
}

function sessionCookieName(config: AuthorizationServerConfig): string {
  return config.issuer.protocol === "https:" ? SESSION_COOKIE_SECURE : SESSION_COOKIE_LOCAL;
}

function legacySessionCookieName(config: AuthorizationServerConfig): string {
  return config.issuer.protocol === "https:"
    ? LEGACY_SESSION_COOKIE_SECURE
    : LEGACY_SESSION_COOKIE_LOCAL;
}

function clearLegacySessionCookie(
  config: AuthorizationServerConfig,
  response: Response
): void {
  response.clearCookie(legacySessionCookieName(config), {
    secure: config.issuer.protocol === "https:",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
}

function interactionPath(interactionUid: string): string {
  return `/interaction/${encodeURIComponent(interactionUid)}`;
}

function loginCompletionCookieName(config: AuthorizationServerConfig): string {
  return config.issuer.protocol === "https:"
    ? LOGIN_COMPLETION_COOKIE_SECURE
    : LOGIN_COMPLETION_COOKIE_LOCAL;
}

function loginCompletionCookieOptions(
  config: AuthorizationServerConfig,
  interactionUid: string
) {
  return {
    secure: config.issuer.protocol === "https:",
    httpOnly: true,
    sameSite: "lax" as const,
    path: interactionPath(interactionUid),
  };
}

function issueLoginCompletionCookie(
  config: AuthorizationServerConfig,
  response: Response,
  interactionUid: string,
  ticket: string
): void {
  response.cookie(
    loginCompletionCookieName(config),
    ticket,
    {
      ...loginCompletionCookieOptions(config, interactionUid),
      maxAge: 10 * 60 * 1000,
    }
  );
}

function clearLoginCompletionCookie(
  config: AuthorizationServerConfig,
  response: Response,
  interactionUid: string
): void {
  response.clearCookie(
    loginCompletionCookieName(config),
    loginCompletionCookieOptions(config, interactionUid)
  );
}

function issueCsrfToken(
  config: AuthorizationServerConfig,
  response: Response,
  interactionUid: string
): string {
  const token = randomBytes(32).toString("base64url");
  response.cookie(csrfCookieName(config), token, {
    secure: config.issuer.protocol === "https:",
    httpOnly: true,
    sameSite: "lax",
    path: interactionPath(interactionUid),
    maxAge: 10 * 60 * 1000,
  });
  return token;
}

function assertCsrf(
  config: AuthorizationServerConfig,
  request: Request,
  interaction: Interaction,
  form: { csrf_token: string; interaction_uid: string }
): void {
  if (
    form.interaction_uid !== interaction.uid ||
    !equalTokens(cookieValue(request, csrfCookieName(config)), form.csrf_token)
  ) {
    throw new errors.InvalidRequest("invalid or expired interaction CSRF token");
  }
}

function securityHeaders(config: AuthorizationServerConfig) {
  return (_request: Request, response: Response, next: NextFunction): void => {
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (config.nodeEnv === "production") {
      response.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    }
    next();
  };
}

function exactHost(config: AuthorizationServerConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const rawHost = request.headers.host;
    if (!rawHost) {
      response.status(400).json({ error: "invalid_request", error_description: "Host header is required" });
      return;
    }
    if (!isExactAllowedHost(rawHost, config.allowedHosts, config.nodeEnv)) {
      response.status(421).json({ error: "misdirected_request" });
      return;
    }
    next();
  };
}

function userForSubject(config: AuthorizationServerConfig, subject: string): AuthorizationUser | undefined {
  return config.users.find((user) => user.sub === subject);
}

async function accountForSubject(
  config: AuthorizationServerConfig,
  federatedStore: FederatedIdentityStore | undefined,
  subject: string
): Promise<AuthorizationUser | FederatedAccount | undefined> {
  return config.identityMode === "local-reviewer"
    ? userForSubject(config, subject)
    : federatedStore?.getAccount(subject);
}

function requireFederatedRuntime(
  config: AuthorizationServerConfig,
  dependencies: AuthorizationAppDependencies
): FederatedRuntime | undefined {
  if (config.identityMode !== "upstream-oidc") return undefined;
  if (!config.upstream) {
    throw new Error("Upstream OIDC mode requires an upstream provider configuration");
  }
  if (
    !dependencies.federatedStore ||
    !dependencies.credentialStore ||
    !dependencies.upstreamClient ||
    !dependencies.validateAtlasCredential
  ) {
    throw new Error("Upstream OIDC mode requires identity, credential, OIDC, and validation services");
  }
  return {
    federatedStore: dependencies.federatedStore,
    credentialStore: dependencies.credentialStore,
    upstreamClient: dependencies.upstreamClient,
    validateAtlasCredential: dependencies.validateAtlasCredential,
  };
}

function stringParam(params: UnknownObject, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function publicVerificationJwks(config: AuthorizationServerConfig) {
  const keys = config.jwks.keys.map((key) => {
    const publicKey = { ...key } as Record<string, unknown>;
    for (const privateField of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const) {
      delete publicKey[privateField];
    }
    return publicKey as JWK;
  });
  return createLocalJWKSet({ keys });
}

function resourceUserinfo(
  config: AuthorizationServerConfig,
  provider: Provider,
  federatedStore?: FederatedIdentityStore
) {
  const verificationJwks = publicVerificationJwks(config);
  const issuer = config.issuer.toString().replace(/\/$/, "");
  const audience = config.resource.toString();

  return async (request: Request, response: Response): Promise<void> => {
    noStore(response);
    const match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
    if (!match) {
      response.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      response.status(401).json({ error: "invalid_token" });
      return;
    }

    try {
      const { payload } = await jwtVerify(match[1], verificationJwks, {
        issuer,
        audience,
        algorithms: ["RS256"],
        typ: "at+jwt",
        clockTolerance: 30,
        requiredClaims: ["sub", "client_id", "scope", "iat", "exp"],
      });
      const subject = payload.sub;
      const clientId = payload.client_id;
      const grantId = payload.grant_id;
      if (
        typeof subject !== "string" ||
        typeof clientId !== "string" ||
        typeof grantId !== "string" ||
        !(await provider.Client.find(clientId))
      ) {
        throw new Error("resource token is not eligible for UserInfo");
      }
      const grant = await provider.Grant.find(grantId);
      if (
        !grant ||
        grant.clientId !== clientId ||
        grant.accountId !== subject
      ) {
        throw new Error("resource token grant is inactive or mismatched");
      }
      const scope = new Set(grant.getOIDCScope().split(" ").filter(Boolean));
      if (!scope.has("openid")) {
        throw new Error("resource token grant lacks the openid scope");
      }
      const user = await accountForSubject(config, federatedStore, subject);
      if (!user) throw new Error("resource token subject is unknown");

      const claims: Record<string, unknown> = { sub: user.sub };
      if (scope.has("email")) {
        claims.email = user.email;
        claims.email_verified = true;
      }
      if (scope.has("profile")) claims.name = user.name;
      response.status(200).json(claims);
    } catch {
      response.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      response.status(401).json({ error: "invalid_token" });
    }
  };
}

function providerConfiguration(
  config: AuthorizationServerConfig,
  store: AuthorizationStore,
  federatedStore?: FederatedIdentityStore
): Configuration {
  // oidc-provider path-scopes interaction and resume cookies to each generated
  // authorization flow. `__Host-` would require Path=/ and collapse those
  // independent cookies into one browser-global value, so short-lived cookies
  // use `__Secure-` while the long-lived session remains `__Host-`.
  const scopedCookiePrefix = config.issuer.protocol === "https:" ? "__Secure-" : "";
  return {
    adapter: store.adapter,
    clients: [],
    clientAuthMethods: ["none"],
    clientDefaults: {
      application_type: "web",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      id_token_signed_response_alg: "RS256",
    },
    claims: {
      openid: ["sub"],
      email: ["email", "email_verified"],
      profile: ["name"],
    },
    clockTolerance: 30,
    cookies: {
      names: {
        session: sessionCookieName(config),
        interaction: `${scopedCookiePrefix}atlascloud_interaction`,
        resume: `${scopedCookiePrefix}atlascloud_resume`,
        state: `${scopedCookiePrefix}atlascloud_state`,
      },
      keys: config.cookieKeys,
      long: {
        secure: config.issuer.protocol === "https:",
        httpOnly: true,
        sameSite: "lax",
        signed: true,
        path: "/",
      },
      short: {
        secure: config.issuer.protocol === "https:",
        httpOnly: true,
        sameSite: "lax",
        signed: true,
      },
    },
    enabledJWA: {
      idTokenSigningAlgValues: ["RS256"],
    },
    extraClientMetadata: {
      properties: ["urn:atlascloud:dcr-policy"],
      validator: (_ctx, _key, _value, metadata) => {
        try {
          enforceRegisteredClientMetadata(metadata);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid client metadata";
          throw new errors.InvalidClientMetadata(message);
        }
      },
    },
    features: {
      devInteractions: { enabled: false },
      registration: {
        enabled: true,
        initialAccessToken: false,
        issueRegistrationAccessToken: false,
      },
      registrationManagement: { enabled: false },
      revocation: { enabled: true },
      userinfo: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => config.resource.toString(),
        useGrantedResource: async () => true,
        getResourceServerInfo: async (_ctx, resourceIndicator) => {
          if (resourceIndicator !== config.resource.toString()) {
            throw new errors.InvalidTarget("unsupported resource indicator");
          }
          return {
            scope: AUTHORIZATION_RESOURCE_SCOPES.join(" "),
            audience: config.resource.toString(),
            accessTokenTTL: config.accessTokenTtlSeconds,
            accessTokenFormat: "jwt",
            jwt: { sign: { alg: "RS256" }, encrypt: false },
          };
        },
      },
    },
    findAccount: async (_ctx, subject) => {
      const user = await accountForSubject(config, federatedStore, subject);
      if (!user) return undefined;
      return {
        accountId: user.sub,
        async claims() {
          return {
            sub: user.sub,
            email: user.email,
            email_verified: true,
            name: user.name,
          };
        },
      };
    },
    formats: {
      bitsOfOpaqueRandomness: 256,
    },
    extraTokenClaims: async (_ctx, token) => ({
      client_id: token.clientId,
      ...(token instanceof Object && "grantId" in token && typeof token.grantId === "string"
        ? { grant_id: token.grantId }
        : {}),
    }),
    interactions: {
      url: async (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    jwks: config.jwks,
    pkce: { required: () => true },
    responseTypes: ["code"],
    rotateRefreshToken: true,
    scopes: ["openid", "email", "profile", "offline_access", ...AUTHORIZATION_RESOURCE_SCOPES],
    subjectTypes: ["public"],
    ttl: {
      AccessToken: config.accessTokenTtlSeconds,
      AuthorizationCode: 60,
      Grant: config.grantTtlSeconds,
      IdToken: 10 * 60,
      Interaction: 10 * 60,
      RefreshToken: config.refreshTokenTtlSeconds,
      Session: 8 * 60 * 60,
    },
    acceptQueryParamAccessTokens: false,
    allowOmittingSingleRegisteredRedirectUri: false,
  };
}

async function grantConsent(provider: Provider, interaction: Interaction): Promise<string> {
  const accountId = interaction.session?.accountId;
  const clientId = stringParam(interaction.params, "client_id");
  if (!accountId || !clientId) {
    throw new errors.InvalidRequest("authorization session is missing account or client identity");
  }

  let grant: Grant | undefined;
  let grantId = interaction.grantId;
  if (grantId) grant = await provider.Grant.find(grantId);
  if (!grant) {
    grant = new provider.Grant({ accountId, clientId });
  }

  const details = interaction.prompt.details;
  const missingOidcScopes = details.missingOIDCScope;
  if (Array.isArray(missingOidcScopes)) {
    const scopes = missingOidcScopes.filter((scope): scope is string => typeof scope === "string");
    if (scopes.length > 0) grant.addOIDCScope(scopes.join(" "));
  }
  const missingClaims = details.missingOIDCClaims;
  if (Array.isArray(missingClaims)) {
    const claims = missingClaims.filter((claim): claim is string => typeof claim === "string");
    if (claims.length > 0) grant.addOIDCClaims(claims);
  }
  const missingResourceScopes = details.missingResourceScopes;
  if (missingResourceScopes && typeof missingResourceScopes === "object" && !Array.isArray(missingResourceScopes)) {
    for (const [resource, rawScopes] of Object.entries(missingResourceScopes)) {
      if (!Array.isArray(rawScopes)) continue;
      const scopes = rawScopes.filter((scope): scope is string => typeof scope === "string");
      if (scopes.length > 0) grant.addResourceScope(resource, scopes.join(" "));
    }
  }
  grantId = await grant.save();
  return grantId;
}

async function finishFederatedLogin(
  provider: Provider,
  request: Request,
  response: Response,
  subject: string
): Promise<void> {
  await provider.interactionFinished(
    request,
    response,
    {
      login: {
        accountId: subject,
        acr: "urn:atlascloud:loa:federated-oidc+api-key",
        amr: ["federated", "api_key"],
        remember: false,
      },
    },
    { mergeWithLastSubmission: false }
  );
}

export function createAuthorizationApp(
  config: AuthorizationServerConfig,
  store: AuthorizationStore,
  dependencies: AuthorizationAppDependencies = {}
): { app: Express; provider: Provider } {
  const federated = requireFederatedRuntime(config, dependencies);
  const provider = new Provider(
    config.issuer.toString().replace(/\/$/, ""),
    providerConfiguration(config, store, federated?.federatedStore)
  );
  provider.proxy = Boolean(config.trustProxy);
  const auditLogger = dependencies.auditLogger ?? defaultAuditLogger;
  provider.on("grant.error", (ctx, error) => {
    writeAudit(auditLogger, {
      event: "oidc_grant_error",
      error: error.error,
      reason: classifyGrantError(error),
      status: error.statusCode,
      grant_type: grantType(ctx),
      client_hash: shortDigest(ctx.oidc.client?.clientId),
    });
  });
  provider.on("grant.success", (ctx) => {
    if (grantType(ctx) !== "refresh_token") return;
    writeAudit(auditLogger, {
      event: "oidc_refresh_success",
      grant_type: "refresh_token",
      client_hash: shortDigest(ctx.oidc.client?.clientId),
      rotations: ctx.oidc.entities.RefreshToken?.rotations ?? 0,
    });
  });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(securityHeaders(config));
  app.use(exactHost(config));
  app.use((request, response, next) => {
    if (request.path === "/auth" || request.path.startsWith("/auth/")) {
      clearLegacySessionCookie(config, response);
    }
    next();
  });

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok", service: "atlascloud-oauth" });
  });
  app.get("/readyz", async (_request, response) => {
    const checks = await Promise.all([
      store.ready().catch(() => false),
      federated?.credentialStore.ready().catch(() => false) ?? Promise.resolve(true),
      federated?.upstreamClient.ready().catch(() => false) ?? Promise.resolve(true),
    ]);
    const ready = checks.every(Boolean);
    response.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready" });
  });
  app.get("/assets/auth.css", (_request, response) => {
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.type("text/css").send(AUTH_STYLES);
  });

  const registrationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: config.registrationRequestsPerHour,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_request, response) => {
      response.status(429).json({ error: "temporarily_unavailable", error_description: "registration rate limit exceeded" });
    },
  });
  app.post(
    "/reg",
    registrationLimiter
  );

  const interactionParser = express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 16 });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.loginAttemptsPer15Minutes,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });

  app.get("/interaction/:uid", async (request, response) => {
    noStore(response);
    const interaction = await provider.interactionDetails(request, response);
    if (interaction.uid !== request.params.uid) {
      response.status(400).type("html").send(renderUnsupportedPrompt());
      return;
    }
    if (interaction.prompt.name === "login") {
      if (federated) {
        const state = randomBytes(32).toString("base64url");
        const nonce = randomBytes(32).toString("base64url");
        const codeVerifier = randomBytes(32).toString("base64url");
        await federated.federatedStore.beginUpstreamAuthorization(
          state,
          { interactionUid: interaction.uid, nonce, codeVerifier },
          10 * 60
        );
        response.redirect(303, federated.upstreamClient.authorizationUrl({
          state,
          nonce,
          codeVerifier,
        }).toString());
        return;
      }
      const csrfToken = issueCsrfToken(config, response, interaction.uid);
      response.status(200).type("html").send(renderLogin(interaction, csrfToken));
      return;
    }
    if (interaction.prompt.name === "consent") {
      const csrfToken = issueCsrfToken(config, response, interaction.uid);
      response.status(200).type("html").send(renderConsent(interaction, csrfToken));
      return;
    }
    response.status(400).type("html").send(renderUnsupportedPrompt());
  });

  app.post(
    "/interaction/:uid/login",
    loginLimiter,
    interactionParser,
    async (request, response) => {
      noStore(response);
      if (config.identityMode !== "local-reviewer") {
        throw new errors.InvalidRequest("local password login is disabled");
      }
      const interaction = await provider.interactionDetails(request, response);
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.interaction_uid !== request.params.uid) {
        throw new errors.InvalidRequest("invalid login form");
      }
      assertCsrf(config, request, interaction, parsed.data);
      const user = config.users.find((candidate) => candidate.email === parsed.data.email);
      const comparisonHash = user?.passwordHash ?? config.users[0].passwordHash;
      const passwordMatches = await verifyPassword(parsed.data.password, comparisonHash);
      if (!user || !passwordMatches) {
        const csrfToken = issueCsrfToken(config, response, interaction.uid);
        response.status(401).type("html").send(
          renderLogin(interaction, csrfToken, "Email or password is incorrect.")
        );
        return;
      }
      await provider.interactionFinished(
        request,
        response,
        { login: { accountId: user.sub, acr: "urn:atlascloud:loa:password", amr: ["pwd"], remember: false } },
        { mergeWithLastSubmission: false }
      );
    }
  );

  app.get("/upstream/callback", async (request, response) => {
    noStore(response);
    if (!federated) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    const rawState = oneTimeTokenSchema.safeParse(request.query.state);
    if (!rawState.success) {
      throw new errors.InvalidRequest("invalid upstream OIDC callback state");
    }
    const pending = await federated.federatedStore.consumeUpstreamAuthorization(rawState.data);
    if (!pending) {
      throw new errors.InvalidRequest("upstream OIDC callback state is expired or already used");
    }
    const parsed = upstreamCallbackSchema.safeParse(request.query);
    if (!parsed.success) {
      throw new errors.InvalidRequest("upstream OIDC authorization did not return a valid code");
    }
    if (
      parsed.data.iss &&
      parsed.data.iss.replace(/\/$/, "") !== config.upstream!.issuer.toString().replace(/\/$/, "")
    ) {
      throw new errors.InvalidRequest("upstream OIDC callback issuer does not match");
    }
    const interaction = await provider.Interaction.find(pending.interactionUid);
    if (
      !interaction ||
      !interaction.isValid ||
      interaction.isExpired ||
      interaction.uid !== pending.interactionUid ||
      interaction.prompt.name !== "login"
    ) {
      throw new errors.InvalidRequest("upstream OIDC callback does not match the active interaction");
    }
    const account = await federated.upstreamClient.exchangeCode({
      code: parsed.data.code,
      nonce: pending.nonce,
      codeVerifier: pending.codeVerifier,
    });
    await federated.federatedStore.putAccount(account);
    const existingCredential = await federated.credentialStore.get(account.sub);
    if (existingCredential) {
      const completionTicket = randomBytes(32).toString("base64url");
      await federated.federatedStore.beginLoginCompletion(
        completionTicket,
        { interactionUid: interaction.uid, subject: account.sub },
        10 * 60
      );
      issueLoginCompletionCookie(
        config,
        response,
        interaction.uid,
        completionTicket
      );
      response.redirect(303, `${interactionPath(interaction.uid)}/complete`);
      return;
    }
    const ticket = randomBytes(32).toString("base64url");
    await federated.federatedStore.beginCredentialLink(
      ticket,
      { interactionUid: interaction.uid, subject: account.sub },
      10 * 60
    );
    const csrfToken = issueCsrfToken(config, response, interaction.uid);
    response.status(200).type("html").send(
      renderCredentialLink(interaction, csrfToken, ticket, account.email)
    );
  });

  app.get("/interaction/:uid/complete", async (request, response) => {
    noStore(response);
    if (!federated) {
      throw new errors.InvalidRequest("federated login completion is disabled");
    }
    const interaction = await provider.interactionDetails(request, response);
    if (interaction.uid !== request.params.uid || interaction.prompt.name !== "login") {
      throw new errors.InvalidRequest("federated login completion does not match the active interaction");
    }
    const ticket = oneTimeTokenSchema.safeParse(
      cookieValue(request, loginCompletionCookieName(config))
    );
    clearLoginCompletionCookie(config, response, interaction.uid);
    if (!ticket.success) {
      throw new errors.InvalidRequest("federated login completion ticket is missing or invalid");
    }
    const completion = await federated.federatedStore.consumeLoginCompletion(ticket.data);
    if (
      !completion ||
      completion.interactionUid !== interaction.uid ||
      !(await federated.federatedStore.getAccount(completion.subject)) ||
      !(await federated.credentialStore.get(completion.subject))
    ) {
      throw new errors.InvalidRequest("federated login completion ticket is expired or already used");
    }
    await finishFederatedLogin(provider, request, response, completion.subject);
  });

  app.post(
    "/interaction/:uid/link",
    loginLimiter,
    interactionParser,
    async (request, response) => {
      noStore(response);
      if (!federated) {
        throw new errors.InvalidRequest("credential linking is disabled");
      }
      const interaction = await provider.interactionDetails(request, response);
      const parsed = credentialLinkSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.interaction_uid !== request.params.uid) {
        throw new errors.InvalidRequest("invalid credential-link form");
      }
      assertCsrf(config, request, interaction, parsed.data);
      const pending = await federated.federatedStore.getCredentialLink(
        parsed.data.link_ticket
      );
      if (
        !pending ||
        pending.interactionUid !== interaction.uid ||
        interaction.prompt.name !== "login"
      ) {
        throw new errors.InvalidRequest("credential-link ticket is expired or mismatched");
      }
      const account = await federated.federatedStore.getAccount(pending.subject);
      if (!account) throw new errors.InvalidRequest("federated account is unavailable");
      try {
        await federated.validateAtlasCredential(parsed.data.atlas_api_key);
      } catch {
        const csrfToken = issueCsrfToken(config, response, interaction.uid);
        response.status(401).type("html").send(
          renderCredentialLink(
            interaction,
            csrfToken,
            parsed.data.link_ticket,
            account.email,
            "The Atlas Cloud API key could not be verified. Check the key and try again."
          )
        );
        return;
      }
      const consumed = await federated.federatedStore.consumeCredentialLink(
        parsed.data.link_ticket
      );
      if (
        !consumed ||
        consumed.interactionUid !== pending.interactionUid ||
        consumed.subject !== pending.subject
      ) {
        throw new errors.InvalidRequest("credential-link ticket was already used");
      }
      await federated.credentialStore.put(account.sub, parsed.data.atlas_api_key);
      await finishFederatedLogin(provider, request, response, account.sub);
    }
  );

  app.post(
    "/interaction/:uid/confirm",
    interactionParser,
    async (request, response) => {
      noStore(response);
      const interaction = await provider.interactionDetails(request, response);
      const parsed = consentSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.interaction_uid !== request.params.uid) {
        throw new errors.InvalidRequest("invalid consent form");
      }
      assertCsrf(config, request, interaction, parsed.data);
      if (parsed.data.decision === "deny") {
        await provider.interactionFinished(
          request,
          response,
          { error: "access_denied", error_description: "The user denied the request" },
          { mergeWithLastSubmission: false }
        );
        return;
      }
      const grantId = await grantConsent(provider, interaction);
      await provider.interactionFinished(
        request,
        response,
        { consent: interaction.grantId ? {} : { grantId } },
        { mergeWithLastSubmission: true }
      );
    }
  );

  const userinfo = resourceUserinfo(config, provider, federated?.federatedStore);
  app.get("/me", userinfo);
  app.post("/me", userinfo);

  app.use(provider.callback());
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
    const isClientError = status >= 400 && status < 500;
    if (!response.headersSent) {
      const explicitlyAcceptsHtml = /(?:^|,)\s*text\/html(?:\s*;[^,]*)?(?:,|$)/i.test(
        request.headers.accept ?? ""
      );
      const isBrowserAuthorizationRequest = explicitlyAcceptsHtml && (
        request.path === "/auth"
        || request.path.startsWith("/auth/")
        || request.path.startsWith("/interaction/")
        || request.path === "/upstream/callback"
      );
      if (isClientError && isBrowserAuthorizationRequest) {
        writeAudit(auditLogger, {
          event: "authorization_request_error",
          method: request.method,
          route: authorizationAuditRoute(request.path),
          reason: classifyAuthorizationRequestError(error),
          status,
        });
        noStore(response);
        response.status(status).type("html").send(renderAuthorizationRecovery());
        return;
      }
      response.status(status).json({
        error: isClientError ? "invalid_request" : "server_error",
        error_description: isClientError
          ? "Authorization request is invalid or expired"
          : "Authorization server request failed",
      });
    }
  });

  return { app, provider };
}

export function listenAuthorizationApp(
  app: Express,
  config: AuthorizationServerConfig
): Promise<NodeHttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.listenHost, () => resolve(server));
    server.once("error", reject);
  });
}
