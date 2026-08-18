import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { UpstreamOidcConfig } from "../src/auth/config.js";
import { createUpstreamIdentityClient } from "../src/auth/upstream-oidc.js";

async function fixture(): Promise<{
  issuer: string;
  close(): Promise<void>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
    modulusLength: 2048,
  });
  const publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { kid: "upstream-test-key", use: "sig", alg: "RS256" });
  let issuer = "";
  const server = createServer(async (request, response) => {
    if (request.url === "/.well-known/openid-configuration") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        scopes_supported: ["openid", "email", "profile"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        id_token_signing_alg_values_supported: ["RS256"],
      }));
      return;
    }
    if (request.url === "/jwks") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (request.url === "/token" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      assert.match(request.headers.authorization ?? "", /^Basic /);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.ok(form.get("code_verifier"));
      const code = form.get("code") ?? "";
      const nonce = code === "wrong-nonce" ? "not-the-request-nonce" : code.split(".", 1)[0];
      const emailVerified = !code.endsWith(".unverified");
      const idToken = await new SignJWT({
        nonce,
        email: "Person@Example.com",
        email_verified: emailVerified,
        name: "Example Person",
      })
        .setProtectedHeader({ alg: "RS256", kid: "upstream-test-key" })
        .setIssuer(issuer)
        .setAudience("plugin-client")
        .setSubject("upstream-user-1")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id_token: idToken, token_type: "Bearer" }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

test("upstream OIDC uses PKCE and accepts only a signed verified-email identity", async (t) => {
  const upstream = await fixture();
  t.after(() => upstream.close());
  const config: UpstreamOidcConfig = {
    issuer: new URL(upstream.issuer),
    clientId: "plugin-client",
    clientSecret: "plugin-client-secret-that-is-long-enough",
    scopes: ["openid", "email", "profile"],
    endpointHosts: ["127.0.0.1"],
    callbackUrl: new URL("http://plugin.test/upstream/callback"),
  };
  const client = await createUpstreamIdentityClient(config);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const authorization = client.authorizationUrl({ state, nonce, codeVerifier });
  assert.equal(authorization.searchParams.get("state"), state);
  assert.equal(authorization.searchParams.get("nonce"), nonce);
  assert.equal(
    authorization.searchParams.get("code_challenge"),
    createHash("sha256").update(codeVerifier).digest("base64url")
  );
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");

  const account = await client.exchangeCode({
    code: `${nonce}.valid`,
    nonce,
    codeVerifier,
  });
  assert.match(account.sub, /^oidc-[A-Za-z0-9_-]{43}$/);
  assert.equal(account.email, "person@example.com");
  assert.equal(account.name, "Example Person");
  // 派生 sub 是单向哈希，无法反查 Atlas 账号；凭据换取要靠保留下来的原始上游 sub。
  assert.equal(account.upstreamSubject, "upstream-user-1");
  assert.notEqual(account.sub, account.upstreamSubject);
  assert.equal(await client.ready(), true);
});

test("upstream OIDC rejects nonce mismatch and unverified email", async (t) => {
  const upstream = await fixture();
  t.after(() => upstream.close());
  const client = await createUpstreamIdentityClient({
    issuer: new URL(upstream.issuer),
    clientId: "plugin-client",
    clientSecret: "plugin-client-secret-that-is-long-enough",
    scopes: ["openid", "email", "profile"],
    endpointHosts: ["127.0.0.1"],
    callbackUrl: new URL("http://plugin.test/upstream/callback"),
  });
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  await assert.rejects(
    () => client.exchangeCode({ code: "wrong-nonce", nonce, codeVerifier }),
    /nonce does not match/
  );
  await assert.rejects(
    () => client.exchangeCode({ code: `${nonce}.unverified`, nonce, codeVerifier }),
    /verified email/
  );
});

test("upstream OIDC rejects discovered endpoints outside the explicit host allowlist", async (t) => {
  const upstream = await fixture();
  t.after(() => upstream.close());
  await assert.rejects(
    () => createUpstreamIdentityClient({
      issuer: new URL(upstream.issuer),
      clientId: "plugin-client",
      clientSecret: "plugin-client-secret-that-is-long-enough",
      scopes: ["openid", "email", "profile"],
      endpointHosts: ["identity.example.com"],
      callbackUrl: new URL("http://plugin.test/upstream/callback"),
    }),
    /not a safe OIDC endpoint/
  );
});
