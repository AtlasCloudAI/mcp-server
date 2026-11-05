// 2026-11-04 第 15 轮在 Claude Code 里发现的两个问题（它只看结构化结果）。
// 50：把目录单价 pricing.actual.base_price 当成这一单的价格告诉用户。
// 51：拿示例 UUID 当幂等键，和以前用过的撞了，确认时才失败。
import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { issueGenerationConfirmation, resolveConfirmedIdempotencyKey } from "../src/services/generation-confirmation.js";
import { InMemoryIdempotencyStore, executeIdempotently } from "../src/services/idempotency.js";
import { runWithRequestContext } from "../src/services/request-context.js";
import { generationConfirmationStructuredContent, priceToTellUser } from "../src/tool-contracts.js";
import type { Model } from "../src/types.js";

const EXAMPLE_KEY = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const pricing = { actual: { base_price: "0.036" } };
const request = (prompt: string) => ({
  resolved_model: "bytedance/seedream-v5.0-pro/text-to-image",
  request_body: { model: "bytedance/seedream-v5.0-pro/text-to-image", prompt },
});

function withContext<T>(store: InMemoryIdempotencyStore, operation: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    {
      authInfo: { token: "t", clientId: "https://claude.ai/oauth/claude-code-client-metadata", scopes: ["tasks:write"] } as AuthInfo,
      subject: "r15-user",
      atlasApiKey: "not-used",
      idempotencyStore: store,
      idempotencyTtlSeconds: 600,
      generationConfirmationSecret: "test-confirmation-secret-that-is-long-enough",
      generationConfirmationTtlSeconds: 600,
    },
    operation
  );
}

test("50：报价的结构化结果里，单价不叫 pricing，总价有一句现成的说法", () => {
  const structured = generationConfirmationStructuredContent(
    { model: "bytedance/seedream-v5.0-pro/text-to-image", displayName: "Seedream v5.0 Pro" } as Model,
    "image",
    {
      confirmationToken: "c2.1793083000.abcdefghijklmnop",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      idempotencyKey: "7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11",
      pricing,
    },
    { usd: 0.072, partial: false }
  ) as Record<string, unknown>;
  assert.equal("pricing" in structured, false);
  assert.deepEqual(structured.catalog_unit_pricing, pricing);
  assert.equal(structured.estimated_cost_usd, 0.072);
  assert.match(String(structured.price_to_tell_user), /\$0\.072 in total/);
  // 和卡片同一种写法（设计走查 F3）：一美元以上到分，以下最多 4 位小数。
  assert.match(priceToTellUser(1.524341, true), /\$1\.52 in total \(estimated_cost_usd\), settled on actual usage/);
  assert.match(priceToTellUser(0.59746528, false), /\$0\.5975 in total/);
});

test("51：报价用的键已经提交过另一单，就换新键报价；确认时传旧键也能找回新键", async () => {
  const store = new InMemoryIdempotencyStore();
  await withContext(store, async () => {
    // 上一轮用这个示例键提交过一张别的图。
    await executeIdempotently(
      "atlas_generate_image",
      { idempotency_key: EXAMPLE_KEY, ...request("an earlier poster") },
      EXAMPLE_KEY,
      async () => ({ ok: true, predictionId: "earlier" })
    );
    const quote = await issueGenerationConfirmation("atlas_generate_image", EXAMPLE_KEY, request("a new poster"), pricing);
    assert.notEqual(quote.idempotencyKey, EXAMPLE_KEY);
    const resolved = await resolveConfirmedIdempotencyKey(
      quote.confirmationToken,
      "atlas_generate_image",
      EXAMPLE_KEY,
      request("a new poster"),
      pricing
    );
    assert.equal(resolved.idempotencyKey, quote.idempotencyKey);

    // 同一单再报一次价（参数一样）照旧用原键：确认时拿回原来那一单，不会重复扣钱。
    const again = await issueGenerationConfirmation("atlas_generate_image", EXAMPLE_KEY, request("an earlier poster"), pricing);
    assert.equal(again.idempotencyKey, EXAMPLE_KEY);
  });
});
