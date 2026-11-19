// 2026-11-04 第 13 轮发现的两个 MCP 问题。
// 47：Claude Code 只看结构化结果，转存没完成时拿了上游临时链接。
// 48：Hermes 不显示卡片，却把卡片专用工具和 ChatGPT 专用的附件导入工具列给模型。
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasCloudServer } from "../src/server.js";
import { clientProfile, passesChatAttachmentLinks, rendersCards } from "../src/services/client-profile.js";
import { TRANSFER_NEXT_STEP } from "../src/tools/llm.js";
import { cardFromToolResult } from "../ui/generation-card/card.js";

const HERMES = "https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json";
// atlas_open_upload_card：上传卡是兜底，不显示卡片的客户端只用 atlas_get_upload_url 自己传（2026-11-11）。
const CARD_ONLY = ["atlas_card_status", "atlas_card_check_submission", "atlas_card_selftest", "atlas_open_upload_card"];

async function toolNames(clientId: string): Promise<string[]> {
  const server = createAtlasCloudServer("remote", { clientId });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "r13", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

test("48：认得出 Hermes，它不显示卡片、不传附件链接", () => {
  assert.equal(clientProfile(HERMES), "shell");
  assert.equal(rendersCards(HERMES), false);
  assert.equal(passesChatAttachmentLinks(HERMES), false);
  assert.equal(rendersCards("https://claude.ai/oauth/claude-code-client-metadata"), false);
  assert.equal(rendersCards("https://chatgpt.com/oauth/codex/client.json"), false);
  // 会显示卡片的和认不出的（WorkBuddy 引擎等动态注册客户端）照旧。
  assert.equal(rendersCards("https://chatgpt.com/oauth/client.json"), true);
  assert.equal(rendersCards("https://claude.ai/oauth/mcp-oauth-client-metadata"), true);
  assert.equal(rendersCards("dcr-client-123"), true);
});

test("48：Hermes 的工具列表里没有卡片专用工具和附件导入工具，ChatGPT 照旧都有", async () => {
  const saved = { cards: process.env.MCP_UI_CARDS, selftest: process.env.MCP_UI_SELFTEST };
  process.env.MCP_UI_CARDS = "true";
  process.env.MCP_UI_SELFTEST = "true";
  try {
    const hermes = await toolNames(HERMES);
    for (const name of [...CARD_ONLY, "atlas_import_chat_files"]) assert.ok(!hermes.includes(name), name);
    assert.ok(hermes.includes("atlas_get_prediction"));
    const chatgpt = await toolNames("https://chatgpt.com/oauth/client.json");
    for (const name of [...CARD_ONLY, "atlas_import_chat_files"]) assert.ok(chatgpt.includes(name), name);
  } finally {
    if (saved.cards === undefined) delete process.env.MCP_UI_CARDS;
    else process.env.MCP_UI_CARDS = saved.cards;
    if (saved.selftest === undefined) delete process.env.MCP_UI_SELFTEST;
    else process.env.MCP_UI_SELFTEST = saved.selftest;
  }
});

test("47：转存中的结构化结果，上游链接不在 outputs 里，next_step 写明再查；卡片照样显示", () => {
  assert.match(TRANSFER_NEXT_STEP, /atlas_get_prediction again/);
  const upstream = "https://ark-content.tos-ap-southeast-1.volces.com/out.jpeg";
  const card = cardFromToolResult(
    {
      structuredContent: {
        prediction_id: "p1",
        status: "completed",
        outputs: [],
        transfer_pending: true,
        temporary_outputs: [upstream],
        next_step: TRANSFER_NEXT_STEP,
      },
    },
    {}
  );
  assert.equal(card?.state, "transfer_pending");
  assert.equal(card?.media[0]?.url, upstream);
});
