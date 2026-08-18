#!/usr/bin/env node

import { isIP } from "node:net";

const MAX_JSON_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const ASYMMETRIC_ALGORITHMS = ["RS256", "ES256", "PS256"];
const DEVELOPMENT_LABELS = ["dev", "development", "stage", "staging", "test"];
const REQUIRED_METADATA_FIELDS = [
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "jwks_uri",
  "response_types_supported",
  "scopes_supported",
  "code_challenge_methods_supported",
  "token_endpoint_auth_methods_supported",
  "id_token_signing_alg_values_supported",
];

const issuerInput = process.argv[2] ?? process.env.AUTH_UPSTREAM_ISSUER_URL;
const scopes = (process.env.AUTH_UPSTREAM_SCOPES ?? "openid,email,profile")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);
const configuredHosts = (process.env.AUTH_UPSTREAM_ENDPOINT_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const releaseTier = process.env.PLUGIN_RELEASE_TIER ?? "production";
const authMethod = process.env.AUTH_UPSTREAM_CLIENT_SECRET === "" ? "none" : "client_secret_basic";
const callbackUrl = process.env.AUTH_UPSTREAM_CALLBACK_URL ??
  "https://mcp-auth.atlascloud.ai/upstream/callback";

if (!issuerInput) {
  console.error(
    "usage: node scripts/check-upstream-oidc.mjs <issuer-origin>\n" +
      "       AUTH_UPSTREAM_ISSUER_URL=<issuer-origin> node scripts/check-upstream-oidc.mjs"
  );
  process.exit(2);
}

const results = [];
let issuer;

function record(ok, rule, detail) {
  results.push({ ok, rule, detail });
}

function check(rule, condition, detail) {
  record(Boolean(condition), rule, detail);
  return Boolean(condition);
}

function isPlainHostname(host) {
  if (host.includes("*") || /[:\\/@?#\s]/.test(host)) return false;
  try {
    const parsed = new URL(`https://${host}`);
    return parsed.hostname.toLowerCase() === host.toLowerCase() && parsed.port === "";
  } catch {
    return false;
  }
}

function isDevelopmentOrStagingHostname(hostname) {
  return hostname
    .toLowerCase()
    .split(".")
    .some((label) => DEVELOPMENT_LABELS.includes(label));
}

async function boundedJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_JSON_BYTES) throw new Error(`${label} response is too large`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error(`${label} did not return JSON (content-type: ${contentType || "absent"})`);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    clearTimeout(timer);
  }
}

function checkEndpoint(name, value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return check(`${name} is a valid URL`, false, String(value));
  }
  const unsafe =
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !allowedHosts.has(url.hostname.toLowerCase());
  return check(
    `${name} is a safe OIDC endpoint`,
    !unsafe,
    unsafe
      ? `${url.origin} must be https, port 443, no credentials or fragment, host in AUTH_UPSTREAM_ENDPOINT_HOSTS (${[...allowedHosts].join(",")})`
      : url.origin
  );
}

try {
  issuer = new URL(issuerInput);
} catch {
  console.error(`AUTH_UPSTREAM_ISSUER_URL is not a valid URL: ${issuerInput}`);
  process.exit(2);
}

check("issuer URL carries no credentials", !issuer.username && !issuer.password, issuer.origin);
check(
  "issuer URL is a bare origin",
  issuer.pathname === "/" && !issuer.search && !issuer.hash,
  `${issuer.origin}${issuer.pathname}${issuer.search}${issuer.hash}`
);
check("issuer URL uses https", issuer.protocol === "https:", issuer.protocol);
if (releaseTier === "production") {
  check(
    "issuer host has no dev/staging/test label",
    !isDevelopmentOrStagingHostname(issuer.hostname),
    issuer.hostname
  );
}
check("scopes include openid and email", scopes.includes("openid") && scopes.includes("email"), scopes.join(","));

const allowedHosts = new Set(
  configuredHosts.length > 0 ? configuredHosts : [issuer.hostname.toLowerCase()]
);
check(
  "endpoint hosts include the issuer host",
  allowedHosts.has(issuer.hostname.toLowerCase()),
  [...allowedHosts].join(",")
);
check(
  "endpoint hosts are exact public hostnames",
  [...allowedHosts].every(
    (host) =>
      isPlainHostname(host) &&
      (releaseTier !== "production" ||
        (isIP(host) === 0 &&
          host !== "localhost" &&
          !host.endsWith(".localhost") &&
          !host.endsWith(".local") &&
          host.includes(".")))
  ),
  [...allowedHosts].join(",")
);

const discovery = new URL("/.well-known/openid-configuration", issuer);
let metadata;
try {
  metadata = await boundedJson(discovery, "Upstream OIDC discovery");
  check("discovery document is reachable without redirects", true, discovery.toString());
} catch (error) {
  check("discovery document is reachable without redirects", false, `${discovery} — ${error.message}`);
}

if (metadata) {
  const missing = REQUIRED_METADATA_FIELDS.filter((field) => metadata[field] === undefined);
  check("discovery advertises every required field", missing.length === 0, missing.join(",") || "all present");

  const arrayField = (field) => (Array.isArray(metadata[field]) ? metadata[field] : []);
  const expectedIssuer = issuer.toString().replace(/\/$/, "");
  check(
    "discovery issuer matches the configured issuer exactly",
    typeof metadata.issuer === "string" && metadata.issuer.replace(/\/$/, "") === expectedIssuer,
    `${metadata.issuer} vs ${expectedIssuer}`
  );
  check(
    "authorization code flow is supported",
    arrayField("response_types_supported").includes("code"),
    arrayField("response_types_supported").join(",")
  );
  check(
    "PKCE S256 is supported",
    arrayField("code_challenge_methods_supported").includes("S256"),
    arrayField("code_challenge_methods_supported").join(",")
  );
  const missingScopes = scopes.filter((scope) => !arrayField("scopes_supported").includes(scope));
  check("every requested scope is advertised", missingScopes.length === 0, missingScopes.join(",") || scopes.join(","));
  check(
    `token endpoint auth method ${authMethod} is supported`,
    arrayField("token_endpoint_auth_methods_supported").includes(authMethod),
    arrayField("token_endpoint_auth_methods_supported").join(",")
  );
  const algorithms = arrayField("id_token_signing_alg_values_supported").filter((algorithm) =>
    ASYMMETRIC_ALGORITHMS.includes(algorithm)
  );
  check(
    "an asymmetric ID-token algorithm is supported",
    algorithms.length > 0,
    algorithms.join(",") || arrayField("id_token_signing_alg_values_supported").join(",")
  );

  checkEndpoint("authorization_endpoint", metadata.authorization_endpoint, allowedHosts);
  checkEndpoint("token_endpoint", metadata.token_endpoint, allowedHosts);
  const jwksOk = checkEndpoint("jwks_uri", metadata.jwks_uri, allowedHosts);

  if (jwksOk) {
    try {
      const jwks = await boundedJson(new URL(metadata.jwks_uri), "Upstream JWKS");
      check(
        "JWKS exposes at least one signing key",
        Array.isArray(jwks.keys) && jwks.keys.length > 0,
        Array.isArray(jwks.keys) ? `${jwks.keys.length} key(s)` : "keys[] absent"
      );
    } catch (error) {
      check("JWKS exposes at least one signing key", false, error.message);
    }
  }
}

const failures = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.rule}${result.detail ? ` — ${result.detail}` : ""}`);
}

if (metadata) {
  const observedHosts = new Set([issuer.hostname.toLowerCase()]);
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    try {
      observedHosts.add(new URL(metadata[field]).hostname.toLowerCase());
    } catch {
      continue;
    }
  }
  console.log("");
  console.log(`AUTH_UPSTREAM_ENDPOINT_HOSTS=${[...observedHosts].join(",")}`);
}

console.log("");
console.log("Not verifiable from discovery — confirm with the identity provider:");
console.log(`  - ${callbackUrl} is registered as an exact redirect URI`);
console.log("  - the ID token carries sub, nonce, email, email_verified, iat, and exp");
console.log("  - email_verified is the boolean true, not the string \"true\"");
console.log("  - the ID token audience equals AUTH_UPSTREAM_CLIENT_ID");
if (releaseTier === "production") {
  console.log("  - AUTH_UPSTREAM_CLIENT_SECRET is at least 32 characters");
}

console.log("");
if (failures.length === 0) {
  console.log(
    "UPSTREAM_OIDC_PRECHECK_PASS",
    `issuer=${issuer.hostname}`,
    `tier=${releaseTier}`,
    `checks=${results.length}`
  );
} else {
  console.log(
    "UPSTREAM_OIDC_PRECHECK_FAIL",
    `issuer=${issuer.hostname}`,
    `tier=${releaseTier}`,
    `failed=${failures.length}/${results.length}`
  );
  process.exit(1);
}
