import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ATLAS_API_ORIGIN, resolveAtlasApiOrigin } from "../src/constants.js";

test("atlas API origin defaults to production when unset or empty", () => {
  assert.equal(resolveAtlasApiOrigin({}), DEFAULT_ATLAS_API_ORIGIN);
  assert.equal(resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "   " }), DEFAULT_ATLAS_API_ORIGIN);
});

test("atlas API origin accepts an https origin for an isolated environment", () => {
  assert.equal(
    resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "https://api.dev.atlascloud.ai" }),
    "https://api.dev.atlascloud.ai"
  );
  // 末尾斜杠是常见写法，不该因此被拒。
  assert.equal(
    resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "https://api.dev.atlascloud.ai/" }),
    "https://api.dev.atlascloud.ai"
  );
});

test("atlas API origin allows http only for loopback and in-cluster DNS", () => {
  assert.equal(
    resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "http://127.0.0.1:9099" }),
    "http://127.0.0.1:9099"
  );
  // 集群内 Service DNS 不经过公网，允许明文；这是 dev 指向自己 Atlas 的路径。
  assert.equal(
    resolveAtlasApiOrigin({
      ATLASCLOUD_API_BASE_URL: "http://backend.atlascloud-dev.svc.cluster.local:9099",
    }),
    "http://backend.atlascloud-dev.svc.cluster.local:9099"
  );
  // 公网域名依然强制 https，不能借道这个例外。
  assert.throws(
    () => resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "http://api.dev.atlascloud.ai" }),
    /must use https/
  );
  assert.throws(
    () => resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "http://evil.svc.cluster.local.example.com" }),
    /must use https/
  );
});

// 生产版本指向另一个 Atlas，只会在客户看到别人的数据时才暴露，所以直接拒绝。
test("a production release refuses to override the Atlas API origin", () => {
  assert.throws(
    () =>
      resolveAtlasApiOrigin({
        PLUGIN_RELEASE_TIER: "production",
        ATLASCLOUD_API_BASE_URL: "https://api.dev.atlascloud.ai",
      }),
    /must not override/
  );
  // 显式填成默认值不算覆盖，允许。
  assert.equal(
    resolveAtlasApiOrigin({
      PLUGIN_RELEASE_TIER: "production",
      ATLASCLOUD_API_BASE_URL: DEFAULT_ATLAS_API_ORIGIN,
    }),
    DEFAULT_ATLAS_API_ORIGIN
  );
});

test("atlas API origin rejects paths, credentials, and malformed values", () => {
  // 带 path 会拼成 /api/v1/api/v1/...，必须挡住。
  assert.throws(
    () => resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "https://api.dev.atlascloud.ai/api/v1" }),
    /bare origin/
  );
  assert.throws(
    () => resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "https://api.dev.atlascloud.ai?x=1" }),
    /bare origin/
  );
  assert.throws(
    () => resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "https://user:pw@api.dev.atlascloud.ai" }),
    /credentials/
  );
  assert.throws(
    () => resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "not-a-url" }),
    /not a valid URL/
  );
});

test("derived API bases all come from the same origin", async () => {
  const { API_BASE, LLM_API_BASE, PUBLIC_API_BASE, ATLAS_API_ORIGIN } = await import(
    "../src/constants.js"
  );
  assert.equal(API_BASE, `${ATLAS_API_ORIGIN}/api/v1`);
  assert.equal(LLM_API_BASE, `${ATLAS_API_ORIGIN}/v1`);
  assert.equal(PUBLIC_API_BASE, `${ATLAS_API_ORIGIN}/public/v1`);
});

test("OpenAI 兼容端点可以独立指向另一个上游", () => {
  // 集群内是两个 Service：/api/v1 与 /public/v1 在 backend，/v1 在 aiproxy。
  // 只有后者认 OAuth 令牌，所以这两个 origin 必须能分开配。
  assert.equal(
    resolveAtlasApiOrigin(
      {
        ATLASCLOUD_API_BASE_URL: "http://backend.atlascloud-dev.svc.cluster.local:9099",
        ATLASCLOUD_GENERATION_API_BASE_URL:
          "http://aiproxy-service.atlascloud-dev.svc.cluster.local",
      },
      "ATLASCLOUD_GENERATION_API_BASE_URL"
    ),
    "http://aiproxy-service.atlascloud-dev.svc.cluster.local"
  );
});

test("独立 origin 沿用同一套校验，且报错点名正确的变量", () => {
  for (const [value, pattern] of [
    ["not-a-url", /ATLASCLOUD_GENERATION_API_BASE_URL is not a valid URL/],
    ["http://example.com", /ATLASCLOUD_GENERATION_API_BASE_URL must use https/],
    ["https://u:p@api.test", /ATLASCLOUD_GENERATION_API_BASE_URL must not contain credentials/],
    ["https://api.test/v1", /ATLASCLOUD_GENERATION_API_BASE_URL must be a bare origin/],
  ] as Array<[string, RegExp]>) {
    assert.throws(
      () =>
        resolveAtlasApiOrigin(
          { ATLASCLOUD_GENERATION_API_BASE_URL: value },
          "ATLASCLOUD_GENERATION_API_BASE_URL"
        ),
      pattern,
      value
    );
  }
});

test("production 发布同样拒绝独立 origin 的覆盖", () => {
  assert.throws(
    () =>
      resolveAtlasApiOrigin(
        {
          PLUGIN_RELEASE_TIER: "production",
          ATLASCLOUD_GENERATION_API_BASE_URL: "https://api.dev.atlascloud.ai",
        },
        "ATLASCLOUD_GENERATION_API_BASE_URL"
      ),
    /must not override the Atlas API origin in a production release/
  );
});
