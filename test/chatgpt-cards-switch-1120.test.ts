// 2026-11-20 生产：MCP_UI_CARDS 打开后，ChatGPT 上架应用用的工具副本还是卡片打开前同步的（没有模板），
// 画不出卡片，却被告知「点卡片上的按钮」「卡片会自己刷新，别再查」，有的提交之后再没人去查结果。
// ChatGPT 的卡片话术单独开关（MCP_UI_CARDS_CHATGPT），默认按文字版走；卡片数据照旧挂上。
import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chatGptCardsEnabled, clientRendersCards } from "../src/apps/generation-card.js";
import { withGenerationCard } from "../src/apps/generation-quote.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { runWithRequestContext } from "../src/services/request-context.js";

const CHATGPT = "https://chatgpt.com/oauth/client.json";
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";

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

/** 声明会渲染 MCP Apps 卡片的客户端（ChatGPT 实际就这么声明）。 */
function cardServer(): McpServer {
  const capabilities = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
  return { server: { getClientCapabilities: () => capabilities } } as unknown as McpServer;
}

/** 远端服务工具调用时拿不到 initialize 的声明，只能按 OAuth 客户端认。 */
function statelessServer(): McpServer {
  return { server: { getClientCapabilities: () => undefined } } as unknown as McpServer;
}

function contextFor(clientId: string) {
  return {
    authInfo: { token: "t", clientId, scopes: ["tasks:read", "tasks:write"] } as AuthInfo,
    subject: "user-1",
    atlasApiKey: "k",
    idempotencyStore: new InMemoryIdempotencyStore(),
    idempotencyTtlSeconds: 60,
    generationConfirmationSecret: "s".repeat(32),
    generationConfirmationTtlSeconds: 600,
  };
}

const ARGS = {
  idempotency_key: "7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11",
  model: "bytedance/seedream-v5.0-lite",
  params: { prompt: "a red paper boat" },
};

const quote = async () => ({
  structuredContent: {
    model_id: "bytedance/seedream-v5.0-lite",
    model_name: "Seedream v5.0 Lite",
    kind: "image",
    status: "confirmation_required",
    confirmation_token: "c2.1793083000.abcdefghijklmnop",
    confirmation_valid_seconds: 600,
    idempotency_key: ARGS.idempotency_key,
    estimated_cost_usd: 0.03,
  },
  content: [{ type: "text" as const, text: "Confirmation required." }],
});

const submitted = async () => ({
  structuredContent: {
    prediction_id: "p-1120",
    model_id: "bytedance/seedream-v5.0-lite",
    model_name: "Seedream v5.0 Lite",
    kind: "image",
    status: "submitted",
  },
  content: [{ type: "text" as const, text: "Submitted. Poll atlas_get_prediction with p-1120." }],
});

const run = (clientId: string, handler: typeof quote | typeof submitted, args: Record<string, unknown> = ARGS) =>
  runWithRequestContext(contextFor(clientId), () => withGenerationCard(cardServer(), "atlas_generate_image", handler)(args, {}));

test("开关默认关；值只认常见的真假写法", () => {
  const restore = withEnv({ MCP_UI_CARDS_CHATGPT: undefined });
  try {
    assert.equal(chatGptCardsEnabled(), false);
    process.env.MCP_UI_CARDS_CHATGPT = "1";
    assert.equal(chatGptCardsEnabled(), true);
    process.env.MCP_UI_CARDS_CHATGPT = "off";
    assert.equal(chatGptCardsEnabled(), false);
  } finally {
    restore();
  }
});

test("卡片开着、ChatGPT 开关关着：ChatGPT 不算会显示卡片，声明了也一样；Claude 网页版和没有请求上下文的不受影响", () => {
  const restore = withEnv({ MCP_UI_CARDS: "1", MCP_UI_CARDS_CHATGPT: undefined });
  try {
    assert.equal(runWithRequestContext(contextFor(CHATGPT), () => clientRendersCards(cardServer())), false);
    assert.equal(runWithRequestContext(contextFor(CHATGPT), () => clientRendersCards(statelessServer())), false);
    assert.equal(runWithRequestContext(contextFor(CLAUDE), () => clientRendersCards(statelessServer())), true);
    assert.equal(runWithRequestContext(contextFor(CLAUDE), () => clientRendersCards(cardServer())), true);
    // Codex 也在 chatgpt.com 下，不是 ChatGPT：照旧按它的声明。
    assert.equal(runWithRequestContext(contextFor("https://chatgpt.com/oauth/codex/client.json"), () => clientRendersCards(cardServer())), true);
    // 本地版（没有请求上下文）照旧。
    assert.equal(clientRendersCards(cardServer()), true);

    process.env.MCP_UI_CARDS_CHATGPT = "1";
    assert.equal(runWithRequestContext(contextFor(CHATGPT), () => clientRendersCards(statelessServer())), true);

    // 总开关关着时，ChatGPT 开关开了也没用。
    process.env.MCP_UI_CARDS = "0";
    assert.equal(runWithRequestContext(contextFor(CHATGPT), () => clientRendersCards(cardServer())), false);
  } finally {
    restore();
  }
});

test("ChatGPT 开关关着：报价不叫用户点卡片，提交后不说「卡片会刷新、别查」，卡片数据照旧挂上", async () => {
  const restore = withEnv({ MCP_UI_CARDS: "1", MCP_UI_CARDS_CHATGPT: undefined });
  try {
    const chatgptQuote = await run(CHATGPT, quote);
    assert.equal(chatgptQuote.content.length, 1);
    assert.equal((chatgptQuote.structuredContent as Record<string, unknown>).card_note, undefined);
    assert.equal((chatgptQuote._meta?.["atlascloud/card"] as { state: string }).state, "quote");

    const confirmed = { ...ARGS, confirmed: true, confirmation_token: "c2.1793083000.abcdefghijklmnop" };
    const chatgptSubmit = await run(CHATGPT, submitted, confirmed);
    const submitText = chatgptSubmit.content.map((block) => (block as { text: string }).text).join("\n");
    assert.doesNotMatch(submitText, /don't call atlas_get_prediction/);
    assert.equal((chatgptSubmit.structuredContent as Record<string, unknown>).card_note, undefined);
    assert.equal((chatgptSubmit._meta?.["atlascloud/card"] as { state: string }).state, "running");

    // Claude 网页版照旧按卡片说。
    const claudeQuote = await run(CLAUDE, quote);
    assert.equal(claudeQuote.content.length, 2);
    assert.match(String((claudeQuote.structuredContent as Record<string, unknown>).card_note), /Atlas card/);
    const claudeSubmit = await run(CLAUDE, submitted, confirmed);
    assert.match(String((claudeSubmit.structuredContent as Record<string, unknown>).card_note), /don't call\s+atlas_get_prediction/);

    // 确认 ChatGPT 画得出卡片后打开开关，ChatGPT 也按卡片说。
    process.env.MCP_UI_CARDS_CHATGPT = "1";
    const chatgptCardQuote = await run(CHATGPT, quote);
    assert.equal(chatgptCardQuote.content.length, 2);
    assert.match(String((chatgptCardQuote.structuredContent as Record<string, unknown>).card_note), /Atlas card/);
  } finally {
    restore();
  }
});
