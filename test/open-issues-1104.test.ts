// 2026-11-04 验收记录里还开着的几个 MCP 小问题。
// 37：资产没带 mime、地址没有扩展名时，报价卡认不出输入是图片，缩略图是灰的。
// 46：只把文字结果交给模型的客户端（WorkBuddy 引擎）看不到报价令牌。
import assert from "node:assert/strict";
import test from "node:test";
import { generationResultCard } from "../src/apps/generation-quote.js";
import { confirmationReuseNotice } from "../src/services/spend-policy.js";

test("37：地址认不出类型时，按参数字段名认出图片", () => {
  const card = generationResultCard(
    "atlas_generate_video",
    {
      idempotency_key: "7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11",
      model: "bytedance/seedance-2.5/image-to-video",
      params: { prompt: "slow push in", image: "https://atlas-asset-dev.oss-us-west-1.aliyuncs.com/u/1/abcdef?x-oss-signature=1" },
    },
    {
      model_id: "bytedance/seedance-2.5/image-to-video",
      model_name: "Seedance 2.5 Image-to-Video",
      kind: "video",
      status: "confirmation_required",
      confirmation_token: "c2.1793083000.abcdefghijklmnop",
      confirmation_valid_seconds: 600,
      idempotency_key: "7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11",
      estimated_cost_usd: 1.52,
    }
  );
  assert.equal(card?.quote?.inputs?.[0]?.kind, "image");
});

test("46：报价的文字结果里也有确认令牌", () => {
  const text = confirmationReuseNotice("7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11", "c2.1793083000.abcdefghijklmnop");
  assert.match(text, /confirmation_token\*\*: `c2\.1793083000\.abcdefghijklmnop`/);
  assert.doesNotMatch(confirmationReuseNotice("7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11"), /confirmation_token\*\*:/);
});
