#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasCloudServer } from "../dist/server.js";

const apiKey = readFileSync(0, "utf8").trim();
assert.ok(apiKey.length >= 20, "Atlas API key must be supplied on stdin");
process.env.ATLASCLOUD_API_KEY = apiKey;

const model = process.env.LIVE_CHAT_MODEL ?? "qwen/qwen3.5-flash";
const maxCostUsd = Number(process.env.LIVE_CHAT_MAX_USD ?? "0.01");
const maxTokens = Number(process.env.LIVE_CHAT_MAX_TOKENS ?? "64");
const idempotencyKey =
  process.env.LIVE_CHAT_IDEMPOTENCY_KEY ?? "6d677bb1-7314-462c-ad7d-fac023003002";
assert.ok(Number.isFinite(maxCostUsd) && maxCostUsd > 0 && maxCostUsd <= 0.1);
assert.ok(Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 256);
assert.match(
  idempotencyKey,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
);

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
  assert.equal(tools.tools.length, 14);
  assert.ok(tools.tools.some((tool) => tool.name === "atlas_chat"));

  const balanceBefore = await client.callTool({ name: "atlas_get_balance", arguments: {} });
  assert.notEqual(balanceBefore.isError, true, text(balanceBefore));
  const availableBefore = Number(balanceBefore.structuredContent.available?.value);
  assert.ok(Number.isFinite(availableBefore));

  const argumentsWithoutConfirmation = {
    idempotency_key: idempotencyKey,
    model,
    messages: [{ role: "user", content: "Reply with exactly: Atlas text OK" }],
    temperature: 0,
    max_tokens: maxTokens,
    top_p: 1,
  };
  const quote = await client.callTool({
    name: "atlas_chat",
    arguments: argumentsWithoutConfirmation,
  });
  assert.notEqual(quote.isError, true, text(quote));
  assert.equal(quote.structuredContent.status, "confirmation_required");
  assert.equal(quote.structuredContent.model, model);
  assert.equal(typeof quote.structuredContent.confirmation_token, "string");
  assert.equal(typeof quote.structuredContent.pricing.actual.input_price, "string");
  assert.equal(typeof quote.structuredContent.pricing.actual.output_price, "string");

  const balanceAfterQuote = await client.callTool({ name: "atlas_get_balance", arguments: {} });
  assert.notEqual(balanceAfterQuote.isError, true, text(balanceAfterQuote));
  assert.equal(
    Number(balanceAfterQuote.structuredContent.available?.value),
    availableBefore,
    "chat quote changed the balance"
  );

  const confirmedArguments = {
    ...argumentsWithoutConfirmation,
    confirmation_token: quote.structuredContent.confirmation_token,
  };
  const completion = await client.callTool({
    name: "atlas_chat",
    arguments: confirmedArguments,
  });
  assert.notEqual(completion.isError, true, text(completion));
  assert.equal(completion.structuredContent.status, "completed");
  assert.equal(typeof completion.structuredContent.id, "string");
  process.stdout.write(
    `STDIO_CHAT_RESPONSE finish_reason=${completion.structuredContent.finish_reason} ` +
      `usage=${JSON.stringify(completion.structuredContent.usage ?? {})} ` +
      `message_length=${completion.structuredContent.message.length}\n`
  );
  assert.ok(completion.structuredContent.message.length > 0);

  const replay = await client.callTool({
    name: "atlas_chat",
    arguments: confirmedArguments,
  });
  assert.notEqual(replay.isError, true, text(replay));
  assert.equal(replay.structuredContent.id, completion.structuredContent.id);

  const balanceAfter = await client.callTool({ name: "atlas_get_balance", arguments: {} });
  assert.notEqual(balanceAfter.isError, true, text(balanceAfter));
  const availableAfter = Number(balanceAfter.structuredContent.available?.value);
  const observedSpend = Math.max(0, availableBefore - availableAfter);
  assert.ok(observedSpend <= maxCostUsd + 1e-9);

  process.stdout.write(
    `STDIO_CHAT_COMPLETE tools=14 model=${model} ` +
      `completion_id=${completion.structuredContent.id} ` +
      `usage=${JSON.stringify(completion.structuredContent.usage ?? {})} ` +
      `message=${JSON.stringify(completion.structuredContent.message)} ` +
      `balance_delta_usd=${observedSpend.toFixed(6)}\n`
  );
} finally {
  delete process.env.ATLASCLOUD_API_KEY;
  await client.close();
  await server.close();
}
