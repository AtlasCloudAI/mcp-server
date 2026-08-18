import assert from "node:assert/strict";
import test from "node:test";
import { createFederatedCredentialExchange } from "../src/services/federated-credential-exchange.js";

const url = new URL("https://api.atlascloud.ai/api/v1/federated/credential");
const token = "federated-service-token-0123456789";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("credential exchange sends the dedicated secret and returns the linked key", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: Headers | undefined;
  let seenBody: unknown;
  const exchange = createFederatedCredentialExchange({ url, token }, async (input, init) => {
    seenUrl = String(input);
    seenHeaders = new Headers(init?.headers);
    seenBody = JSON.parse(String(init?.body));
    // Atlas 成功响应统一包一层 { code, data }。
    return jsonResponse(200, { code: "200", data: { apiKey: "apikey-abc123", created: true } });
  });

  const key = await exchange.exchange({
    issuer: "https://accounts.google.com",
    subject: "google-sub-123",
  });

  assert.equal(key, "apikey-abc123");
  assert.equal(seenUrl, url.toString());
  assert.equal(seenHeaders?.get("x-federated-auth"), token);
  assert.equal(seenHeaders?.get("content-type"), "application/json");
  assert.deepEqual(seenBody, {
    issuer: "https://accounts.google.com",
    subject: "google-sub-123",
  });
});

test("credential exchange treats 404 as no linked Atlas account", async () => {
  const exchange = createFederatedCredentialExchange({ url, token }, async () =>
    jsonResponse(404, { error: "no Atlas account matches this identity" })
  );

  // 这是唯一的预期负向结果：调用方据此回落到手工粘贴，而不是让登录失败。
  assert.equal(
    await exchange.exchange({ issuer: "https://accounts.google.com", subject: "nobody" }),
    undefined
  );
});

test("credential exchange surfaces auth and server failures instead of degrading silently", async () => {
  for (const status of [401, 403, 500, 502]) {
    const exchange = createFederatedCredentialExchange({ url, token }, async () =>
      jsonResponse(status, { error: "nope" })
    );
    await assert.rejects(
      exchange.exchange({ issuer: "https://accounts.google.com", subject: "google-sub-123" }),
      new RegExp(String(status))
    );
  }
});

test("credential exchange rejects a non-JSON or malformed response", async () => {
  const html = createFederatedCredentialExchange({ url, token }, async () =>
    new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } })
  );
  await assert.rejects(
    html.exchange({ issuer: "https://accounts.google.com", subject: "google-sub-123" }),
    /did not return JSON/
  );

  const missingKey = createFederatedCredentialExchange({ url, token }, async () =>
    jsonResponse(200, { code: "200", data: { created: true } })
  );
  await assert.rejects(
    missingKey.exchange({ issuer: "https://accounts.google.com", subject: "google-sub-123" })
  );
});

test("credential exchange refuses to follow redirects", async () => {
  let seenRedirect: RequestRedirect | undefined;
  const exchange = createFederatedCredentialExchange({ url, token }, async (_input, init) => {
    seenRedirect = init?.redirect;
    return jsonResponse(200, { code: "200", data: { apiKey: "apikey-abc123" } });
  });

  await exchange.exchange({ issuer: "https://accounts.google.com", subject: "google-sub-123" });

  // 跟 discovery 一样：跟随重定向等于允许把带密钥的请求转投到别处。
  assert.equal(seenRedirect, "error");
});
