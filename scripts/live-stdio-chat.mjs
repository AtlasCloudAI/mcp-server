#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasCloudServer } from "../dist/server.js";

const apiKey = readFileSync(0, "utf8").trim();
assert.ok(apiKey.length >= 20, "Atlas API key must be supplied on stdin");
process.env.ATLASCLOUD_API_KEY = apiKey;

const model = process.env.LIVE_CHAT_MODEL ?? "deepseek-ai/deepseek-v4.1-flash";
const maxCostUsd = Number(process.env.LIVE_CHAT_MAX_USD ?? "0.01");
const maxTokens = Number(process.env.LIVE_CHAT_MAX_TOKENS ?? "64");
// 两段各用一个幂等键：A 走「低于上限直接执行」，B 走「需要确认」
const keyAuto = process.env.LIVE_CHAT_IDEMPOTENCY_KEY ?? "6d677bb1-7314-462c-ad7d-fac023003002";
const keyConfirm = process.env.LIVE_CHAT_CONFIRM_IDEMPOTENCY_KEY ?? "0b5a4c1e-5d1f-4e2a-9b7c-3f2e1d0c9b8a";
assert.ok(Number.isFinite(maxCostUsd) && maxCostUsd > 0 && maxCostUsd <= 0.1);
assert.ok(Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 256);
for (const key of [keyAuto, keyConfirm]) {
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

const server = createAtlasCloudServer("stdio");
const client = new Client({ name: "atlascloud-live-stdio-chat", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

function text(result) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

try {
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "atlas_chat"));

  const balanceBefore = await client.callTool({ name: "atlas_get_balance", arguments: {} });
  assert.notEqual(balanceBefore.isError, true, text(balanceBefore));
  const availableBefore = Number(balanceBefore.structuredContent.available?.value);
  assert.ok(Number.isFinite(availableBefore));

  const baseArguments = {
    model,
    messages: [{ role: "user", content: "Reply with exactly: Atlas text OK" }],
    temperature: 0,
    max_tokens: maxTokens,
    top_p: 1,
  };

  // A. 最坏花费低于自动提交上限（默认 $20）：一次调用直接完成，并按用量报花费
  delete process.env.MCP_AUTOSUBMIT_MAX_USD;
  const autoArguments = { ...baseArguments, idempotency_key: keyAuto };
  const auto = await client.callTool({ name: "atlas_chat", arguments: autoArguments });
  assert.notEqual(auto.isError, true, text(auto));
  assert.equal(auto.structuredContent.status, "completed", text(auto));
  assert.equal(typeof auto.structuredContent.id, "string");
  assert.ok(auto.structuredContent.message.length > 0);
  assert.equal(typeof auto.structuredContent.cost_usd, "number");
  assert.match(text(auto), /\*\*Cost\*\*/);
  process.stdout.write(
    `STDIO_CHAT_AUTO finish_reason=${auto.structuredContent.finish_reason} ` +
      `usage=${JSON.stringify(auto.structuredContent.usage ?? {})} cost_usd=${auto.structuredContent.cost_usd}\n`
  );
  // 同一幂等键重放：拿回同一次结果，不再扣费
  const autoReplay = await client.callTool({ name: "atlas_chat", arguments: autoArguments });
  assert.equal(autoReplay.structuredContent.id, auto.structuredContent.id);

  // B. 上限压到极小：先报最坏花费并要确认，确认后才执行
  process.env.MCP_AUTOSUBMIT_MAX_USD = "0.000001";
  const confirmArguments = { ...baseArguments, idempotency_key: keyConfirm };
  const quote = await client.callTool({ name: "atlas_chat", arguments: confirmArguments });
  assert.notEqual(quote.isError, true, text(quote));
  assert.equal(quote.structuredContent.status, "confirmation_required", text(quote));
  assert.equal(quote.structuredContent.model, model);
  assert.equal(typeof quote.structuredContent.confirmation_token, "string");
  assert.equal(typeof quote.structuredContent.worst_case_cost_usd, "number");
  assert.equal(typeof quote.structuredContent.pricing.actual.input_price, "string");
  assert.equal(typeof quote.structuredContent.pricing.actual.output_price, "string");
  const completion = await client.callTool({
    name: "atlas_chat",
    arguments: { ...confirmArguments, confirmation_token: quote.structuredContent.confirmation_token },
  });
  assert.notEqual(completion.isError, true, text(completion));
  assert.equal(completion.structuredContent.status, "completed");
  assert.ok(completion.structuredContent.message.length > 0);
  delete process.env.MCP_AUTOSUBMIT_MAX_USD;

  const balanceAfter = await client.callTool({ name: "atlas_get_balance", arguments: {} });
  assert.notEqual(balanceAfter.isError, true, text(balanceAfter));
  const availableAfter = Number(balanceAfter.structuredContent.available?.value);
  const observedSpend = Math.max(0, availableBefore - availableAfter);
  assert.ok(observedSpend <= maxCostUsd + 1e-9);

  process.stdout.write(
    `STDIO_CHAT_COMPLETE model=${model} ` +
      `auto_id=${auto.structuredContent.id} confirmed_id=${completion.structuredContent.id} ` +
      `worst_case_usd=${quote.structuredContent.worst_case_cost_usd} ` +
      `message=${JSON.stringify(completion.structuredContent.message)} ` +
      `balance_delta_usd=${observedSpend.toFixed(6)}\n`
  );
} finally {
  delete process.env.ATLASCLOUD_API_KEY;
  await client.close();
  await server.close();
}
