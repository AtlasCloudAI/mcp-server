/**
 * 令牌契约 §9 的官方测试向量。
 *
 * 这份 JSON 与授权服务器（kubedl）和 aiproxy 各自 vendor 的那份**字节级相同**，
 * 由授权服务器侧生成。契约要求每个资源服务器都在自己的 CI 里跑它——三方实现
 * 各写各的解释，只有跑同一组令牌才能证明解释一致。
 *
 * 更新方式：从 kubedl 的
 * `console/backend/pkg/authzserver/testdata/token_contract_vectors.json`
 * 整份复制，不要手改这里的任何一个字节。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLocalJWKSet, type JSONWebKeySet } from "jose";
import { loadHttpServerConfig } from "../src/config.js";
import { JwtAccessTokenVerifier } from "../src/http/auth.js";

interface Vector {
  note: string;
  jwks: JSONWebKeySet;
  issuer: string;
  resource: string;
  required_scopes_for_baseline: string[];
  cases: Array<{ name: string; token: string; expect: number; reason: string }>;
}

const vectors = JSON.parse(
  readFileSync(new URL("./testdata/token_contract_vectors.json", import.meta.url), "utf8")
) as Vector;

function verifierForVectors() {
  const config = loadHttpServerConfig({
    NODE_ENV: "test",
    MCP_PUBLIC_URL: "https://mcp.atlascloud.ai/mcp",
    // 向量里的 issuer 与 resource 逐字使用：它们测的是校验逻辑，不是我们的身份
    MCP_OAUTH_ISSUER: vectors.issuer,
    MCP_OAUTH_AUDIENCE: vectors.resource,
    MCP_OAUTH_JWKS_URI: `${vectors.issuer}/api/v1/oidc/jwks`,
    MCP_OAUTH_ENDPOINT_HOSTS: new URL(vectors.issuer).host,
    MCP_ALLOWED_HOSTS: "mcp.atlascloud.ai",
    MCP_ALLOWED_ORIGINS: "https://chatgpt.com",
    ATLASCLOUD_API_KEY: "test-atlas-key",
    MCP_IDEMPOTENCY_BACKEND: "memory",
  });
  return new JwtAccessTokenVerifier(config, createLocalJWKSet(vectors.jwks));
}

const caseOf = (name: string) => {
  const found = vectors.cases.find((c) => c.name === name);
  assert.ok(found, `向量里缺少用例 ${name}`);
  return found;
};

test("契约 §9：所有 401 向量都被拒绝", async () => {
  const verifier = verifierForVectors();
  const rejected = vectors.cases.filter((c) => c.expect === 401);
  assert.ok(rejected.length >= 8, `401 用例太少（${rejected.length}），向量文件可能不完整`);
  for (const c of rejected) {
    await assert.rejects(
      () => verifier.verifyAccessToken(c.token),
      (error: unknown) => {
        assert.ok(error instanceof Error, c.name);
        return true;
      },
      `${c.name}: ${c.reason}`
    );
  }
});

test("契约 §9：基线令牌必须通过，否则整组拒绝都不说明问题", async () => {
  const verifier = verifierForVectors();
  const baseline = caseOf("baseline");
  const auth = await verifier.verifyAccessToken(baseline.token);
  assert.deepEqual(
    [...auth.scopes].sort(),
    [...vectors.required_scopes_for_baseline].sort(),
    "基线令牌的 scope 应与向量声明一致"
  );
  assert.equal(auth.resource?.toString(), new URL(vectors.resource).toString());
  assert.ok((auth.extra as Record<string, unknown>).sub, "sub 必须带出来");
});

test("契约 §9：scope 不足的向量在工具层是 403，不是在验签层拒绝", async () => {
  const verifier = verifierForVectors();
  const c = caseOf("insufficient_scope");
  // 令牌本身是有效的——验签、iss、aud、exp 都对，所以 verifier 必须接受它。
  // 403 由 enforceToolScopes 在知道「这次要调哪个工具」之后给出（契约 §6 第 6 步）。
  const auth = await verifier.verifyAccessToken(c.token);
  const missing = vectors.required_scopes_for_baseline.filter((s) => !auth.scopes.includes(s));
  assert.ok(missing.length > 0, "这条向量的令牌应当缺少某个必需 scope");
});

test("契约 §9：account_id 必须原样带到下游供成员关系校验", async () => {
  const verifier = verifierForVectors();
  const c = caseOf("account_not_owned_by_subject");
  // 契约 §6 第 7 步要求校验 account_id 与 sub 的成员关系。MCP server 没有账户
  // 成员数据，做不了这一步——它由持有数据的一侧（模型 API）在收到换出的令牌时执行。
  // 我们这一层能保证的是：account_id 被原样带出，不被篡改也不被丢弃，否则下游
  // 连判断的依据都没有。
  const auth = await verifier.verifyAccessToken(c.token);
  const extra = auth.extra as Record<string, unknown>;
  const claims = JSON.parse(Buffer.from(c.token.split(".")[1], "base64url").toString()) as Record<string, unknown>;
  assert.equal(extra.account_id, String(claims.account_id));
});

test("契约 §9：vendored 的向量文件没有被本地改动过", () => {
  // 三方必须跑字节级相同的文件。这里锁住体积与关键字段，改动时会立刻暴露。
  const raw = readFileSync(new URL("./testdata/token_contract_vectors.json", import.meta.url));
  assert.equal(raw.byteLength, 12145, "向量文件字节数变了：要么被改过，要么上游发了新版本");
  assert.equal(vectors.issuer, "https://console.atlascloud.ai");
  assert.equal(vectors.resource, "https://api.atlascloud.ai");
  assert.equal(vectors.cases.length, 11);
});
