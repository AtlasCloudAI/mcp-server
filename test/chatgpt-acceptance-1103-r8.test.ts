// 2026-11-03 ChatGPT 第 8 轮验收：quick_generate 和三个生成工具对不齐（问题 29、31），资产编号填进参数（问题 31），
// 失败卡片的原因看不懂（问题 33）。
// Atlas 接口地址在模块加载时就定下来了，所以先起假 AssetD、设环境变量，再动态 import 服务端。
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import type { Model } from "../src/types.js";
import { readableReason } from "../ui/generation-card/card.js";

const KNOWN = new Set(["asset_61aea8e609c65b8df4caab40752b2584"]);
let signature = 0;
let fake: Server;

before(async () => {
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/assetd/api/assets/source-urls" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const ids = (JSON.parse(body) as { asset_ids: string[] }).asset_ids;
        if (ids.some((id) => !KNOWN.has(id))) {
          res.statusCode = 404;
          res.end(JSON.stringify({ code: 404, msg: "not_found", error: { code: "not_found", retryable: false } }));
          return;
        }
        res.end(
          JSON.stringify({
            code: 200,
            msg: "succeed",
            data: {
              items: ids.map((id) => ({
                asset_id: id,
                source_url: `https://atlas-asset-dev.oss-us-west-1.aliyuncs.com/${id}/original/a.jpg?Expires=${++signature}`,
                expires_at: "2026-11-03T11:00:00Z",
                mime_type: "image/jpeg",
              })),
            },
          })
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.ATLASCLOUD_API_BASE_URL = origin;
  process.env.ATLASCLOUD_GENERATION_API_BASE_URL = origin;
  process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
  process.env.MCP_INPUT_LINK_CHECK = "off";
});

after(() => new Promise<void>((resolve) => fake.close(() => resolve())));

const ID = "asset_61aea8e609c65b8df4caab40752b2584";

test("asset://asset_… and bare asset_… in params become Asset Library URLs; original remembers what the model wrote", async () => {
  const { resolveAssetReferences } = await import("../src/tools/assets.js");
  const out = await resolveAssetReferences({ image: `asset://${ID}`, prompt: `keep ${ID} as text` });
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.match(String(out.params.image), /^https:\/\/atlas-asset-dev\.oss-us-west-1\.aliyuncs\.com\/asset_61aea8e6/);
  // 提示词里提到编号不算：只换整串就是编号的值。
  assert.equal(out.params.prompt, `keep ${ID} as text`);
  assert.equal(out.original.get(String(out.params.image)), `asset://${ID}`);

  const bare = await resolveAssetReferences({ images: [ID] });
  assert.ok(bare.ok);
  if (!bare.ok) return;
  const url = String((bare.params.images as string[])[0]);
  assert.match(url, /^https:\/\//);
  assert.equal(bare.original.get(url), ID);
});

test("an asset reference that isn't in the library stops before anything is submitted", async () => {
  const { resolveAssetReferences } = await import("../src/tools/assets.js");
  const out = await resolveAssetReferences({ image: "asset://asset_00000000000000000000000000000000" });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.message, /not in this account's Asset Library/);
  assert.match(out.message, /Nothing was submitted or charged/);
});

test("confirming: the token is checked against what the model wrote, the submit gets a fresh URL", async () => {
  const { libraryInputs, replaceUrls } = await import("../src/tools/assets.js");
  const quote = await libraryInputs({ image: `asset://${ID}` }, false);
  const confirm = await libraryInputs({ image: `asset://${ID}` }, true);
  assert.ok(quote.ok && confirm.ok);
  if (!quote.ok || !confirm.ok) return;
  // 每次换到的签名都不同，但换回去都是模型传的那个值。
  assert.notEqual(quote.params.image, confirm.params.image);
  assert.deepEqual(replaceUrls(quote.params, quote.original), { image: `asset://${ID}` });
  assert.deepEqual(replaceUrls(confirm.params, confirm.original), { image: `asset://${ID}` });
});

const PRODUCT_VISUALS = {
  components: {
    schemas: {
      Input: {
        type: "object",
        properties: {
          model: { type: "string" },
          product_image: { type: "string", "x-format": "image", description: "商品图，必填。" },
          model_image: { type: "string", "x-format": "image", description: "模特图，选填。" },
          user_prompt: { type: "string", description: "Prompt for the ad." },
          ratio: { type: "string", enum: ["1:1", "9:16"], default: "9:16" },
          resolution: { type: "string", enum: ["1k", "2k"], default: "2k" },
          visual_type: { type: "string", default: "product_hero" },
        },
        required: ["model", "product_image", "user_prompt"],
      },
    },
  },
};

const HAPPYHORSE = {
  components: {
    schemas: {
      Input: {
        type: "object",
        properties: {
          model: { type: "string" },
          prompt: { type: "string" },
          images: { type: "array", items: { type: "string" }, description: "Reference image URLs. Provide 1 to 9 images." },
          ratio: { type: "string", default: "16:9" },
        },
        required: ["model", "prompt", "images"],
      },
    },
  },
};

test("quick_generate puts image_url into product_image, and wraps it for an images array", async () => {
  const { buildQuickGenerateParams } = await import("../src/tools/quick-generate.js");
  const visuals = buildQuickGenerateParams(PRODUCT_VISUALS, "atlascloud/studio/product-visuals", "ad", "https://x/p.png", undefined, {
    user_prompt: "white headphones on marble",
  });
  assert.equal(visuals.product_image, "https://x/p.png");
  assert.equal(visuals.model_image, undefined);
  const horse = buildQuickGenerateParams(HAPPYHORSE, "alibaba/happyhorse-1.1/reference-to-video", "slow push in", "https://x/p.png");
  assert.deepEqual(horse.images, ["https://x/p.png"]);
});

test("quick_generate's shared preparation fills every workflow default (problem 29 on the quick path)", async () => {
  const { prepareWithSchema } = await import("../src/services/generation.js");
  const model = { model: "atlascloud/studio/product-visuals", type: "Image", displayName: "Image ads" } as unknown as Model;
  const out = await prepareWithSchema(
    model,
    PRODUCT_VISUALS,
    { product_image: "https://x/p.png", user_prompt: "white headphones", ratio: "1:1" },
    { expectedType: "Image", endpoint: "/model/generateImage", typeLabel: "image", readInputShapes: true }
  );
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.deepEqual(out.prepared.body, {
    model: "atlascloud/studio/product-visuals",
    product_image: "https://x/p.png",
    user_prompt: "white headphones",
    ratio: "1:1",
    resolution: "2k",
    visual_type: "product_hero",
  });
});

test("failed card reason: the gateway's message instead of the raw HTTP dump", () => {
  const raw =
    'unexpected http status code: 502, body: {"code":400,"message":"workflow error: Missing required parameters：\'resolution\'","data":null}';
  assert.equal(readableReason(raw), "A required setting was missing: resolution.");
  // body 被截断，JSON 解析不了：照样取出 message。
  assert.equal(
    readableReason('unexpected http status code: 500, body: {"code":500,"message":"upstream timeout while rendering the vi'),
    "upstream timeout while rendering the vi"
  );
  assert.equal(readableReason("unexpected http status code: 502, body: <html>bad gateway</html>"), "Atlas Cloud returned an error (HTTP 502).");
  assert.equal(readableReason("Not enough balance. Nothing was charged."), "Not enough balance. Nothing was charged.");
});
