#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, jwtVerify } from "jose";
import { REMOTE_SCOPES } from "../dist/config.js";

const authBase = process.env.AUTH_BASE_URL ?? "https://atlascloud-auth.dev.atlascloud.ai";
const mcpUrl = process.env.MCP_URL ?? "https://atlascloud-mcp.dev.atlascloud.ai/mcp";
const reviewerEmail = process.env.REVIEWER_EMAIL ?? "openai-plugin-reviewer@atlascloud.ai";
const readOnlyMode = process.env.LIVE_READ_ONLY === "1";
const callback = process.env.CALLBACK_URL ??
  "https://chatgpt.com/connector/oauth/atlascloud-live-e2e";
const reviewerPassword = readFileSync(0, "utf8").trim();
const accountReadsEnabled = process.env.LIVE_ACCOUNT_READS === "1";
const billableMaxUsdRaw = process.env.LIVE_BILLABLE_MAX_USD;
const billableEnabled = billableMaxUsdRaw !== undefined;
const billableModel = process.env.LIVE_BILLABLE_MODEL ??
  "openai/gpt-image-1-mini/text-to-image";
const billableIdempotencyKey = process.env.LIVE_BILLABLE_IDEMPOTENCY_KEY;
const billableMaxUsd = billableEnabled ? Number(billableMaxUsdRaw) : 0;
const billableTool = process.env.LIVE_BILLABLE_TOOL ?? "atlas_generate_image";
const billableTimeoutSeconds = Number(process.env.LIVE_BILLABLE_TIMEOUT_SECONDS ?? "300");
let configuredBillableArguments;
try {
  configuredBillableArguments = process.env.LIVE_BILLABLE_ARGUMENTS_JSON
    ? JSON.parse(process.env.LIVE_BILLABLE_ARGUMENTS_JSON)
    : {
        model: billableModel,
        params: {
          prompt: "A minimal blue geometric cloud icon on a white background, no text",
          quality: "low",
          size: "1024x1024",
          output_format: "png",
          n: 1,
        },
      };
} catch (error) {
  throw new Error(`LIVE_BILLABLE_ARGUMENTS_JSON is invalid JSON: ${error.message}`);
}
const existingPredictionId = process.env.LIVE_EXISTING_PREDICTION_ID;
const costModelIds = process.env.LIVE_COST_MODEL_IDS_JSON
  ? JSON.parse(process.env.LIVE_COST_MODEL_IDS_JSON)
  : [];
const requestedResourceScopes = readOnlyMode
  ? ["atlas:models:read", "atlas:predictions:read", "atlas:billing:read"]
  : [...REMOTE_SCOPES];

assert.ok(reviewerPassword.length >= 16, "reviewer password must be supplied on stdin");
assert.equal(new URL(authBase).protocol, "https:");
assert.equal(new URL(mcpUrl).protocol, "https:");
assert.ok(
  Array.isArray(costModelIds) &&
    costModelIds.length <= 100 &&
    costModelIds.every((model) => typeof model === "string" && model.length > 0),
  "LIVE_COST_MODEL_IDS_JSON must be an array of at most 100 non-empty model IDs"
);
if (existingPredictionId !== undefined) {
  assert.match(
    existingPredictionId,
    /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/,
    "LIVE_EXISTING_PREDICTION_ID must be one URL-safe path segment"
  );
}
if (billableEnabled) {
  assert.equal(readOnlyMode, false, "LIVE_BILLABLE_MAX_USD cannot be used with LIVE_READ_ONLY=1");
  assert.equal(
    accountReadsEnabled,
    true,
    "LIVE_ACCOUNT_READS=1 is required before a billable test"
  );
  assert.ok(
    Number.isFinite(billableMaxUsd) && billableMaxUsd > 0,
    "LIVE_BILLABLE_MAX_USD must be a finite positive number"
  );
  assert.match(
    billableIdempotencyKey ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "LIVE_BILLABLE_IDEMPOTENCY_KEY must be an explicit UUID"
  );
  assert.ok(
    [
      "atlas_generate_image",
      "atlas_generate_video",
      "atlas_generate_audio",
      "atlas_transcribe_audio",
      "atlas_quick_generate",
    ].includes(billableTool),
    "LIVE_BILLABLE_TOOL must be one of the five remote generation tools"
  );
  assert.ok(
    configuredBillableArguments &&
      typeof configuredBillableArguments === "object" &&
      !Array.isArray(configuredBillableArguments),
    "LIVE_BILLABLE_ARGUMENTS_JSON must be a JSON object"
  );
  assert.equal("idempotency_key" in configuredBillableArguments, false);
  assert.equal("confirmation_token" in configuredBillableArguments, false);
  if (billableTool !== "atlas_quick_generate") {
    assert.equal(
      configuredBillableArguments.model,
      billableModel,
      "direct generation arguments must use LIVE_BILLABLE_MODEL exactly"
    );
  }
  assert.ok(
    Number.isFinite(billableTimeoutSeconds) &&
      billableTimeoutSeconds >= 30 &&
      billableTimeoutSeconds <= 900,
    "LIVE_BILLABLE_TIMEOUT_SECONDS must be between 30 and 900"
  );
}

function passed(name) {
  process.stdout.write(`PASS ${name}\n`);
}

function utcDateOffset(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function expectStatus(response, expected, label) {
  assert.equal(response.status, expected, `${label}: expected HTTP ${expected}, got ${response.status}`);
  return response;
}

function location(response) {
  const value = response.headers.get("location");
  assert.ok(value, `missing Location header on HTTP ${response.status}`);
  return new URL(value, authBase);
}

function hidden(html, name) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  assert.ok(match, `missing hidden field ${name}`);
  return match[1];
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
  const values = response.headers.getSetCookie?.() ?? [];
  for (const value of values) {
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
    signal: AbortSignal.timeout(15000),
  });
  rememberCookies(response, target, jar);
  return response;
}

async function postJson(path, body) {
  return fetch(`${authBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

async function tokenRequest(body) {
  return fetch(`${authBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15000),
  });
}

const unsafeRedirect = await postJson("/reg", {
  redirect_uris: ["https://evil.example/callback"],
});
await expectStatus(unsafeRedirect, 400, "unsafe DCR redirect");
assert.equal((await unsafeRedirect.json()).error, "invalid_redirect_uri");

const badAuthMethod = await postJson("/reg", {
  redirect_uris: [callback],
  token_endpoint_auth_method: "private_key_jwt",
});
await expectStatus(badAuthMethod, 400, "non-public client auth method");
assert.equal((await badAuthMethod.json()).error, "invalid_client_metadata");
passed("DCR rejects unsafe callback and non-public client auth method");

const strippedUnsupportedMetadata = await postJson("/reg", {
  redirect_uris: [callback],
  token_endpoint_auth_method: "none",
  jwks_uri: "https://127.0.0.1/oauth/jwks.json",
  id_token_encrypted_response_alg: "RSA-OAEP",
  request_object_signing_alg: "RS256",
  userinfo_encrypted_response_alg: "RSA-OAEP",
});
await expectStatus(strippedUnsupportedMetadata, 201, "unsupported DCR metadata stripping");
const strippedClient = await strippedUnsupportedMetadata.json();
assert.equal(strippedClient.token_endpoint_auth_method, "none");
assert.equal(strippedClient.jwks_uri, undefined);
assert.equal(strippedClient.id_token_encrypted_response_alg, undefined);
assert.equal(strippedClient.request_object_signing_alg, undefined);
assert.equal(strippedClient.userinfo_encrypted_response_alg, undefined);
passed("DCR strips private jwks_uri and unsupported cryptographic metadata");

const registrationResponse = await postJson("/reg", {
  client_name: "ChatGPT Atlas Cloud Connector Live E2E",
  redirect_uris: [callback],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
});
await expectStatus(registrationResponse, 201, "dynamic registration");
const registration = await registrationResponse.json();
assert.equal(typeof registration.client_id, "string");
assert.equal(registration.token_endpoint_auth_method, "none");
passed("DCR accepts ChatGPT connector callback as a public client");

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("base64url");
const authorization = new URL(`${authBase}/auth`);
authorization.searchParams.set("client_id", registration.client_id);
authorization.searchParams.set("redirect_uri", callback);
authorization.searchParams.set("response_type", "code");
authorization.searchParams.set(
  "scope",
  ["openid", "email", "offline_access", ...requestedResourceScopes].join(" ")
);
authorization.searchParams.set("code_challenge", challenge);
authorization.searchParams.set("code_challenge_method", "S256");
authorization.searchParams.set("resource", mcpUrl);
authorization.searchParams.set("state", state);

const jar = [];
let response = await requestWithCookies(jar, authorization);
await expectStatus(response, 303, "authorization start");
response = await requestWithCookies(jar, location(response));
await expectStatus(response, 200, "login page");
let html = await response.text();
assert.match(html, /Connect ChatGPT to Atlas Cloud/);
const loginUid = hidden(html, "interaction_uid");
const loginCsrf = hidden(html, "csrf_token");

response = await requestWithCookies(jar, `${authBase}/interaction/${loginUid}/login`, {
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
response = await requestWithCookies(jar, location(response));
await expectStatus(response, 303, "post-login authorization continuation");
response = await requestWithCookies(jar, location(response));
await expectStatus(response, 200, "consent page");
html = await response.text();
if (readOnlyMode) {
  assert.doesNotMatch(html, /Generation calls may consume Atlas Cloud credits/);
} else {
  assert.match(html, /Generation calls may consume Atlas Cloud credits/);
}
const consentUid = hidden(html, "interaction_uid");
const consentCsrf = hidden(html, "csrf_token");

response = await requestWithCookies(jar, `${authBase}/interaction/${consentUid}/confirm`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    csrf_token: consentCsrf,
    interaction_uid: consentUid,
    decision: "allow",
  }),
});
await expectStatus(response, 303, "consent confirmation");
response = await requestWithCookies(jar, location(response));
await expectStatus(response, 303, "authorization callback redirect");
const callbackUrl = location(response);
assert.equal(callbackUrl.origin + callbackUrl.pathname, callback);
assert.equal(callbackUrl.searchParams.get("state"), state);
const code = callbackUrl.searchParams.get("code");
assert.ok(code, "authorization callback omitted code");
passed("reviewer login, CSRF, consent and PKCE authorization succeed");

const tokenResponse = await tokenRequest({
  grant_type: "authorization_code",
  client_id: registration.client_id,
  code,
  redirect_uri: callback,
  code_verifier: verifier,
  resource: mcpUrl,
});
await expectStatus(tokenResponse, 200, "authorization-code exchange");
const tokens = await tokenResponse.json();
assert.equal(typeof tokens.access_token, "string");
assert.equal(typeof tokens.id_token, "string");
assert.equal(typeof tokens.refresh_token, "string");

const jwksResponse = await fetch(`${authBase}/jwks`, {
  signal: AbortSignal.timeout(15000),
});
await expectStatus(jwksResponse, 200, "JWKS");
const jwks = createLocalJWKSet(await jwksResponse.json());
const access = await jwtVerify(tokens.access_token, jwks, {
  issuer: authBase,
  audience: mcpUrl,
  algorithms: ["RS256"],
});
assert.equal(access.payload.sub, "openai-reviewer");
assert.equal(access.payload.client_id, registration.client_id);
const issuedScopes = new Set(String(access.payload.scope).split(/\s+/));
for (const scope of requestedResourceScopes) assert.ok(issuedScopes.has(scope));
assert.equal(issuedScopes.has("atlas:generation:write"), !readOnlyMode);
const identity = await jwtVerify(tokens.id_token, jwks, {
  issuer: authBase,
  audience: registration.client_id,
  algorithms: ["RS256"],
});
assert.equal(identity.payload.email, reviewerEmail);
assert.equal(identity.payload.email_verified, true);
passed("audience-bound RS256 access and ID tokens validate against public JWKS");

const userinfoResponse = await fetch(`${authBase}/me`, {
  headers: { Authorization: `Bearer ${tokens.access_token}` },
  signal: AbortSignal.timeout(15000),
});
await expectStatus(userinfoResponse, 200, "UserInfo");
const userinfo = await userinfoResponse.json();
assert.equal(userinfo.sub, "openai-reviewer");
assert.equal(userinfo.email, reviewerEmail);
assert.equal(userinfo.email_verified, true);
const invalidUserinfo = await fetch(`${authBase}/me`, {
  headers: { Authorization: `Bearer ${tokens.access_token}x` },
  signal: AbortSignal.timeout(15000),
});
await expectStatus(invalidUserinfo, 401, "invalid UserInfo bearer");
assert.match(invalidUserinfo.headers.get("www-authenticate") ?? "", /invalid_token/);
passed("UserInfo returns verified email and rejects an invalid bearer token");

const refreshResponse = await tokenRequest({
  grant_type: "refresh_token",
  client_id: registration.client_id,
  refresh_token: tokens.refresh_token,
  resource: mcpUrl,
});
await expectStatus(refreshResponse, 200, "refresh rotation");
const refreshed = await refreshResponse.json();
assert.equal(typeof refreshed.access_token, "string");
assert.equal(typeof refreshed.refresh_token, "string");
assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
const reusedRefresh = await tokenRequest({
  grant_type: "refresh_token",
  client_id: registration.client_id,
  refresh_token: tokens.refresh_token,
  resource: mcpUrl,
});
await expectStatus(reusedRefresh, 200, "bounded old refresh token retry");
const retryTokens = await reusedRefresh.json();
assert.equal(typeof retryTokens.access_token, "string");
assert.equal(typeof retryTokens.refresh_token, "string");
assert.notEqual(retryTokens.refresh_token, tokens.refresh_token);
passed("refresh token rotates while the first bounded retry prevents connection loss");
const finalAllowedRetry = await tokenRequest({
  grant_type: "refresh_token",
  client_id: registration.client_id,
  refresh_token: tokens.refresh_token,
  resource: mcpUrl,
});
await expectStatus(finalAllowedRetry, 200, "final bounded old refresh token retry");

const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: {
    headers: { Authorization: `Bearer ${retryTokens.access_token}` },
  },
});
const client = new Client({ name: "atlascloud-live-e2e", version: "1.0.0" });
await client.connect(transport);
let positiveCases = 3;
let billableUpstreamPosts = 0;
try {
  const listed = await client.listTools();
  const expectedNames = [
    "atlas_search_docs",
    "atlas_list_models",
    "atlas_get_model_info",
    "atlas_generate_image",
    "atlas_generate_video",
    "atlas_generate_audio",
    "atlas_transcribe_audio",
    "atlas_get_prediction",
    "atlas_get_balance",
    "atlas_get_model_usage",
    "atlas_get_model_costs",
    "atlas_quick_generate",
  ];
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expectedNames.sort());
  for (const tool of listed.tools) {
    assert.equal(typeof tool.outputSchema, "object", `${tool.name} has no output schema`);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name} has no ${hint}`);
    }
    assert.ok(Array.isArray(tool._meta?.securitySchemes), `${tool.name} has no _meta security schemes`);
  }
  passed("official MCP client initializes and validates all 12 standard tool contracts");

  const expectedScopes = {
    atlas_search_docs: "atlas:models:read",
    atlas_list_models: "atlas:models:read",
    atlas_get_model_info: "atlas:models:read",
    atlas_generate_image: "atlas:generation:write",
    atlas_generate_video: "atlas:generation:write",
    atlas_generate_audio: "atlas:generation:write",
    atlas_transcribe_audio: "atlas:generation:write",
    atlas_get_prediction: "atlas:predictions:read",
    atlas_get_balance: "atlas:billing:read",
    atlas_get_model_usage: "atlas:billing:read",
    atlas_get_model_costs: "atlas:billing:read",
    atlas_quick_generate: "atlas:generation:write",
  };
  const rawToolsResponse = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refreshed.access_token}`,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "live-tools-list",
      method: "tools/list",
      params: {},
    }),
    signal: AbortSignal.timeout(15000),
  });
  await expectStatus(rawToolsResponse, 200, "raw tools/list");
  const rawToolsPayload = await rawToolsResponse.json();
  assert.equal(rawToolsPayload.result.tools.length, 12);
  for (const tool of rawToolsPayload.result.tools) {
    const expected = [{ type: "oauth2", scopes: [expectedScopes[tool.name]] }];
    assert.deepEqual(tool.securitySchemes, expected, `${tool.name} top-level security scheme mismatch`);
    assert.deepEqual(tool._meta?.securitySchemes, expected, `${tool.name} _meta security scheme mismatch`);
  }
  passed("raw tools/list exposes exact OAuth scopes in both OpenAI-required locations");

  const models = await client.callTool({
    name: "atlas_list_models",
    arguments: { type: "Image", limit: readOnlyMode ? 10 : 2, offset: 0 },
  });
  assert.notEqual(models.isError, true);
  assert.equal(models.structuredContent.count, readOnlyMode ? 10 : 2);
  assert.ok(models.structuredContent.total_count >= 2);
  assert.equal(models.structuredContent.models.length, readOnlyMode ? 10 : 2);
  const modelId = models.structuredContent.models[0].model_id;
  if (readOnlyMode) {
    process.stdout.write(
      `AVAILABLE_MODELS_JSON=${JSON.stringify(models.structuredContent.models)}\n`
    );
    positiveCases += 1;
    passed("read-only model listing passes over live HTTPS MCP");
  }

  if (!readOnlyMode) {
    const search = await client.callTool({
      name: "atlas_search_docs",
      arguments: { query: "openai", limit: 2, offset: 0 },
    });
    assert.notEqual(search.isError, true);
    assert.ok(search.structuredContent.total_count >= search.structuredContent.count);

    const modelInfo = await client.callTool({
      name: "atlas_get_model_info",
      arguments: { model: modelId },
    });
    assert.notEqual(modelInfo.isError, true);
    assert.equal(modelInfo.structuredContent.model.model_id, modelId);
    passed("three non-billable public catalog tools pass over live HTTPS MCP");
  }

  const contentText = (result) =>
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

  let availableUsd;
  if (accountReadsEnabled) {
    const balance = await client.callTool({
      name: "atlas_get_balance",
      arguments: {},
    });
    assert.notEqual(balance.isError, true);
    assert.equal(typeof balance.structuredContent.scope, "string");
    const available = balance.structuredContent.available;
    if (available?.currency?.toLowerCase() === "usd") {
      const parsed = Number(available.value);
      if (Number.isFinite(parsed)) {
        availableUsd = parsed;
        process.stdout.write(`ACCOUNT_AVAILABLE_USD=${parsed.toFixed(6)}\n`);
      }
    }
    positiveCases += 1;
    passed("authenticated balance read passes over live HTTPS MCP");

    if (!readOnlyMode) {
      const usage = await client.callTool({
        name: "atlas_get_model_usage",
        arguments: {
          start_date: utcDateOffset(-1),
          end_date: utcDateOffset(0),
          scope: "self",
          limit: 1,
        },
      });
      assert.notEqual(usage.isError, true);
      assert.equal(typeof usage.structuredContent.scope, "string");
      assert.ok(Array.isArray(usage.structuredContent.buckets));
      positiveCases += 1;
      passed("authenticated model-usage read passes over live HTTPS MCP");
    }

    if (!readOnlyMode && costModelIds.length > 0) {
      const costs = await client.callTool({
        name: "atlas_get_model_costs",
        arguments: {
          start_date: utcDateOffset(0),
          end_date: utcDateOffset(1),
          scope: "self",
          group_by: ["model"],
          model_ids: costModelIds,
          limit: 100,
        },
      });
      assert.notEqual(costs.isError, true, contentText(costs));
      process.stdout.write(
        `MODEL_COSTS_JSON=${JSON.stringify(costs.structuredContent.buckets)}\n`
      );
    }
  }

  if (existingPredictionId !== undefined) {
    const existingPrediction = await client.callTool({
      name: "atlas_get_prediction",
      arguments: { prediction_id: existingPredictionId },
    });
    assert.notEqual(existingPrediction.isError, true, contentText(existingPrediction));
    assert.ok(
      ["completed", "succeeded"].includes(
        String(existingPrediction.structuredContent.status).toLowerCase()
      )
    );
    assert.ok(existingPrediction.structuredContent.outputs.length > 0);
    positiveCases += 1;
    passed("existing completed prediction is readable through deployed HTTPS MCP");
  }

  if (!readOnlyMode) {
    const inventedModel = await client.callTool({
    name: "atlas_generate_image",
    arguments: {
      idempotency_key: "00000000-0000-4000-8000-000000000600",
      model: "atlascloud/not-a-real-model",
      params: { prompt: "This request must not be submitted" },
    },
  });
    assert.equal(inventedModel.isError, true);
    assert.match(contentText(inventedModel), /model .*not found/i);

    const quoteArguments = {
    idempotency_key: "00000000-0000-4000-8000-000000000601",
    model: "openai/gpt-image-1-mini/text-to-image",
    params: {
      prompt: "Quote only; this request must not be submitted",
      quality: "low",
      size: "1024x1024",
      output_format: "png",
      n: 1,
    },
  };
    const preflightQuote = await client.callTool({
    name: "atlas_generate_image",
    arguments: quoteArguments,
  });
    assert.notEqual(preflightQuote.isError, true, contentText(preflightQuote));
    assert.equal(preflightQuote.structuredContent.status, "confirmation_required");
    assert.equal(typeof preflightQuote.structuredContent.confirmation_token, "string");

    if (availableUsd !== undefined) {
      const balanceAfterPreflightQuote = await client.callTool({
        name: "atlas_get_balance",
        arguments: {},
      });
      assert.notEqual(balanceAfterPreflightQuote.isError, true);
      assert.equal(
        Number(balanceAfterPreflightQuote.structuredContent.available?.value),
        availableUsd,
        "quote-only preflight changed the available balance"
      );
    }
    positiveCases += 1;
    passed("valid generation preflight returns a quote without spending credits");

    const changedWrite = await client.callTool({
    name: "atlas_generate_image",
    arguments: {
      ...quoteArguments,
      confirmation_token: preflightQuote.structuredContent.confirmation_token,
      params: {
        ...quoteArguments.params,
        prompt: "Changed after the quote; this request must not be submitted",
      },
    },
  });
    assert.equal(changedWrite.isError, true);
    assert.match(contentText(changedWrite), /confirmation.*does not match/i);

    const invalidSchema = await client.callTool({
    name: "atlas_generate_image",
    arguments: {
      idempotency_key: "00000000-0000-4000-8000-000000000602",
      model: "openai/gpt-image-1-mini/text-to-image",
      params: {
        prompt: "This invalid size must not be submitted",
        quality: "low",
        size: "1x1",
        output_format: "png",
        n: 1,
      },
    },
  });
    assert.equal(invalidSchema.isError, true);
    assert.match(contentText(invalidSchema), /1x1|allowed|schema|validation/i);
    passed("three write preflight negatives fail before any billable upstream POST");
  }

  if (billableEnabled) {
    const pricedModel = await client.callTool({
      name: "atlas_get_model_info",
      arguments: { model: billableModel },
    });
    assert.notEqual(pricedModel.isError, true);
    const actualPricing = pricedModel.structuredContent.pricing?.actual;
    const unitPriceRaw = actualPricing?.request_price ?? actualPricing?.base_price;
    assert.equal(typeof unitPriceRaw, "string", "model has no machine-readable request price");
    const unitPriceUsd = Number(unitPriceRaw);
    assert.ok(
      Number.isFinite(unitPriceUsd) && unitPriceUsd > 0,
      "model request price must be a finite positive number"
    );
    assert.ok(
      unitPriceUsd <= billableMaxUsd,
      `catalog unit price exceeds authorized cap of USD ${billableMaxUsd}`
    );
    assert.ok(
      availableUsd !== undefined && availableUsd >= unitPriceUsd,
      "authenticated USD balance is unavailable or insufficient"
    );

    const billableArguments = {
      idempotency_key: billableIdempotencyKey,
      ...configuredBillableArguments,
    };
    const quote = await client.callTool({
      name: billableTool,
      arguments: billableArguments,
    });
    assert.notEqual(quote.isError, true, contentText(quote));
    assert.equal(quote.structuredContent.status, "confirmation_required");
    assert.equal(quote.structuredContent.model_id, billableModel);
    assert.equal(typeof quote.structuredContent.confirmation_token, "string");
    assert.equal(
      quote.structuredContent.pricing.actual.request_price ??
        quote.structuredContent.pricing.actual.base_price,
      unitPriceRaw
    );

    if (availableUsd !== undefined) {
      const balanceAfterQuote = await client.callTool({
        name: "atlas_get_balance",
        arguments: {},
      });
      assert.notEqual(balanceAfterQuote.isError, true);
      const quotedBalance = Number(balanceAfterQuote.structuredContent.available?.value);
      assert.equal(
        quotedBalance,
        availableUsd,
        "quote-only first call changed the available balance"
      );
    }
    passed("generation first call returns a live quote without spending credits");

    billableUpstreamPosts = 1;
    const confirmedArguments = {
      ...billableArguments,
      confirmation_token: quote.structuredContent.confirmation_token,
    };
    const generation = await client.callTool({
      name: billableTool,
      arguments: confirmedArguments,
    });
    assert.notEqual(generation.isError, true, contentText(generation));
    assert.equal(generation.structuredContent.status, "submitted");
    const predictionId = generation.structuredContent.prediction_id;
    assert.equal(typeof predictionId, "string");
    process.stdout.write(
      `BILLABLE_SUBMISSION_ACCEPTED tool=${billableTool} model=${billableModel} ` +
        `prediction_id=${predictionId}\n`
    );

    const replay = await client.callTool({
      name: billableTool,
      arguments: confirmedArguments,
    });
    assert.notEqual(replay.isError, true, contentText(replay));
    assert.equal(replay.structuredContent.prediction_id, predictionId);
    passed("confirmed idempotent replay returns the same prediction without a second task");

    const deadline = Date.now() + billableTimeoutSeconds * 1000;
    let completedOutputs;
    for (;;) {
      const prediction = await client.callTool({
        name: "atlas_get_prediction",
        arguments: { prediction_id: predictionId },
      });
      assert.notEqual(prediction.isError, true, contentText(prediction));
      const predictionStatus = String(prediction.structuredContent.status).toLowerCase();
      if (["completed", "succeeded"].includes(predictionStatus)) {
        assert.ok(prediction.structuredContent.outputs.length > 0);
        completedOutputs = prediction.structuredContent.outputs;
        break;
      }
      assert.ok(
        !["failed", "canceled", "cancelled"].includes(predictionStatus),
        `billable prediction ended with status ${predictionStatus}`
      );
      assert.ok(
        Date.now() < deadline,
        `billable prediction did not finish within ${billableTimeoutSeconds} seconds`
      );
      await delay(5_000);
    }
    process.stdout.write(`BILLABLE_OUTPUTS_JSON=${JSON.stringify(completedOutputs)}\n`);
    const balanceAfterCompletion = await client.callTool({
      name: "atlas_get_balance",
      arguments: {},
    });
    assert.notEqual(balanceAfterCompletion.isError, true);
    const remainingUsd = Number(balanceAfterCompletion.structuredContent.available?.value);
    assert.ok(Number.isFinite(remainingUsd));
    const observedSpendUsd = Math.max(0, availableUsd - remainingUsd);
    assert.ok(
      observedSpendUsd <= billableMaxUsd + 1e-9,
      `observed balance delta exceeds authorized cap of USD ${billableMaxUsd}`
    );
    process.stdout.write(
      `BILLABLE_BALANCE_DELTA_USD=${observedSpendUsd.toFixed(6)} ` +
        `BALANCE_REMAINING_USD=${remainingUsd.toFixed(6)}\n`
    );
    positiveCases += 1;
    passed(
      `one idempotent ${billableTool} generation completes within the authorized USD ${billableMaxUsd} cap`
    );
  }
} finally {
  await client.close();
}

const exhaustedRetry = await tokenRequest({
  grant_type: "refresh_token",
  client_id: registration.client_id,
  refresh_token: tokens.refresh_token,
  resource: mcpUrl,
});
await expectStatus(exhaustedRetry, 400, "exhausted old refresh token retry");
assert.equal((await exhaustedRetry.json()).error, "invalid_grant");
const revokedFamilyRetry = await tokenRequest({
  grant_type: "refresh_token",
  client_id: registration.client_id,
  refresh_token: retryTokens.refresh_token,
  resource: mcpUrl,
});
await expectStatus(revokedFamilyRetry, 400, "revoked refresh token family");
assert.equal((await revokedFamilyRetry.json()).error, "invalid_grant");
passed("refresh rotation allows exactly two bounded retries, then revokes the grant family");

process.stdout.write(
  `LIVE_E2E_COMPLETE oauth=passed mcp_tools=12 positive_cases=${positiveCases} ` +
    `preflight_negative_calls=${readOnlyMode ? 0 : 3} ` +
    `billable_upstream_posts=${billableUpstreamPosts}\n`
);
