// 11-18 上线前审查：走真实 McpServer + Client（内存传输）的几条。
// M3 atlas_cancel_quote 遇到结果未知的提交；M8 工具描述里不再写死「failed 不扣费」；
// M9 只读结构化结果的 ChatGPT 也拿得到卡片说明和「确认了却没开始」。
//
// 接口地址在模块加载时就定了：先起假接口、设环境变量，再动态 import 服务端。
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const UI_MIME = "text/html;profile=mcp-app";
let fake: Server;

const ASSET = {
  asset_id: "asset_a61d817802ff0ffcaae91e6bde2673c5",
  title: "sneaker.jpg",
  media_type: "image",
  status: "ready",
  source_origin: "user_upload",
  created_at: "2026-11-18T08:00:00Z",
};

before(async () => {
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/assetd/api/assets" && req.method === "GET") {
      res.end(JSON.stringify({ code: 200, msg: "succeed", data: { items: [ASSET], pagination: { limit: 12, count: 1 } } }));
      return;
    }
    if (url.pathname === "/api/v1/model/history" && req.method === "GET") {
      res.end(JSON.stringify({ code: 200, data: { total: 0, pageNo: 1, pageSize: 10, items: [] } }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.ATLASCLOUD_API_BASE_URL = origin;
  process.env.ATLASCLOUD_GENERATION_API_BASE_URL = origin;
  process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
  process.env.MCP_INPUT_LINK_CHECK = "off";
  process.env.MCP_UI_CARDS = "1";
});

after(async () => {
  delete process.env.MCP_UI_CARDS;
  await new Promise((resolve) => fake.close(resolve));
});

async function connect(rendersCards: boolean) {
  const { createAtlasCloudServer } = await import("../src/server.js");
  const server = createAtlasCloudServer("stdio");
  const client = new Client(
    { name: "prelaunch-review-test", version: "1.0.0" },
    rendersCards ? { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } } } } : {}
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: { content?: unknown }): string {
  return ((result.content ?? []) as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
}

test("M3: atlas_cancel_quote on a submission with no confirmed answer says it may have been submitted, check first", async () => {
  const { executeIdempotently } = await import("../src/services/idempotency.js");
  const uncertain = "5a7c0000-0000-4000-8000-000000000001";
  await executeIdempotently("atlas_generate_video", { idempotency_key: uncertain, prompt: "x" }, uncertain, async () => {
    throw new Error("fetch failed");
  }).catch(() => undefined);
  const noId = "5a7c0000-0000-4000-8000-000000000002";
  await executeIdempotently("atlas_generate_video", { idempotency_key: noId, prompt: "x" }, noId, async () => ({ ok: false, message: "no id" }));
  const done = "5a7c0000-0000-4000-8000-000000000003";
  await executeIdempotently("atlas_generate_video", { idempotency_key: done, prompt: "x" }, done, async () => ({ ok: true, predictionId: "pred-done" }));

  const { client, close } = await connect(true);
  try {
    for (const key of [uncertain, noId]) {
      const result = await client.callTool({
        name: "atlas_cancel_quote",
        arguments: { tool: "atlas_generate_video", idempotency_key: key, reason: "declined" },
      });
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.status, "possibly_submitted", key);
      assert.match(String(structured.next_step), /atlas_list_predictions/);
      assert.match(textOf(result), /may already have been submitted/);
      assert.doesNotMatch(textOf(result), /was already submitted/);
    }
    const submitted = await client.callTool({
      name: "atlas_cancel_quote",
      arguments: { tool: "atlas_generate_video", idempotency_key: done, reason: "declined" },
    });
    assert.deepEqual(submitted.structuredContent, { status: "already_submitted", prediction_id: "pred-done" });
  } finally {
    await close();
  }
});

test("M8: generation tool descriptions point at charge_status / charged_usd instead of promising failed jobs are free", async () => {
  const { client, close } = await connect(false);
  try {
    const { tools } = await client.listTools();
    for (const name of ["atlas_generate_image", "atlas_generate_video", "atlas_generate_audio", "atlas_transcribe_audio", "atlas_quick_generate"]) {
      const description = String(tools.find((tool) => tool.name === name)?.description);
      assert.doesNotMatch(description, /"failed" is not billed/, name);
      assert.match(description, /charge_status/, name);
      assert.match(description, /charged_usd/, name);
      assert.match(description, /partly billed/, name);
    }
    const list = await client.callTool({ name: "atlas_list_predictions", arguments: {} });
    assert.doesNotMatch(textOf(list), /Failed tasks were not billed/);
    assert.match(textOf(list), /go by its charged_usd/);
  } finally {
    await close();
  }
  const { autoSubmitNotice } = await import("../src/services/spend-policy.js");
  const notice = autoSubmitNotice({ autoSubmit: true, quotedUsd: 0.2, thresholdUsd: 1, reason: "" });
  assert.doesNotMatch(notice, /is not billed\./);
  assert.match(notice, /charge_status/);
});

test("M9: the upload card's card_note is in structuredContent, ahead of curl_example", async () => {
  const { UPLOAD_CARD_NOTE } = await import("../src/apps/upload-card.js");
  const { client, close } = await connect(true);
  try {
    const result = await client.callTool({ name: "atlas_open_upload_card", arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.card_note, UPLOAD_CARD_NOTE);
    assert.equal(Object.keys(structured)[0], "card_note");
    assert.ok(typeof structured.curl_example === "string");
  } finally {
    await close();
  }
});

test("M9: atlas_search_assets puts the Asset Library card note in structuredContent when the card shows", async () => {
  const { ASSETS_CARD_NOTE } = await import("../src/apps/asset-library.js");
  const withCard = await connect(true);
  try {
    const result = await withCard.client.callTool({ name: "atlas_search_assets", arguments: {} });
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.card_note, ASSETS_CARD_NOTE);
    assert.equal(Object.keys(structured)[0], "card_note");
  } finally {
    await withCard.close();
  }
  const plain = await connect(false);
  try {
    const result = await plain.client.callTool({ name: "atlas_search_assets", arguments: {} });
    assert.equal((result.structuredContent as Record<string, unknown>).card_note, undefined);
  } finally {
    await plain.close();
  }
});

test("M9: confirmed-but-not-started jobs are in atlas_list_predictions' structuredContent, not only in the text", async () => {
  const { rememberNotStarted } = await import("../src/services/not-started.js");
  await rememberNotStarted("bytedance/seedance-2.5/text-to-video", "Error: Insufficient balance. Please top up your account.");
  const { client, close } = await connect(false);
  try {
    const result = await client.callTool({ name: "atlas_list_predictions", arguments: {} });
    const structured = result.structuredContent as Record<string, unknown>;
    const notStarted = structured.not_started as { note: string; entries: Array<Record<string, unknown>> };
    assert.ok(notStarted, JSON.stringify(structured));
    assert.match(notStarted.note, /did not start/);
    assert.equal(notStarted.entries[0]!.model, "bytedance/seedance-2.5/text-to-video");
    assert.match(String(notStarted.entries[0]!.reason), /Insufficient balance/);
    // card_note 仍在最前面。
    assert.equal(Object.keys(structured)[0], "card_note");
  } finally {
    await close();
  }
});

test("M9: the tracking card note is in structuredContent once a submitted job is on a card", async () => {
  const { withGenerationCard } = await import("../src/apps/generation-quote.js");
  const capabilities = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } } };
  const server = { server: { getClientCapabilities: () => capabilities } } as unknown as McpServer;
  const handler = async () => ({
    structuredContent: {
      prediction_id: "p1",
      model_id: "black-forest-labs/flux-schnell",
      model_name: "Flux Schnell",
      kind: "image",
      status: "submitted",
    },
    content: [{ type: "text" as const, text: "Image generation submitted successfully." }],
  });
  const result = await withGenerationCard(server, "atlas_generate_image", handler)(
    { idempotency_key: "k", confirmed: true, confirmation_token: "c", model: "black-forest-labs/flux-schnell", params: { prompt: "x" } },
    {} as never
  );
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(Object.keys(structured)[0], "card_note");
  assert.match(String(structured.card_note), /already tracks this task/);
  assert.equal(structured.prediction_id, "p1");
  assert.match(textOf(result), /already tracks this task/);
});
