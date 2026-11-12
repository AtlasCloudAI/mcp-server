// 11-12 ChatGPT 回归发现的三处：失败单的扣费列表和详情说法不一致、Reuse prompt 不带原输入素材、
// ChatGPT 里只打字确认那一轮可能调不到工具。报告：nsfw/mcp-test-report/chatgpt-1112/report.md。
import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reusableInputs } from "../src/apps/history-card.js";
import { withGenerationCard } from "../src/apps/generation-quote.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { rememberMediaName } from "../src/services/media-names.js";
import { runWithRequestContext } from "../src/services/request-context.js";
import type { HistoryItem } from "../src/response-schemas.js";
import { withBillingRecord } from "../ui/generation-card/history.js";
import { say } from "../ui/generation-card/voice.js";

test("失败单详情的扣费以账单为准：列表记了 $0.8865，查结果却回 not_charged 时写扣了多少", () => {
  const failed = { state: "failed" as const, charge_status: "not_charged" };
  assert.deepEqual(withBillingRecord(failed, { price_usd: 0.8865 }), { state: "failed", charge_status: "charged", price_usd: 0.8865 });
  // 老网关没有 charge_status，同样按账单写。
  assert.deepEqual(withBillingRecord({ state: "failed" as const }, { price_usd: 0.5 }), { state: "failed", charge_status: "charged", price_usd: 0.5 });
  // 已经写了扣费但没价格：补上账单金额；已有价格不动。
  assert.deepEqual(withBillingRecord({ state: "failed" as const, charge_status: "partially_charged" }, { price_usd: 0.3 }), {
    state: "failed",
    charge_status: "partially_charged",
    price_usd: 0.3,
  });
  const priced = { state: "failed" as const, charge_status: "charged", price_usd: 0.2 };
  assert.equal(withBillingRecord(priced, { price_usd: 0.3 }), priced);
  // 退款了、账单为 0、没账单、成功单：都不改。
  const refunded = { state: "failed" as const, charge_status: "refunded" };
  assert.equal(withBillingRecord(refunded, { price_usd: 0.3 }), refunded);
  assert.equal(withBillingRecord(failed, { price_usd: 0 }), failed);
  assert.equal(withBillingRecord(failed, {}), failed);
  assert.equal(withBillingRecord(failed, undefined), failed);
  const done = { state: "succeeded" as const, price_usd: 0.018 };
  assert.equal(withBillingRecord(done, { price_usd: 0.5 }), done);
});

test("Reuse prompt 把原输入素材一起交回去，失效的请用户重选；没有输入时和原来一样", () => {
  const inputs = [
    { name: "vertical-apple.jpg", ref: "asset://asset_abcdefgh1234", field: "image" },
    { name: "logo.png", ref: "https://atlas-media.oss-us-west-1.aliyuncs.com/u/logo.png" },
  ];
  const en = say.reusePrompt("en", "Seedream v5.0 Flash Edit", "Make the apple green", inputs, 1);
  assert.match(en, /^Generate this again with the same prompt and input files \(last time it was Seedream v5\.0 Flash Edit\)/);
  assert.match(en, /Make the apple green/);
  assert.match(en, /- vertical-apple\.jpg \(image\): asset:\/\/asset_abcdefgh1234/);
  assert.match(en, /- logo\.png: https:\/\/atlas-media/);
  assert.match(en, /One input file's link has expired: ask me to pick it again first\./);

  const zh = say.reusePrompt("zh", "Seedream v5.0 Flash Edit", "把苹果变绿", inputs.slice(0, 1));
  assert.match(zh, /^用同样的提示词和输入素材再生成一次/);
  assert.match(zh, /输入素材（照原来的字段填）：\n- vertical-apple\.jpg \(image\): asset:\/\/asset_abcdefgh1234/);
  assert.doesNotMatch(zh, /失效/);

  assert.equal(
    say.reusePrompt("en", "Flux", "a cat"),
    "Generate this again with the same prompt (last time it was Flux), and quote it first:\n\na cat"
  );
});

test("历史条目的输入素材：资产库的写 asset://编号，公开链接原样，认不出编号的签名地址只计数", async () => {
  const library = "https://atlas-asset.oss-us-west-1.aliyuncs.com/a/1?x-oss-credential=abc&x-oss-signature=def";
  const expired = "https://atlas-asset.oss-us-west-1.aliyuncs.com/a/2?x-oss-credential=abc&x-oss-signature=ghi";
  const media = "https://atlas-media.oss-us-west-1.aliyuncs.com/u/apple.png";
  await rememberMediaName(library, "vertical-apple.jpg", undefined, { source: "library", assetId: "asset_abcdefgh1234" });
  const item = {
    ID: "p1",
    model: "bytedance/seedream-v5.0-flash/edit",
    status: "completed",
    requestBody: JSON.stringify({ prompt: "Make the apple green", images: [library, expired], mask: media }),
  } as unknown as HistoryItem;
  const { inputs, unavailable } = await reusableInputs(item);
  assert.deepEqual(inputs, [
    { name: "vertical-apple.jpg", ref: "asset://asset_abcdefgh1234", field: "images" },
    { name: "apple.png", ref: media, field: "mask" },
  ]);
  assert.equal(unavailable, 1);

  const none = await reusableInputs({ ...item, requestBody: '{"prompt":"a cat"}' } as unknown as HistoryItem);
  assert.deepEqual(none, { inputs: [], unavailable: 0 });
});

const UI_MIME = "text/html;profile=mcp-app";

function cardServer(): McpServer {
  const capabilities = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } } };
  return { server: { getClientCapabilities: () => capabilities } } as unknown as McpServer;
}

function contextFor(clientId: string) {
  return {
    authInfo: { token: "t", clientId, scopes: ["tasks:read"] } as AuthInfo,
    subject: "user-1",
    atlasApiKey: "k",
    idempotencyStore: new InMemoryIdempotencyStore(),
    idempotencyTtlSeconds: 60,
    generationConfirmationSecret: "s".repeat(32),
    generationConfirmationTtlSeconds: 600,
  };
}

test("ChatGPT 里的报价说明：打字确认要带 @应用名，别的客户端不加这句", async () => {
  const saved = process.env.MCP_UI_CARDS;
  process.env.MCP_UI_CARDS = "1";
  try {
    const quote = async () => ({
      structuredContent: {
        model_id: "bytedance/seedream-v5.0-flash/text-to-image",
        model_name: "Seedream v5.0 Flash",
        kind: "image",
        status: "confirmation_required",
        confirmation_token: "c2.1793083000.abcdefghijklmnop",
        confirmation_valid_seconds: 3600,
        idempotency_key: "7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11",
        estimated_cost_usd: 0.018,
      },
      content: [{ type: "text" as const, text: "Confirmation required." }],
    });
    const args = {
      idempotency_key: "7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11",
      model: "bytedance/seedream-v5.0-flash/text-to-image",
      params: { prompt: "a blue paper airplane", size: "2048*2048" },
    };
    const run = (clientId: string) =>
      runWithRequestContext(contextFor(clientId), () => withGenerationCard(cardServer(), "atlas_generate_image", quote)(args, {}));

    const chatgpt = await run("https://chatgpt.com/oauth/client.json");
    const note = (chatgpt.content[1] as { text: string }).text;
    assert.match(note, /mentions this app with @/);
    assert.match(String((chatgpt.structuredContent as Record<string, unknown>).card_note), /mentions this app with @/);

    const claude = await run("https://claude.ai/oauth/mcp-oauth-client-metadata");
    assert.doesNotMatch((claude.content[1] as { text: string }).text, /mentions this app with @/);
    assert.doesNotMatch(String((claude.structuredContent as Record<string, unknown>).card_note), /mentions this app with @/);
  } finally {
    if (saved === undefined) delete process.env.MCP_UI_CARDS;
    else process.env.MCP_UI_CARDS = saved;
  }
});
