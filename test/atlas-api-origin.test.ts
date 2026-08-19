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

test("atlas API origin allows http only for loopback", () => {
  assert.equal(
    resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "http://127.0.0.1:9099" }),
    "http://127.0.0.1:9099"
  );
  assert.throws(
    () => resolveAtlasApiOrigin({ ATLASCLOUD_API_BASE_URL: "http://api.dev.atlascloud.ai" }),
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
