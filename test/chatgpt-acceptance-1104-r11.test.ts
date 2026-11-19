// 2026-11-04 第 11 轮 ChatGPT 全流程补跑发现的两个问题。
// 39：重新打开对话后，已确认的报价卡又显示待确认。卡片打开在旧报价上时问一次提交记录。
// 40：问「这次一共扣了多少」，ChatGPT 把同账号其他客户端的任务也算进来。任务列表带上来源。
import assert from "node:assert/strict";
import test from "node:test";
import { checkSubmission } from "../src/apps/submission-check.js";
import { historyResponseSchema } from "../src/response-schemas.js";
import { executeIdempotently } from "../src/services/idempotency.js";
import { sourceLabel, summarizeHistoryItem } from "../src/tools/predictions.js";
import type { QuoteInfo } from "../ui/generation-card/card.js";
import { reopenedOnQuote } from "../ui/generation-card/quote.js";

const quote = (issuedAt: number, validSeconds = 3600): QuoteInfo => ({
  tool: "atlas_generate_image",
  arguments: {},
  idempotency_key: "k",
  confirmation_token: "t",
  settings: [],
  expires_at: new Date(issuedAt + validSeconds * 1000).toISOString(),
  valid_seconds: validSeconds,
});

test("39：刚报出来的报价不问；报价出来一会儿后卡片才打开，算重新打开", () => {
  const now = 1_800_000_000_000;
  assert.equal(reopenedOnQuote(quote(now - 2_000), now), false);
  // 第 11 轮：报价约 5 分钟后在新标签页打开，卡上写 valid for 54:56。
  assert.equal(reopenedOnQuote(quote(now - 5 * 60_000), now), true);
  // 过期了也要问：确认过的报价过期后照样会显示成「已过期」。
  assert.equal(reopenedOnQuote(quote(now - 2 * 3600_000), now), true);
  // 没有有效期可算（宿主没转 _meta、报价里没给秒数）：问一次，代价只是一次只读调用。
  assert.equal(reopenedOnQuote({ ...quote(now), expires_at: undefined }, now), true);
  assert.equal(reopenedOnQuote(undefined, now), false);
});

test("39：on_load 只看提交记录，有记录就接着显示，没记录不去翻任务", async () => {
  const done = "1c2a3b4d-0000-4000-8000-000000001101";
  await executeIdempotently("atlas_generate_image", { prompt: "x" }, done, async () => ({
    ok: true,
    predictionId: "d8f52f0a44f846e5a61ca46147920f54",
  }));
  assert.deepEqual(await checkSubmission({ tool: "atlas_generate_image", idempotency_key: done, on_load: true }), {
    outcome: "started",
    prediction_id: "d8f52f0a44f846e5a61ca46147920f54",
  });

  // 没确认过的报价：没有记录。带了 model 也不翻历史（这里没有可用的接口，翻了就会抛）。
  const fresh = "1c2a3b4d-0000-4000-8000-000000001102";
  assert.deepEqual(
    await checkSubmission({
      tool: "atlas_generate_image",
      idempotency_key: fresh,
      model: "bytedance/seedream-v5.0-pro/text-to-image",
      arguments: { params: { prompt: "x" } },
      on_load: true,
    }),
    { outcome: "not_submitted" }
  );
});

// 第 11 轮控制台里的三种来源；/model/history 的字段名照 kubedl ModelHistoryResult。
const history = historyResponseSchema.parse({
  code: "200",
  data: {
    total: 4,
    items: [
      {
        ID: "fd65bdce419f4eec8caecb1191a195e5",
        model: "bytedance/seedream-v5.0-pro/text-to-image",
        status: "completed",
        createdAt: "1793760687",
        source: "mcp",
        sourceName: "Claude Code",
        sourcePlatform: "claude-code",
      },
      {
        ID: "d8f52f0a44f846e5a61ca46147920f54",
        model: "atlascloud/studio/product-visuals",
        status: "completed",
        createdAt: "1793760444",
        source: "mcp",
        sourceName: "ChatGPT",
        sourcePlatform: "chatgpt",
      },
      { ID: "web1", model: "m", status: "completed", source: "website" },
      { ID: "mcp-unnamed", model: "m", status: "completed", source: "mcp" },
      { ID: "old", model: "m", status: "completed" },
    ],
  },
});

test("40：任务摘要带来源，写法和控制台一样", () => {
  const summaries = history.data.items.map(summarizeHistoryItem);
  assert.deepEqual(
    summaries.map((summary) => summary.source),
    ["MCP · Claude Code", "MCP · ChatGPT", "Website", "MCP", undefined]
  );
  // 老记录没有来源就不写这个字段。
  assert.equal("source" in summaries[4]!, false);
  assert.equal(sourceLabel({ ID: "x", model: "m", status: "", source: "cli" }), "Atlas CLI");
  assert.equal(sourceLabel({ ID: "x", model: "m", status: "", source: "api" }), "API");
  assert.equal(sourceLabel({ ID: "x", model: "m", status: "", source: "unknown" }), undefined);
});
