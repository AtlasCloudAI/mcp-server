import assert from "node:assert/strict";
import test from "node:test";
import { modelResponseSchema } from "../src/response-schemas.js";
import { formatGenerationPricing } from "../src/services/generation-confirmation.js";
import {
  chatInputTokenUpperBound,
  chatUsageCostUsd,
  chatWorstCaseUsd,
  evaluateChatSpend,
} from "../src/services/spend-policy.js";
import { REMOTE_TOOL_NAMES, TOOL_POLICIES } from "../src/tool-policy.js";
import type { Model } from "../src/types.js";

function textModel(price: Model["price"], extra: Partial<Model> = {}): Model {
  return {
    uuid: "u",
    model: "test/llm",
    type: "Text",
    displayName: "Test LLM",
    profile: "",
    avatar: "",
    readme: "",
    tags: [],
    price,
    maxCompletionTokens: 100_000,
    contextLength: 1_000_000,
    ...extra,
  };
}

test("atlas_chat is a remote tool for every client; only the upload tool stays local", () => {
  assert.ok(REMOTE_TOOL_NAMES.includes("atlas_chat"));
  assert.equal(REMOTE_TOOL_NAMES.length, 18);
  assert.ok(!REMOTE_TOOL_NAMES.includes("atlas_upload_media"));
  assert.equal(TOOL_POLICIES.atlas_chat.scope, "tasks:write");
});

test("input tokens are bounded by UTF-8 bytes plus per-message overhead", () => {
  const messages = [
    { role: "system", content: "abc" },
    { role: "user", content: "你好" }, // 6 bytes
  ];
  assert.equal(chatInputTokenUpperBound({ messages }), 3 + 6 + 2 * 16);
});

test("worst case uses max_tokens, else the model's output limit, at the highest rates", () => {
  const model = textModel({ actual: { input_price: "2", output_price: "6" } });
  const messages = [{ role: "user", content: "x".repeat(984) }]; // 1000 input tokens bound
  assert.equal(chatWorstCaseUsd(model, { messages, max_tokens: 1000 }), (1000 * 2 + 1000 * 6) / 1e6);
  assert.equal(chatWorstCaseUsd(model, { messages }), (1000 * 2 + 100_000 * 6) / 1e6);
  // 没有最大输出时退到上下文长度；两个都没有就算不出
  const noMax = textModel({ actual: { input_price: "2", output_price: "6" } }, { maxCompletionTokens: undefined });
  assert.equal(chatWorstCaseUsd(noMax, { messages }), (1000 * 2 + 1_000_000 * 6) / 1e6);
  const noLimits = textModel(
    { actual: { input_price: "2", output_price: "6" } },
    { maxCompletionTokens: undefined, contextLength: undefined }
  );
  assert.equal(chatWorstCaseUsd(noLimits, { messages }), null);
});

test("worst case takes the most expensive tier, including cache writes", () => {
  const model = textModel({
    actual: {
      input_price: "10",
      output_price: "50",
      cache_creation_price: "12.5",
      prompt_thresholds: [{ threshold: 272000, input_price: "20", output_price: "75", cache_creation_price: "25" }],
    },
  });
  const messages = [{ role: "user", content: "x".repeat(84) }]; // 100 tokens bound
  assert.equal(chatWorstCaseUsd(model, { messages, max_tokens: 1000 }), (100 * 25 + 1000 * 75) / 1e6);
});

test("missing rates fail closed: no auto-submit", () => {
  const model = textModel({ actual: { input_price: "2" } });
  const decision = evaluateChatSpend(model, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(decision.autoSubmit, false);
  assert.equal(decision.quotedUsd, null);
});

test("chat auto-submits under the limit and stops at or above it", () => {
  const previous = process.env.MCP_AUTOSUBMIT_MAX_USD;
  try {
    delete process.env.MCP_AUTOSUBMIT_MAX_USD; // 默认 $20
    const cheap = textModel({ actual: { input_price: "0.3", output_price: "1.2" } });
    const under = evaluateChatSpend(cheap, { messages: [{ role: "user", content: "hello" }] });
    assert.equal(under.autoSubmit, true);
    assert.ok(under.quotedUsd !== null && under.quotedUsd < 20);

    // $15/M 输出、最大输出 2M token：最坏 $30，必须确认；给了 max_tokens 就能直接跑
    const pricey = textModel({ actual: { input_price: "3", output_price: "15" } }, { maxCompletionTokens: 2_000_000 });
    assert.equal(evaluateChatSpend(pricey, { messages: [{ role: "user", content: "hello" }] }).autoSubmit, false);
    assert.equal(
      evaluateChatSpend(pricey, { messages: [{ role: "user", content: "hello" }], max_tokens: 4000 }).autoSubmit,
      true
    );

    process.env.MCP_AUTOSUBMIT_MAX_USD = "0";
    assert.equal(evaluateChatSpend(cheap, { messages: [{ role: "user", content: "hello" }] }).autoSubmit, false);
  } finally {
    if (previous === undefined) delete process.env.MCP_AUTOSUBMIT_MAX_USD;
    else process.env.MCP_AUTOSUBMIT_MAX_USD = previous;
  }
});

test("usage cost picks the tier the prompt actually fell into", () => {
  const model = textModel({
    actual: {
      input_price: "10",
      output_price: "50",
      prompt_thresholds: [{ threshold: 272000, input_price: "20", output_price: "75" }],
    },
  });
  assert.equal(chatUsageCostUsd(model, { prompt_tokens: 1000, completion_tokens: 500 }), (1000 * 10 + 500 * 50) / 1e6);
  assert.equal(
    chatUsageCostUsd(model, { prompt_tokens: 300000, completion_tokens: 500 }),
    (300000 * 20 + 500 * 75) / 1e6
  );
  assert.equal(chatUsageCostUsd(textModel(undefined), { prompt_tokens: 1, completion_tokens: 1 }), null);
});

test("catalog parsing keeps tiered prices, and the price line describes them", () => {
  const parsed = modelResponseSchema.parse({
    uuid: "u",
    model: "openai/gpt-6-astra",
    type: "Text",
    displayName: "GPT-6 Astra",
    price: {
      actual: {
        type: "flat",
        input_price: "10",
        output_price: "50",
        cache_creation_price: "12.5",
        prompt_thresholds: [{ threshold: 272000, input_price: "20", output_price: "75" }],
      },
    },
  });
  assert.equal(parsed.price?.actual?.cache_creation_price, "12.5");
  assert.equal(parsed.price?.actual?.prompt_thresholds?.[0]?.threshold, 272000);
  const line = formatGenerationPricing(parsed.price!);
  assert.match(line, /input price per million tokens: \$10/);
  assert.match(line, /above 272000 input tokens: input \$20, output \$75 per million tokens/);
  assert.doesNotMatch(line, /object Object/);
});
