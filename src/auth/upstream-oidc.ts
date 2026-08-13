import { createHash, timingSafeEqual } from "node:crypto";
import {
  createRemoteJWKSet,
  jwtVerify,
} from "jose";
import { z } from "zod";
import type { UpstreamOidcConfig } from "./config.js";
import type { FederatedAccount } from "./federated-store.js";

const MAX_JSON_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const opaqueValue = z.string().min(1).max(4096);
const pkceValue = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);

const metadataSchema = z
  .object({
    issuer: z.string().url(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    jwks_uri: z.string().url(),
    response_types_supported: z.array(z.string()),
    scopes_supported: z.array(z.string()),
    code_challenge_methods_supported: z.array(z.string()),
    token_endpoint_auth_methods_supported: z.array(z.string()),
    id_token_signing_alg_values_supported: z.array(z.string()),
  })
  .passthrough();

const tokenResponseSchema = z
  .object({
    id_token: z.string().min(1).max(32_768),
    token_type: z.string().optional(),
  })
  .passthrough();

export interface UpstreamAuthorizationRequest {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface UpstreamCodeExchange {
  code: string;
  nonce: string;
  codeVerifier: string;
}

export interface UpstreamIdentityClient {
  authorizationUrl(request: UpstreamAuthorizationRequest): URL;
  exchangeCode(request: UpstreamCodeExchange): Promise<FederatedAccount>;
  ready(): Promise<boolean>;
}

async function boundedJson(
  url: URL,
  init: RequestInit,
  label: string,
  fetcher: typeof fetch
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_JSON_BYTES) throw new Error(`${label} response is too large`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_JSON_BYTES) throw new Error(`${label} response is too large`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error(`${label} did not return JSON`);
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function endpoint(
  name: string,
  value: string,
  allowHttp: boolean,
  allowedHosts: ReadonlySet<string>
): URL {
  const url = new URL(value);
  if (
    (!allowHttp && url.protocol !== "https:") ||
    (allowHttp && !["http:", "https:"].includes(url.protocol)) ||
    url.username ||
    url.password ||
    url.hash ||
    (!allowHttp && url.port && url.port !== "443") ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw new Error(`${name} is not a safe OIDC endpoint`);
  }
  return url;
}

function equalOpaque(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function basicComponent(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function stableSubject(issuer: string, upstreamSubject: string): string {
  return `oidc-${createHash("sha256")
    .update(issuer)
    .update("\0")
    .update(upstreamSubject)
    .digest("base64url")}`;
}

export async function createUpstreamIdentityClient(
  config: UpstreamOidcConfig,
  fetcher: typeof fetch = fetch
): Promise<UpstreamIdentityClient> {
  const discovery = new URL("/.well-known/openid-configuration", config.issuer);
  const metadata = metadataSchema.parse(
    await boundedJson(discovery, { method: "GET" }, "Upstream OIDC discovery", fetcher)
  );
  const expectedIssuer = config.issuer.toString().replace(/\/$/, "");
  if (metadata.issuer.replace(/\/$/, "") !== expectedIssuer) {
    throw new Error("Upstream OIDC discovery issuer does not match configuration");
  }
  if (!metadata.response_types_supported.includes("code")) {
    throw new Error("Upstream OIDC provider does not support authorization code flow");
  }
  if (!metadata.code_challenge_methods_supported.includes("S256")) {
    throw new Error("Upstream OIDC provider does not support PKCE S256");
  }
  for (const scope of config.scopes) {
    if (!metadata.scopes_supported.includes(scope)) {
      throw new Error(`Upstream OIDC provider does not advertise required scope ${scope}`);
    }
  }
  const authMethod = config.clientSecret ? "client_secret_basic" : "none";
  if (!metadata.token_endpoint_auth_methods_supported.includes(authMethod)) {
    throw new Error(`Upstream OIDC provider does not support ${authMethod}`);
  }
  const allowedAlgorithms = metadata.id_token_signing_alg_values_supported.filter(
    (algorithm) => ["RS256", "ES256", "PS256"].includes(algorithm)
  );
  if (allowedAlgorithms.length === 0) {
    throw new Error("Upstream OIDC provider has no supported asymmetric ID-token algorithm");
  }

  const allowHttp = config.issuer.protocol === "http:";
  const allowedHosts = new Set(config.endpointHosts.map((host) => host.toLowerCase()));
  const authorizationEndpoint = endpoint(
    "authorization_endpoint",
    metadata.authorization_endpoint,
    allowHttp,
    allowedHosts
  );
  const tokenEndpoint = endpoint(
    "token_endpoint",
    metadata.token_endpoint,
    allowHttp,
    allowedHosts
  );
  const jwksUri = endpoint("jwks_uri", metadata.jwks_uri, allowHttp, allowedHosts);
  const remoteJwks = createRemoteJWKSet(jwksUri, {
    timeoutDuration: REQUEST_TIMEOUT_MS,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });

  return {
    authorizationUrl(request) {
      const state = pkceValue.parse(request.state);
      const nonce = pkceValue.parse(request.nonce);
      const verifier = pkceValue.parse(request.codeVerifier);
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const url = new URL(authorizationEndpoint);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.callbackUrl.toString());
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", config.scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url;
    },

    async exchangeCode(request) {
      const code = opaqueValue.parse(request.code);
      const nonce = pkceValue.parse(request.nonce);
      const codeVerifier = pkceValue.parse(request.codeVerifier);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.callbackUrl.toString(),
        code_verifier: codeVerifier,
        ...(!config.clientSecret ? { client_id: config.clientId } : {}),
      });
      const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
      if (config.clientSecret) {
        const basic = Buffer.from(
          `${basicComponent(config.clientId)}:${basicComponent(config.clientSecret)}`
        ).toString("base64");
        headers.set("Authorization", `Basic ${basic}`);
      }
      const tokenResponse = tokenResponseSchema.parse(
        await boundedJson(
          tokenEndpoint,
          { method: "POST", headers, body },
          "Upstream OIDC token endpoint",
          fetcher
        )
      );
      const { payload } = await jwtVerify(tokenResponse.id_token, remoteJwks, {
        issuer: expectedIssuer,
        audience: config.clientId,
        algorithms: allowedAlgorithms,
        clockTolerance: 30,
        requiredClaims: ["sub", "nonce", "email", "email_verified", "iat", "exp"],
      });
      if (typeof payload.nonce !== "string" || !equalOpaque(payload.nonce, nonce)) {
        throw new Error("Upstream OIDC ID token nonce does not match");
      }
      if (
        typeof payload.sub !== "string" ||
        payload.sub.length < 1 ||
        payload.sub.length > 512 ||
        typeof payload.email !== "string" ||
        payload.email_verified !== true
      ) {
        throw new Error("Upstream OIDC identity lacks a verified email");
      }
      const email = z.string().email().max(254).parse(payload.email).toLowerCase();
      const claimName = typeof payload.name === "string" ? payload.name.trim() : "";
      const name = (claimName || email.slice(0, email.indexOf("@"))).slice(0, 128);
      return {
        sub: stableSubject(expectedIssuer, payload.sub),
        email,
        name,
      };
    },

    async ready() {
      return true;
    },
  };
}
