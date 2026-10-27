// 对话内生成卡（MCP Apps）：开关、注册、卡片数据、给模型的轮询说明、远端放行，
// 以及卡片前端从工具结果里取数据的纯函数。
//
// Atlas 接口地址在模块加载时就定下来了，所以先起假接口、设环境变量，再动态 import 服务端。
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  cardFromToolResult,
  formatUsd,
  perItemPrice,
  shortId,
} from "../ui/generation-card/card.js";

const UI_MIME = "text/html;profile=mcp-app";
const CARD_URI = "ui://atlascloud/generation-card.html";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

let fake: Server;
let origin = "";

function predictionFor(id: string): Record<string, unknown> {
  const now = new Date().toISOString();
  switch (id) {
    case "done":
      return {
        model: "black-forest-labs/flux-schnell",
        status: "completed",
        outputs: [`${origin}/media/done.jpg`],
        price: "0.003",
        created_at: now,
        completed_at: now,
      };
    case "running":
      return {
        model: "black-forest-labs/flux-schnell",
        status: "processing",
        outputs: [],
        created_at: new Date(Date.now() - 90_000).toISOString(),
      };
    case "expired":
      return {
        model: "black-forest-labs/flux-schnell",
        status: "completed",
        outputs: [`${origin}/gone/old.jpg`],
        created_at: new Date(Date.now() - TWO_DAYS_MS).toISOString(),
        completed_at: new Date(Date.now() - TWO_DAYS_MS).toISOString(),
      };
    case "workflow":
      return {
        model: "atlascloud/studio/product-visuals",
        status: "completed",
        outputs: [`${origin}/media/a.jpg`, `${origin}/media/b.jpg`],
        price: "0.2593",
        created_at: now,
        completed_at: now,
      };
    default:
      return { status: "failed", outputs: [], error: "Upstream timeout" };
  }
}

before(async () => {
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = url.pathname.match(/^\/api\/v1\/model\/prediction\/([^/]+)$/);
    if (req.method === "GET" && match) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 200, data: { id: match[1], ...predictionFor(match[1]!) } }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: [
            { uuid: "1", model: "black-forest-labs/flux-schnell", type: "Image", displayName: "Flux Schnell" },
            { uuid: "2", model: "atlascloud/studio/product-visuals", type: "Image", displayName: "Image ads" },
          ],
        })
      );
      return;
    }
    if ((req.method === "HEAD" || req.method === "GET") && url.pathname.startsWith("/media/")) {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": "4" });
      res.end(req.method === "HEAD" ? undefined : Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.ATLASCLOUD_API_BASE_URL = origin;
  process.env.ATLASCLOUD_GENERATION_API_BASE_URL = origin;
  process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
  process.env.MCP_OWNED_MEDIA_HOSTS = "127.0.0.1";
  process.env.MCP_PREDICTION_WAIT_SECONDS = "0";
});

after(async () => {
  await new Promise((resolve) => fake.close(resolve));
});

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

async function connect(options: { rendersCards: boolean }) {
  const { createAtlasCloudServer } = await import("../src/server.js");
  const server = createAtlasCloudServer("stdio");
  const client = new Client(
    { name: "card-test", version: "1.0.0" },
    options.rendersCards
      ? { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } } } }
      : {}
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
  return ((result.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function cardOf(result: { _meta?: Record<string, unknown> }): Record<string, unknown> | undefined {
  return result._meta?.["atlascloud/card"] as Record<string, unknown> | undefined;
}

test("卡片默认关：不注册资源、不挂 ui 元数据、没有卡片工具，查结果也不带卡片数据", async () => {
  const restore = withEnv({ MCP_UI_CARDS: undefined, MCP_UI_SELFTEST: "1" });
  const { client, close } = await connect({ rendersCards: true });
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.some((tool) => tool.name === "atlas_card_status"), false);
    assert.equal(tools.some((tool) => tool.name === "atlas_card_selftest"), false);
    const get = tools.find((tool) => tool.name === "atlas_get_prediction");
    assert.equal(get?._meta?.ui, undefined);
    const result = await client.callTool({ name: "atlas_get_prediction", arguments: { prediction_id: "done" } });
    assert.equal(cardOf(result), undefined);
  } finally {
    await close();
    restore();
  }
});

test("卡片打开：资源按 MCP Apps 声明，查结果挂卡片，刷新工具只给卡片用", async () => {
  const restore = withEnv({ MCP_UI_CARDS: "1", MCP_UI_SELFTEST: undefined });
  const { client, close } = await connect({ rendersCards: true });
  try {
    const { resources } = await client.listResources();
    const card = resources.find((resource) => resource.uri === CARD_URI);
    assert.ok(card, "card resource must be listed");
    const read = await client.readResource({ uri: CARD_URI });
    const content = read.contents[0] as { mimeType?: string; text?: string; _meta?: Record<string, any> };
    assert.equal(content.mimeType, UI_MIME);
    assert.match(content.text ?? "", /Atlas Cloud/);
    assert.ok(content._meta?.ui?.csp?.resourceDomains.includes("https://atlas-media.oss-us-west-1.aliyuncs.com"));

    const { tools } = await client.listTools();
    const get = tools.find((tool) => tool.name === "atlas_get_prediction");
    assert.equal((get?._meta?.ui as { resourceUri?: string })?.resourceUri, CARD_URI);
    assert.equal(get?._meta?.["ui/resourceUri"], CARD_URI);
    const status = tools.find((tool) => tool.name === "atlas_card_status");
    assert.deepEqual((status?._meta?.ui as { visibility?: string[] })?.visibility, ["app"]);
    // 测试卡片要单独再开一个开关。
    assert.equal(tools.some((tool) => tool.name === "atlas_card_selftest"), false);
  } finally {
    await close();
    restore();
  }
});

test("查结果：卡片数据带模型名、类型、价格；工作流的「在 Atlas 打开」去历史页", async () => {
  const restore = withEnv({ MCP_UI_CARDS: "1" });
  const { client, close } = await connect({ rendersCards: false });
  try {
    const done = cardOf(await client.callTool({ name: "atlas_get_prediction", arguments: { prediction_id: "done" } }));
    assert.equal(done?.state, "succeeded");
    assert.equal(done?.model_name, "Flux Schnell");
    assert.equal(done?.model_type, "Image");
    assert.equal(done?.price_usd, 0.003);
    assert.equal(done?.open_url, "https://www.atlascloud.ai/models/black-forest-labs/flux-schnell");
    assert.deepEqual(done?.media, [{ url: `${origin}/media/done.jpg`, kind: "image" }]);

    const workflow = cardOf(
      await client.callTool({ name: "atlas_get_prediction", arguments: { prediction_id: "workflow" } })
    );
    assert.equal(workflow?.open_url, "https://www.atlascloud.ai/workflow/history");
    assert.equal((workflow?.media as unknown[]).length, 2);

    const failed = cardOf(await client.callTool({ name: "atlas_get_prediction", arguments: { prediction_id: "nope" } }));
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.error, "Upstream timeout");
  } finally {
    await close();
    restore();
  }
});

test("任务还在跑：客户端没声明能渲染卡片时照旧让模型轮询，声明了就说卡片会自己更新", async () => {
  const restore = withEnv({ MCP_UI_CARDS: "1" });
  const plain = await connect({ rendersCards: false });
  const withCards = await connect({ rendersCards: true });
  try {
    const a = await plain.client.callTool({ name: "atlas_get_prediction", arguments: { prediction_id: "running" } });
    assert.match(textOf(a), /keep\s+polling in this turn/);
    assert.equal(cardOf(a)?.state, "running");

    const b = await withCards.client.callTool({ name: "atlas_get_prediction", arguments: { prediction_id: "running" } });
    assert.match(textOf(b), /live Atlas card/);
    assert.doesNotMatch(textOf(b), /keep\s+polling in this turn/);
    // 不管哪种说明，都不能让模型重新提交。
    assert.match(textOf(b), /Do not submit the job again/);
  } finally {
    await plain.close();
    await withCards.close();
    restore();
  }
});

test("刷新工具只回卡片数据：没有图片块，放了两天且打不开的结果标成链接过期", async () => {
  const restore = withEnv({ MCP_UI_CARDS: "1" });
  const { client, close } = await connect({ rendersCards: true });
  try {
    const done = await client.callTool({ name: "atlas_card_status", arguments: { prediction_id: "done" } });
    assert.equal((done.content as Array<{ type: string }>).every((c) => c.type === "text"), true);
    assert.equal(cardOf(done)?.state, "succeeded");
    assert.equal(cardOf(done)?.media_expired, undefined);
    assert.equal(((done.structuredContent as { card: { state: string } }).card).state, "succeeded");

    const expired = await client.callTool({ name: "atlas_card_status", arguments: { prediction_id: "expired" } });
    assert.equal(cardOf(expired)?.media_expired, true);
  } finally {
    await close();
    restore();
  }
});

test("测试卡片：两个开关都开才注册，不调接口，结果标成示例", async () => {
  const restore = withEnv({ MCP_UI_CARDS: "1", MCP_UI_SELFTEST: "1" });
  const { client, close } = await connect({ rendersCards: true });
  try {
    const result = await client.callTool({ name: "atlas_card_selftest", arguments: { variant: "images" } });
    const card = cardOf(result);
    assert.equal(card?.sample, true);
    assert.equal((card?.media as unknown[]).length, 4);
    assert.match(textOf(result), /Nothing was generated or billed/);
  } finally {
    await close();
    restore();
  }
});

test("远端放行：卡片工具按自己的策略查 scope，未知工具不放行", async () => {
  const { remoteToolPolicy } = await import("../src/tool-policy.js");
  assert.equal(remoteToolPolicy("atlas_card_status")?.scope, "tasks:read");
  assert.equal(remoteToolPolicy("atlas_card_selftest")?.scope, null);
  assert.equal(remoteToolPolicy("atlas_get_prediction")?.scope, "tasks:read");
  assert.equal(remoteToolPolicy("atlas_unknown"), undefined);
});

test("卡片前端：优先读 _meta 里的卡片数据，没有就从 structuredContent 推", () => {
  const meta = { state: "running", prediction_id: "p1", media: [] };
  assert.deepEqual(cardFromToolResult({ _meta: { "atlascloud/card": meta } }), meta);
  assert.deepEqual(cardFromToolResult({ structuredContent: { card: meta } }), meta);

  const derived = cardFromToolResult({
    structuredContent: {
      prediction_id: "p2",
      status: "completed",
      outputs: ["https://x.test/a.mp4", "https://x.test/b.glb"],
    },
  });
  assert.equal(derived?.state, "succeeded");
  assert.deepEqual(
    derived?.media.map((m) => m.kind),
    ["video", "3d"]
  );
  assert.equal(
    cardFromToolResult({ structuredContent: { prediction_id: "p3", status: "completed", transfer_pending: true } })?.state,
    "transfer_pending"
  );
  assert.equal(cardFromToolResult({ content: [] }), undefined);
});

test("卡片前端：金额、任务 ID、单张价的格式", () => {
  assert.equal(formatUsd(0.03), "$0.03");
  assert.equal(formatUsd(1.34), "$1.34");
  assert.equal(formatUsd(0.2593), "$0.2593");
  assert.equal(formatUsd(24), "$24.00");
  assert.equal(shortId("pred_7f3a2c"), "pred_7f3a2c");
  assert.equal(shortId("fe0d875410d64c328d27c4d61a439026"), "fe0d87…9026");
  const media = [
    { url: "https://x.test/a.jpg", kind: "image" as const },
    { url: "https://x.test/b.jpg", kind: "image" as const },
  ];
  assert.equal(perItemPrice({ state: "succeeded", prediction_id: "p", media, price_usd: 0.06, model_id: "bytedance/seedream-v4.7" }), 0.03);
  // 工作流按次计费，不拆单张价。
  assert.equal(
    perItemPrice({ state: "succeeded", prediction_id: "p", media, price_usd: 0.26, model_id: "atlascloud/studio/product-visuals" }),
    undefined
  );
});
