#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const serverName = process.env.CODEX_MCP_SERVER ?? "atlascloud-staging";
const authBase = new URL(
  process.env.AUTH_BASE_URL ?? "https://atlascloud-auth.dev.atlascloud.ai"
);
const mcpUrl = new URL(
  process.env.MCP_URL ?? "https://atlascloud-mcp.dev.atlascloud.ai/mcp"
);
const reviewerEmail = process.env.REVIEWER_EMAIL ?? "openai-plugin-reviewer@atlascloud.ai";
const reviewerPassword = readFileSync(0, "utf8").trim();
const oauthCredentialStore = process.env.CODEX_OAUTH_CREDENTIALS_STORE;
const requestedScopes = (process.env.CODEX_OAUTH_SCOPES ?? [
  "openid",
  "email",
  "profile",
  "offline_access",
  "atlas:models:read",
  "atlas:predictions:read",
  "atlas:billing:read",
].join(","))
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);

assert.equal(authBase.protocol, "https:");
assert.equal(mcpUrl.protocol, "https:");
assert.ok(reviewerPassword.length >= 16, "reviewer password must be supplied on stdin");
assert.match(serverName, /^[A-Za-z0-9_-]+$/, "MCP server name must be a bounded TOML bare key");

function passed(message) {
  process.stdout.write(`PASS ${message}\n`);
}

function defaultCookiePath(pathname) {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const boundary = pathname.lastIndexOf("/");
  return boundary <= 0 ? "/" : pathname.slice(0, boundary);
}

function cookiePathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function rememberCookies(response, requestUrl, jar) {
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair, ...rawAttributes] = value.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    const attributes = rawAttributes.map((attribute) => attribute.toLowerCase());
    const pathAttribute = rawAttributes.find((attribute) =>
      attribute.toLowerCase().startsWith("path=")
    );
    const configuredPath = pathAttribute?.slice("path=".length);
    const path = configuredPath?.startsWith("/")
      ? configuredPath
      : defaultCookiePath(requestUrl.pathname);
    const secure = attributes.includes("secure");
    const maxAgeAttribute = attributes.find((attribute) => attribute.startsWith("max-age="));
    const maxAge = maxAgeAttribute
      ? Number.parseInt(maxAgeAttribute.slice("max-age=".length), 10)
      : undefined;
    const existingIndex = jar.findIndex(
      (candidate) => candidate.name === name && candidate.path === path
    );
    if (!cookieValue || (maxAge !== undefined && maxAge <= 0)) {
      if (existingIndex >= 0) jar.splice(existingIndex, 1);
      continue;
    }
    const cookie = { name, value: cookieValue, path, secure };
    if (existingIndex >= 0) jar[existingIndex] = cookie;
    else jar.push(cookie);
  }
}

async function requestWithCookies(jar, input, init = {}) {
  const target = new URL(input);
  const headers = new Headers(init.headers);
  const cookies = jar
    .filter((cookie) =>
      (!cookie.secure || target.protocol === "https:")
      && cookiePathMatches(target.pathname, cookie.path)
    )
    .sort((left, right) => right.path.length - left.path.length);
  if (cookies.length > 0) {
    headers.set("Cookie", cookies.map(({ name, value }) => `${name}=${value}`).join("; "));
  }
  const response = await fetch(target, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  rememberCookies(response, target, jar);
  return response;
}

async function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    const diagnostic = redactOutput((await response.text()).slice(0, 1_000));
    assert.fail(
      `${label}: expected HTTP ${expected}, got ${response.status}${diagnostic ? `: ${diagnostic}` : ""}`
    );
  }
  return response;
}

function location(response, base = authBase) {
  const value = response.headers.get("location");
  assert.ok(value, `missing Location header on HTTP ${response.status}`);
  return new URL(value, base);
}

function assertAuthOrigin(url, label) {
  assert.equal(url.origin, authBase.origin, `${label} escaped the authorization-server origin`);
  return url;
}

function hidden(html, name) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  assert.ok(match, `missing hidden field ${name}`);
  return match[1];
}

function redactOutput(raw) {
  return raw
    .replace(/https?:\/\/\S+/g, "[URL redacted]")
    .replace(/(client_id|state|code|code_challenge)=([^&\s]+)/g, "$1=[redacted]")
    .trim();
}

function findAuthorizationUrl(raw) {
  for (const candidate of raw.match(/https:\/\/[^\s]+/g) ?? []) {
    try {
      const parsed = new URL(candidate);
      if (parsed.origin === authBase.origin && parsed.pathname === "/auth") return parsed;
    } catch {
      // Ignore non-URL terminal fragments.
    }
  }
  return undefined;
}

function waitForAuthorizationUrl(child, getOutput) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for Codex authorization URL"));
    }, 30_000);
    const inspect = () => {
      const url = findAuthorizationUrl(getOutput());
      if (!url) return;
      cleanup();
      resolve(url);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    inspect();
  });
}

async function withTimeout(promise, milliseconds, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

const codexConfigArgs = oauthCredentialStore ? [
  "-c",
  `mcp_oauth_credentials_store=${JSON.stringify(oauthCredentialStore)}`,
  "-c",
  `mcp_servers.${serverName}.url=${JSON.stringify(mcpUrl.toString())}`,
] : [];

const child = spawn("codex", [
  ...codexConfigArgs,
  "mcp",
  "login",
  serverName,
  "--scopes",
  requestedScopes.join(","),
], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
const exitPromise = waitForExit(child);
let commandOutput = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { commandOutput += chunk; });
child.stderr.on("data", (chunk) => { commandOutput += chunk; });

try {
  const authorization = await waitForAuthorizationUrl(child, () => commandOutput);
  const redirectUri = new URL(authorization.searchParams.get("redirect_uri") ?? "");
  assert.equal(redirectUri.protocol, "http:");
  assert.equal(redirectUri.hostname, "127.0.0.1");
  assert.ok(redirectUri.port);
  assert.match(redirectUri.pathname, /^\/callback\/[A-Za-z0-9_-]{12}$/);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorization.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.ok(authorization.searchParams.get("state"));
  assert.equal(authorization.searchParams.get("resource"), mcpUrl.toString());
  const scopes = new Set((authorization.searchParams.get("scope") ?? "").split(/\s+/));
  for (const required of requestedScopes) {
    assert.ok(scopes.has(required), `Codex authorization URL omitted ${required}`);
  }
  assert.equal(scopes.size, new Set(requestedScopes).size, "Codex authorization URL added unexpected scopes");
  passed("Codex emitted a bounded loopback callback with PKCE S256 and exact Atlas scopes");

  const jar = [];
  let response = await requestWithCookies(jar, authorization);
  await expectStatus(response, 303, "authorization start");
  response = await requestWithCookies(jar, assertAuthOrigin(location(response), "login redirect"));
  await expectStatus(response, 200, "login page");
  let html = await response.text();
  assert.match(html, /Connect ChatGPT to Atlas Cloud/);
  const loginUid = hidden(html, "interaction_uid");
  const loginCsrf = hidden(html, "csrf_token");

  response = await requestWithCookies(jar, new URL(`/interaction/${loginUid}/login`, authBase), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf_token: loginCsrf,
      interaction_uid: loginUid,
      email: reviewerEmail,
      password: reviewerPassword,
    }),
  });
  await expectStatus(response, 303, "reviewer login");
  response = await requestWithCookies(
    jar,
    assertAuthOrigin(location(response), "post-login continuation")
  );
  await expectStatus(response, 303, "post-login authorization continuation");
  response = await requestWithCookies(
    jar,
    assertAuthOrigin(location(response), "consent redirect")
  );
  await expectStatus(response, 200, "consent page");
  html = await response.text();
  assert.doesNotMatch(html, /Generation calls may consume Atlas Cloud credits/);
  const consentUid = hidden(html, "interaction_uid");
  const consentCsrf = hidden(html, "csrf_token");

  response = await requestWithCookies(jar, new URL(`/interaction/${consentUid}/confirm`, authBase), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf_token: consentCsrf,
      interaction_uid: consentUid,
      decision: "allow",
    }),
  });
  await expectStatus(response, 303, "consent confirmation");
  response = await requestWithCookies(
    jar,
    assertAuthOrigin(location(response), "authorization continuation")
  );
  await expectStatus(response, 303, "authorization callback redirect");
  const callbackUrl = location(response);
  assert.equal(callbackUrl.origin + callbackUrl.pathname, redirectUri.origin + redirectUri.pathname);
  assert.equal(callbackUrl.searchParams.get("state"), authorization.searchParams.get("state"));
  assert.ok(callbackUrl.searchParams.get("code"));
  passed("reviewer login, CSRF checks, read-only consent, and Allow succeeded");

  const callbackResponse = await fetch(callbackUrl, { signal: AbortSignal.timeout(15_000) });
  assert.equal(callbackResponse.status, 200);
  const exit = await withTimeout(
    exitPromise,
    30_000,
    "timed out waiting for Codex to exchange the authorization code"
  );
  assert.equal(exit.signal, null);
  assert.equal(
    exit.code,
    0,
    `codex mcp login failed: ${redactOutput(commandOutput) || "no diagnostic output"}`
  );
  passed("Codex received the loopback callback, exchanged the code, and stored OAuth tokens");
} catch (error) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  throw error;
}
