// 11-18 全客户端回归（ChatGPT / Cursor / WorkBuddy）里能在 mcp-server 修的问题。
import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "@modelcontextprotocol/ext-apps";
import { withGenerationCard } from "../src/apps/generation-quote.js";
import { NOT_STARTED_META_KEY as SERVER_KEY, cardPrompt } from "../src/apps/generation-card.js";
import { fullPrompt, reusableSettings } from "../src/apps/history-card.js";
import { chargeFromBilling, withRecordedCharge } from "../src/services/recorded-charge.js";
import type { HistoryItem, PredictionResponse } from "../src/response-schemas.js";
import { NOT_STARTED_META_KEY, notStartedReason } from "../ui/generation-card/card.js";
import { handOff, messagingAvailable, sendFailure } from "../ui/generation-card/handoff.js";

function withEnv(values: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function fakeServer(): McpServer {
  const capabilities = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
  return { server: { getClientCapabilities: () => capabilities } } as unknown as McpServer;
}

const IMAGE_ARGS = { model: "bytedance/seedream-v5.0-pro/edit", params: { prompt: "x", images: ["file:///etc/passwd"] } };
const errorResult = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

// ---------- 问题 1：报价前被拒，卡片显示成「Couldn't load this task · Error + Refresh」 ----------

test("1 服务端：报价前就被拒的生成报错打上 not_started 标记，可能已提交的不打", async () => {
  assert.equal(SERVER_KEY, NOT_STARTED_META_KEY);
  const restore = withEnv({ MCP_UI_CARDS: "1" });
  try {
    const rejected = await withGenerationCard(fakeServer(), "atlas_generate_image", async () =>
      errorResult("No quote was made and nothing was charged: this input link can't be used.\n- images: file:///etc/passwd — only http and https links can be used.")
    )(IMAGE_ARGS, {});
    assert.equal(rejected.isError, true);
    assert.equal(rejected._meta?.[NOT_STARTED_META_KEY], true);
    // 结构化结果不动：客户端 SDK 出错时也按 outputSchema 校验它。
    assert.equal(rejected.structuredContent, undefined);

    const uncertain = await withGenerationCard(fakeServer(), "atlas_generate_image", async () =>
      errorResult("Error: Request timed out. The request ended without a confirmed response, so it may already have gone through.")
    )({ ...IMAGE_ARGS, confirmed: true, confirmation_token: "c2.1.abcdefghijklmnopqrstuvwxyz0123456789" }, {});
    assert.equal(uncertain._meta?.[NOT_STARTED_META_KEY], undefined);
  } finally {
    restore();
  }
});

test("1 卡片：认出没开始的报错，给原因；登录失效、可能已提交、查单报错都不算", () => {
  const reason = "images: file:///etc/passwd — only http and https links can be used.";
  // 服务端打了标记
  assert.equal(notStartedReason({ ...errorResult(reason), _meta: { [NOT_STARTED_META_KEY]: true } }), reason);
  // 宿主没转 _meta：生成调用 + 报价前被拒的原话
  const validation = "Parameter validation failed for `bytedance/seedance-2.5/image-to-video`. The request was NOT submitted (no credits were spent). Fix the following and retry:\n\n- image is required";
  assert.equal(notStartedReason(errorResult(validation), { args: IMAGE_ARGS }), validation);
  assert.equal(
    notStartedReason(errorResult('Model "x/y" not found. Use atlas_list_models with type="Image" to see available image models.'), { args: IMAGE_ARGS }),
    'Model "x/y" not found. Use atlas_list_models with type="Image" to see available image models.'
  );
  // 查单（带 prediction_id）的报错照旧走 Couldn't load this task
  assert.equal(notStartedReason(errorResult(validation), { args: { prediction_id: "abc" } }), undefined);
  // 可能已经提交的：就算打了标记也不认
  assert.equal(
    notStartedReason({ ...errorResult("The request ended without a confirmed response"), _meta: { [NOT_STARTED_META_KEY]: true } }),
    undefined
  );
  // 登录失效走「需要重新连接」
  assert.equal(
    notStartedReason({ ...errorResult("Connector authorization required"), _meta: { [NOT_STARTED_META_KEY]: true } }),
    undefined
  );
  // 不是报错
  assert.equal(notStartedReason({ content: [{ type: "text", text: "ok" }] }), undefined);
});

// ---------- 问题 3：模板单的 user_prompt 当提示词；按 ID 查工作流单拿不到实扣 ----------

test("3 模板单：user_prompt 当提示词（Reuse prompt），不再混进参数", () => {
  const item = {
    ID: "75672d703a4c4df6abf9e44b4eb8995a",
    model: "atlascloud/studio/product-visuals",
    status: "completed",
    requestBody: JSON.stringify({ model: "atlascloud/studio/product-visuals", user_prompt: "a red apple on a counter", aspect_ratio: "9:16" }),
  } as unknown as HistoryItem;
  assert.equal(fullPrompt(item), "a red apple on a counter");
  assert.deepEqual(reusableSettings(item), { aspect_ratio: "9:16" });
  assert.equal(cardPrompt({ user_prompt: "  a red apple  " }), "a red apple");
  // 普通模型照旧认 prompt；prompt 优先
  assert.equal(cardPrompt({ prompt: "p", user_prompt: "u" }), "p");
  // 语音合成的 text 不当提示词
  assert.equal(cardPrompt({ text: "hello" }), undefined);
});

test("3 账单 → 扣费状态：已付、部分付、退款、未结算、老后端", () => {
  assert.deepEqual(chargeFromBilling({ amount: "0.2593", paymentStatus: 2 }), { price: 0.2593, charge_status: "charged" });
  assert.deepEqual(chargeFromBilling({ amount: 0.1, paymentStatus: 4 }), { price: 0.1, charge_status: "partially_charged" });
  assert.deepEqual(chargeFromBilling({ amount: "0.0043", paymentStatus: 3 }), { charge_status: "refunded" });
  assert.deepEqual(chargeFromBilling({ amount: "0.2593", paymentStatus: 1 }), { charge_status: "pending" });
  assert.deepEqual(chargeFromBilling({ amount: "0.2593" }), { price: 0.2593, charge_status: "charged" });
  assert.deepEqual(chargeFromBilling({ amount: "0" }), { price: 0, charge_status: "not_charged" });
  assert.equal(chargeFromBilling(undefined), undefined);
  assert.equal(chargeFromBilling({ amount: "abc" }), undefined);
});

test("3 查结果没给扣费的已结束单：到历史账单里补上；给了的、没结束的不查", async () => {
  const restore = withEnv({ ATLASCLOUD_API_KEY: "test-key" });
  const calls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        code: "200",
        data: {
          total: 2,
          items: [
            { ID: "other", model: "atlascloud/studio/product-visuals", status: "completed", billing: { amount: "9", paymentStatus: 2 } },
            { ID: "75672d703a4c4df6abf9e44b4eb8995a", model: "atlascloud/studio/product-visuals", status: "completed", billing: { amount: "0.2593", paymentStatus: 2 } },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  try {
    const workflow = { data: { id: "75672d703a4c4df6abf9e44b4eb8995a", status: "completed", model: "atlascloud/studio/product-visuals", outputs: ["https://x.test/a.png"] } } as unknown as PredictionResponse;
    const filled = await withRecordedCharge("75672d703a4c4df6abf9e44b4eb8995a", workflow, { fetcher });
    const data = filled.data as Record<string, unknown>;
    assert.equal(data.price, 0.2593);
    assert.equal(data.charge_status, "charged");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /\/model\/history\?/);
    assert.match(calls[0]!, /model=atlascloud%2Fstudio%2Fproduct-visuals/);

    // 接口给了扣费：不查
    const priced = { data: { id: "a", status: "completed", price: 0.018, charge_status: "charged" } } as unknown as PredictionResponse;
    assert.equal(await withRecordedCharge("a", priced, { fetcher }), priced);
    // 还在跑：不查
    const running = { data: { id: "75672d703a4c4df6abf9e44b4eb8995a", status: "processing" } } as unknown as PredictionResponse;
    assert.equal(await withRecordedCharge("75672d703a4c4df6abf9e44b4eb8995a", running, { fetcher }), running);
    // 历史里找不到：原样返回
    const missing = { data: { id: "nope", status: "completed", model: "m/x" } } as unknown as PredictionResponse;
    assert.equal(await withRecordedCharge("nope", missing, { fetcher }), missing);
    assert.equal(calls.length, 2);
    // 历史接口出错：原样返回
    const broken = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    assert.equal(await withRecordedCharge("nope", missing, { fetcher: broken }), missing);
  } finally {
    restore();
  }
});

// ---------- 问题 5：Cursor 里点 Use，消息发出去了，卡上却说「This app can't take files…」 ----------

function fakeApp(caps: Record<string, unknown>, send: () => Promise<unknown>): App {
  return {
    getHostCapabilities: () => caps,
    getHostVersion: () => ({ name: "cursor", version: "3.30.14" }),
    updateModelContext: async () => {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    },
    sendMessage: send,
  } as unknown as App;
}

const TEXT = { short: "short", ask: "ask", lead: "lead" };

test("5 发消息没拿到成功回答：声明过算失败；没声明的只有「没有这个方法」才算不支持，其余算多半发出去了", () => {
  assert.equal(sendFailure(true, new Error("rejected")), "failed");
  assert.equal(sendFailure(false, Object.assign(new Error("Method not found"), { code: -32601 })), "unsupported");
  assert.equal(sendFailure(false, new Error("host did not answer")), "unconfirmed");
  assert.equal(sendFailure(false, new Error("rejected")), "unconfirmed");
});

test("5 handOff：Cursor 这种没声明、回 isError 的宿主算 unconfirmed，之后照样能发消息", async () => {
  assert.equal(await handOff(fakeApp({}, async () => ({ isError: true })), "for model", TEXT, "- a: asset://asset_1"), "unconfirmed");
  assert.equal(messagingAvailable(), true);
  assert.equal(await handOff(fakeApp({}, async () => ({})), "for model", TEXT), "sent");
  assert.equal(await handOff(fakeApp({ message: {} }, async () => ({ isError: true })), "for model", TEXT), "failed");
  assert.equal(
    await handOff(
      fakeApp({}, async () => {
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      }),
      "for model",
      TEXT
    ),
    "unsupported"
  );
});
