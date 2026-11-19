import assert from "node:assert/strict";
import test from "node:test";
import { buildGenerationCardData, cardPrompt } from "../src/apps/generation-card.js";
import { cardFromToolResult } from "../ui/generation-card/card.js";
import { historyDetailButtons, historyFromToolResult, isTruncatedSnippet } from "../ui/generation-card/history.js";

// 11-13 Cursor 回归：Cursor 不把工具结果的 _meta 转给卡片，卡片只能从 structuredContent 推数据。

test("Cursor 历史列表：兜底数据带上实扣和没截断的提示词，成功单详情能出 Reuse prompt", () => {
  const long = `${"x".repeat(157)}...`;
  const data = historyFromToolResult({
    structuredContent: {
      total: 3,
      page: 1,
      size: 10,
      has_more: false,
      predictions: [
        { prediction_id: "p1", model: "z-image/turbo", status: "completed", outputs: ["https://a/x.png"], prompt: "白桌上的绿色小方块", charged_usd: 0.015 },
        { prediction_id: "p2", model: "m", status: "completed", outputs: [], prompt: long, charged_usd: 0 },
        { prediction_id: "p3", model: "m", status: "failed", outputs: [] },
      ],
    },
  });
  assert.ok(data);
  const [p1, p2, p3] = data.items;
  assert.equal(p1?.prompt, "白桌上的绿色小方块");
  assert.equal(p1?.price_usd, 0.015);
  // 截断的片段不当原文：交给点开详情时 atlas_card_status 带回的完整提示词。
  assert.equal(p2?.prompt, undefined);
  assert.equal(p2?.price_usd, 0);
  assert.equal(p3?.prompt, undefined);
  assert.equal(p3?.price_usd, undefined);
  assert.deepEqual(historyDetailButtons("succeeded", Boolean(p1?.prompt), true), ["keep-download", "reuse"]);
});

test("截断判断只认 list_predictions 的 157 字 + ... 格式", () => {
  assert.equal(isTruncatedSnippet(`${"a".repeat(157)}...`), true);
  assert.equal(isTruncatedSnippet("wait..."), false);
  assert.equal(isTruncatedSnippet("a".repeat(160)), false);
});

test("卡片数据带提示词原文：atlas_card_status 的 structuredContent.card 里有，Cursor 详情能用", () => {
  assert.equal(cardPrompt({ prompt: "  a blue paper airplane  " }), "a blue paper airplane");
  assert.equal(cardPrompt({ prompt: "x".repeat(2500) })?.length, 2000);
  assert.equal(cardPrompt({ prompt: "   " }), undefined);
  assert.equal(cardPrompt(undefined), undefined);
  const card = buildGenerationCardData({
    predictionId: "p1",
    status: "completed",
    outputs: ["https://a/x.png"],
    transferPending: false,
    prompt: "a blue paper airplane",
  });
  assert.equal(card.prompt, "a blue paper airplane");
  assert.equal(cardFromToolResult({ structuredContent: { card } })?.prompt, "a blue paper airplane");
  const plain = buildGenerationCardData({ predictionId: "p2", status: "completed", outputs: [], transferPending: false });
  assert.equal("prompt" in plain, false);
});

test("自检卡在 Cursor 里也认得出是样例：结构化结果的 sample 标记带进卡片", () => {
  const image = cardFromToolResult({
    structuredContent: { prediction_id: "selftest_image", status: "completed", outputs: ["https://a/x.png"], sample: true },
  });
  assert.equal(image?.sample, true);
  const quote = cardFromToolResult(
    { structuredContent: { status: "confirmation_required", model_id: "m", model_name: "M", sample: true } },
    { tool: "atlas_generate_image", args: { model: "m" } }
  );
  assert.equal(quote?.state, "quote");
  assert.equal(quote?.sample, true);
  // 真实结果不带标记，不能被当成样例。
  const real = cardFromToolResult({ structuredContent: { prediction_id: "p1", status: "completed", outputs: [] } });
  assert.equal(real?.sample, undefined);
});
