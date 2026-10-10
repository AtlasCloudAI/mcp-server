import assert from "node:assert/strict";
import test from "node:test";
import { withResizeParams } from "../src/services/media-preview.js";
import {
  confirmationCostNotice,
  quoteAtDefaults,
  type SpendDecision,
} from "../src/services/spend-policy.js";
import { formatModelInfo } from "../src/utils/formatter.js";
import { schemaDefaults } from "../src/utils/schema-validator.js";
import type { Model } from "../src/types.js";

// ---- 预览保留透明 ----

test("PNG 原图的预览转 WebP（保 alpha），JPG 原图仍转 JPG", () => {
  const png = withResizeParams("https://b.oss-us-west-1.aliyuncs.com/i/a.png");
  const jpg = withResizeParams("https://b.oss-us-west-1.aliyuncs.com/i/a.jpg");
  const bare = withResizeParams("https://b.oss-us-west-1.aliyuncs.com/i/a");
  assert.match(new URL(png!).searchParams.get("x-oss-process") ?? "", /format,webp/);
  assert.match(new URL(jpg!).searchParams.get("x-oss-process") ?? "", /format,jpg/);
  // 看不出格式的（签名链接常见）按可能带透明处理
  assert.match(new URL(bare!).searchParams.get("x-oss-process") ?? "", /format,webp/);
});

// ---- 价格：起步价不当总价，确认时给实算报价 ----

const decision = (over: Partial<SpendDecision>): SpendDecision => ({
  autoSubmit: false,
  quotedUsd: 34.18368,
  thresholdUsd: 20,
  reason: "quote is at or above the threshold",
  ...over,
});

test("需要确认时给出这一单的实算报价，而不是目录起步价", () => {
  assert.match(confirmationCostNotice(decision({})), /\$34\.18 for these exact parameters/);
  assert.match(
    confirmationCostNotice(decision({ partial: true, quotedUsd: 6.37 })),
    /at least \$6\.37/
  );
  assert.match(confirmationCostNotice(decision({ quotedUsd: null })), /not available/);
});

const studioSchema = {
  components: {
    schemas: {
      Input: {
        type: "object",
        properties: {
          model: { type: "string", default: "atlascloud/studio/product-visuals" },
          product_image: { type: "string" },
          ratio: { type: "string", default: "1:1" },
          count: { type: "integer", default: 1 },
        },
      },
    },
  },
};

test("schemaDefaults 取出带默认值的参数，不含 model", () => {
  assert.deepEqual(schemaDefaults(studioSchema), { ratio: "1:1", count: 1 });
});

test("默认参数报价：带上 schema 默认值去问计价接口；文本模型跳过；失败不抛", async (t) => {
  const previousKey = process.env.ATLASCLOUD_API_KEY;
  process.env.ATLASCLOUD_API_KEY = "test-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = previousKey;
  });
  let sentBody: unknown;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ code: 200, data: { price: "0.2593" } }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const quote = await quoteAtDefaults(
    { model: "atlascloud/studio/product-visuals", type: "Image" },
    studioSchema,
    { fetcher }
  );
  assert.deepEqual(quote, { usd: 0.2593, partial: false });
  assert.deepEqual(sentBody, { model: "atlascloud/studio/product-visuals", ratio: "1:1", count: 1 });

  assert.equal(await quoteAtDefaults({ model: "x/llm", type: "Text" }, null, { fetcher }), null);

  const failing = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  assert.equal(await quoteAtDefaults({ model: "m", type: "Video" }, null, { fetcher: failing }), null);
});

test("模型文档：先给默认参数实算价，起步价标明不是单次总价，不再写 /request", () => {
  const model = {
    model: "atlascloud/studio/listing-image-set",
    displayName: "Listing Image Generator",
    type: "Image",
    price: { discount: "100", actual: { base_price: "0.021" } },
  } as unknown as Model;
  const text = formatModelInfo(model, { usd: 0.1408, partial: false });
  assert.match(text, /Estimated price at default parameters\*\*: \$0\.1408/);
  assert.match(text, /Catalog unit price: \$0\.021 — a starting rate/);
  assert.ok(!text.includes("/request"), text);
  // 拿不到报价时仍给起步价说明
  assert.match(formatModelInfo(model, null), /Catalog unit price/);
});
