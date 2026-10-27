// 历史列表卡：atlas_list_predictions 在卡片打开时附上列表卡数据；卡片前端的解析、日期和模型名。
//
// Atlas 接口地址在模块加载时就定下来了，所以先起假接口、设环境变量，再动态 import 服务端。
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readableModelId } from "../ui/generation-card/card.js";
import { historyFromToolResult, whenLabel } from "../ui/generation-card/history.js";

let fake: Server;
let lastHistoryQuery = "";

const HISTORY_ITEMS = [
  {
    ID: "a1",
    model: "black-forest-labs/flux-schnell",
    status: "completed",
    createdAt: 1793072162,
    result: { outputs: ["https://atlas-media.oss-us-west-1.aliyuncs.com/a1.jpeg"] },
    billing: { paymentStatus: 2, amount: "0.003" },
  },
  {
    ID: "a2",
    model: "atlascloud/workflow/kling-video-effects/air_dunk",
    status: "processing",
    createdAt: 1793072100,
    result: {},
  },
  {
    ID: "a3",
    model: "black-forest-labs/flux-schnell",
    status: "failed",
    createdAt: "1793000000",
    result: { error: "Upstream timeout" },
    billing: { amount: "0" },
  },
];

before(async () => {
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/model/history") {
      lastHistoryQuery = url.search;
      res.end(JSON.stringify({ code: "200", data: { total: 23, pageNo: 1, pageSize: 3, items: HISTORY_ITEMS } }));
      return;
    }
    if (url.pathname === "/api/v1/models") {
      res.end(
        JSON.stringify({
          code: 200,
          data: [{ uuid: "1", model: "black-forest-labs/flux-schnell", type: "Image", displayName: "Flux Schnell" }],
        })
      );
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
});

after(async () => {
  await new Promise((resolve) => fake.close(resolve));
});

async function listPredictions(cards: boolean, args: Record<string, unknown>) {
  const saved = process.env.MCP_UI_CARDS;
  if (cards) process.env.MCP_UI_CARDS = "1";
  else delete process.env.MCP_UI_CARDS;
  const { createAtlasCloudServer } = await import("../src/server.js");
  const server = createAtlasCloudServer("stdio");
  const client = new Client({ name: "history-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    const result = await client.callTool({ name: "atlas_list_predictions", arguments: args });
    return { tools, result };
  } finally {
    await client.close();
    await server.close();
    if (saved === undefined) delete process.env.MCP_UI_CARDS;
    else process.env.MCP_UI_CARDS = saved;
  }
}

test("卡片关着：历史列表不挂卡片，也不带卡片数据", async () => {
  const { tools, result } = await listPredictions(false, { size: 3 });
  const tool = tools.find((t) => t.name === "atlas_list_predictions");
  assert.equal(tool?._meta?.ui, undefined);
  assert.equal(result._meta?.["atlascloud/history"], undefined);
});

test("卡片打开：历史列表带上列表卡数据——状态、缩略图、实际扣费、模型名、筛选", async () => {
  const { tools, result } = await listPredictions(true, { size: 3, state: "succeeded" });
  const tool = tools.find((t) => t.name === "atlas_list_predictions");
  assert.equal((tool?._meta?.ui as { resourceUri?: string })?.resourceUri, "ui://atlascloud/generation-card.html");
  assert.match(lastHistoryQuery, /state=succeeded/);

  const history = result._meta?.["atlascloud/history"] as {
    view: string;
    total: number;
    has_more: boolean;
    state?: string;
    items: Array<Record<string, unknown>>;
  };
  assert.equal(history.view, "history");
  assert.equal(history.total, 23);
  assert.equal(history.has_more, true);
  assert.equal(history.state, "succeeded");
  const [done, running, failed] = history.items;
  assert.equal(done!.state, "succeeded");
  assert.equal(done!.model_name, "Flux Schnell");
  assert.equal(done!.model_type, "Image");
  assert.equal(done!.price_usd, 0.003);
  assert.deepEqual(done!.thumb, { url: "https://atlas-media.oss-us-west-1.aliyuncs.com/a1.jpeg", kind: "image" });
  assert.equal(done!.created_at, new Date(1793072162 * 1000).toISOString());
  assert.equal(running!.state, "running");
  assert.equal(running!.model_name, undefined);
  assert.equal(running!.outputs, 0);
  assert.equal(failed!.state, "failed");
  assert.equal(failed!.error, "Upstream timeout");
});

test("卡片前端：优先读 _meta，宿主丢了就从 structuredContent 推出列表", () => {
  const meta = { view: "history", page: 1, size: 10, total: 1, has_more: false, items: [] };
  assert.deepEqual(historyFromToolResult({ _meta: { "atlascloud/history": meta } }), meta);

  const derived = historyFromToolResult({
    structuredContent: {
      total: 12,
      page: 2,
      size: 5,
      has_more: true,
      predictions: [
        { prediction_id: "p1", model: "m/x", status: "completed", outputs: ["https://x.test/a.mp4"], created_at: "2026-10-27T03:00:00Z" },
        { prediction_id: "p2", model: "m/y", status: "processing", outputs: [] },
        { model: "no id" },
      ],
    },
  });
  assert.equal(derived?.total, 12);
  assert.equal(derived?.page, 2);
  assert.equal(derived?.has_more, true);
  assert.deepEqual(
    derived?.items.map((item) => [item.prediction_id, item.state, item.thumb?.kind]),
    [
      ["p1", "succeeded", "video"],
      ["p2", "running", undefined],
    ]
  );
  // 生成卡的结果不是历史列表。
  assert.equal(historyFromToolResult({ structuredContent: { prediction_id: "p", status: "completed" } }), undefined);
});

test("卡片前端：时间写成 Today / Yesterday / Oct 25，24 小时制", () => {
  const now = new Date(2026, 9, 27, 15, 0);
  assert.equal(whenLabel(new Date(2026, 9, 27, 12, 6).toISOString(), now), "Today 12:06");
  assert.equal(whenLabel(new Date(2026, 9, 26, 18, 20).toISOString(), now), "Yesterday 18:20");
  assert.equal(whenLabel(new Date(2026, 9, 25, 9, 5).toISOString(), now), "Oct 25, 09:05");
  assert.equal(whenLabel(undefined, now), null);
  assert.equal(whenLabel("not a date", now), null);
});

test("卡片前端：目录里没有的模型，ID 去掉前缀写成可读名字", () => {
  assert.equal(readableModelId("atlascloud/workflow/kling-video-effects/korean_baseball"), "Kling Video Effects Korean Baseball");
  assert.equal(readableModelId("atlascloud/studio/product-visuals"), "Product Visuals");
  assert.equal(readableModelId("black-forest-labs/flux-schnell"), "Flux Schnell");
  assert.equal(readableModelId("bytedance/seedream-v4.7"), "Seedream v4.7");
  assert.equal(readableModelId("single"), "Single");
});
