// 报价卡模型那一行（设计稿 v3，11-11 Claude 设计对比第 2、3 条）和资产库长条图缩略图（E1）。

import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_REASON_MAX, isLopsided, modelCardExtras } from "../src/apps/card-params.js";
import { generationResultCard } from "../src/apps/generation-quote.js";
import { generationStructuredContent, generationWhyThisModelSchema } from "../src/tool-contracts.js";
import type { Model } from "../src/types.js";
import { cardFromToolResult } from "../ui/generation-card/card.js";

const ICON = "https://static.atlascloud.ai/model/logo/bytedance-seedance-2.5-image-to-video.png";

const QUOTE = {
  status: "confirmation_required",
  model_id: "bytedance/seedance-2.5/image-to-video",
  model_name: "Seedance 2.5 Image-to-Video",
  model_avatar: ICON,
  kind: "video",
  confirmation_token: "c2.x",
  idempotency_key: "k-1",
  confirmation_valid_seconds: 3600,
  estimated_cost_usd: 1.52,
  params: { prompt: "A slow push-in", image: "https://cdn.example.com/u/a.jpg", duration: 5 },
};

const ARGS = {
  model: "bytedance/seedance-2.5/image-to-video",
  params: { prompt: "A slow push-in" },
  why_this_model: "Keeps the product sharp and follows the photo's framing.",
};

test("模型行：图标取 model_avatar，理由取模型写的 why_this_model", () => {
  assert.deepEqual(modelCardExtras(QUOTE, ARGS), {
    model_icon: ICON,
    model_reason: "Keeps the product sharp and follows the photo's framing.",
  });
});

test("模型行：非 https 图标不要，空白理由不要，长理由截断成一句", () => {
  assert.deepEqual(modelCardExtras({ model_avatar: "http://x/a.png" }, { why_this_model: "   " }), {});
  assert.deepEqual(modelCardExtras({ model_avatar: "" }, {}), {});
  const long = modelCardExtras({}, { why_this_model: `Fast  and\ncheap ${"x".repeat(400)}` }).model_reason ?? "";
  assert.equal(long.length, MODEL_REASON_MAX);
  assert.ok(long.startsWith("Fast and cheap "), long);
  assert.ok(long.endsWith("…"), long);
});

test("服务端拼的报价卡和提交后的卡都带图标和理由", () => {
  const quote = generationResultCard("atlas_generate_video", ARGS, QUOTE);
  assert.equal(quote?.model_icon, ICON);
  assert.equal(quote?.model_reason, ARGS.why_this_model);
  // 理由不算请求的一部分：确认时原样带回给生成工具，不影响比对。
  assert.equal(quote?.quote?.arguments.why_this_model, ARGS.why_this_model);

  const submitted = generationResultCard("atlas_generate_video", { ...ARGS, confirmed: true }, {
    status: "submitted",
    prediction_id: "p1",
    model_id: QUOTE.model_id,
    model_name: QUOTE.model_name,
    model_avatar: ICON,
    kind: "video",
  });
  assert.equal(submitted?.model_icon, ICON);
});

test("Cursor 兜底（只有结构化结果）也带图标和理由", () => {
  const card = cardFromToolResult({ structuredContent: QUOTE }, { tool: "atlas_generate_video", args: ARGS });
  assert.equal(card?.model_icon, ICON);
  assert.equal(card?.model_reason, ARGS.why_this_model);
});

test("why_this_model 是可选的一句话", () => {
  assert.equal(generationWhyThisModelSchema.safeParse(undefined).success, true);
  assert.equal(generationWhyThisModelSchema.safeParse("Good at text in images.").success, true);
  assert.equal(generationWhyThisModelSchema.safeParse("x".repeat(301)).success, false);
});

test("资产库缩略图：长宽比 1.5 倍及以上整张显示，接近方形的照旧铺满", () => {
  assert.equal(isLopsided(180, 320), true); // 9:16 竖图
  assert.equal(isLopsided(1600, 400), true); // 横幅
  assert.equal(isLopsided(300, 200), true); // 3:2
  assert.equal(isLopsided(400, 300), false); // 4:3
  assert.equal(isLopsided(512, 512), false);
  assert.equal(isLopsided(0, 100), false); // 还没加载出尺寸
});

test("工具结果的 model_avatar 取目录的 logo，不取打不开的 avatar；不是 https 就不给", () => {
  const model: Model = {
    uuid: "u",
    model: "bytedance/seedance-2.5/image-to-video",
    type: "Video",
    displayName: "Seedance 2.5 Image-to-Video",
    profile: "",
    avatar: "https://static.atlascloud.ai/model/avatar/BYTEDANCE.png",
    logo: ICON,
    readme: "",
    tags: [],
  };
  assert.equal(generationStructuredContent("p1", model, "video").model_avatar, ICON);
  assert.equal(generationStructuredContent("p1", { ...model, logo: "" }, "video").model_avatar, undefined);
  assert.equal(generationStructuredContent("p1", { ...model, logo: "http://x/a.png" }, "video").model_avatar, undefined);
});
