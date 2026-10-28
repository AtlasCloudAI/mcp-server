// 资产库：atlas_search_assets / atlas_use_assets 两个工具、卡片数据，以及卡片前端的解析和交给模型的文字。
//
// 假接口照 2026-10-28 dev 实测的形状写：生成历史归档进来的素材标题是占位的 upload，视频没有缩略图；
// 换原图地址是整批处理，有一个编号找不到整批 404。
// Atlas 接口地址在模块加载时就定下来了，所以先起假接口、设环境变量，再动态 import 服务端。
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assetsForModel, assetsFromToolResult, usedFromToolResult } from "../ui/generation-card/assets.js";
import { filesForModel } from "../ui/generation-card/upload.js";

let fake: Server;
let lastListQuery = "";
const sourceUrlBodies: string[][] = [];
/** 打开后列表接口回旧版 kubedl 的 401（白名单还没放开资产库）。 */
let rejectScoped = false;

const IMAGE = {
  asset_id: "asset_a61d817802ff0ffcaae91e6bde2673c5",
  title: "upload",
  original_filename: "upload.bin",
  media_type: "image",
  status: "ready",
  source_origin: "platform_history",
  platform_asset_role: "output",
  thumbnail_url: "https://atlas-media-dev.oss-us-west-1.aliyuncs.com/assetd-history/v1/a.jpg?sig=1",
  preview_url: "https://atlas-media-dev.oss-us-west-1.aliyuncs.com/assetd-history/v1/a-preview.jpg?sig=1",
  created_at: "2026-10-26T10:45:38.605Z",
  generation_context: { model_route: "atlascloud/studio/material-clone", params: { prompt: "a red sneaker on white" } },
};
const VIDEO = {
  asset_id: "asset_1f67b13776e38b788fa3f1d2fed5c67a",
  title: "upload",
  media_type: "video",
  status: "ready",
  source_origin: "platform_history",
  platform_asset_role: "output",
  thumbnail_url: null,
  preview_url: "https://atlas-media-dev.oss-us-west-1.aliyuncs.com/assetd-history/v1/v.mp4?sig=1",
  created_at: "2026-10-25T08:00:00Z",
  generation_context: { model_route: "atlascloud/studio/tvc-maker" },
};
const UPLOAD = {
  asset_id: "asset_upload0000000000000000000000001",
  title: "sneaker-front.jpg",
  media_type: "image",
  status: "ready",
  source_origin: "user_upload",
  // 签名失败时的相对路径：卡片和模型都用不了。
  thumbnail_url: "/api/assets/asset_upload0000000000000000000000001/thumbnail",
  created_at: "2026-10-24T08:00:00Z",
};
const KNOWN = new Set([IMAGE.asset_id, VIDEO.asset_id, UPLOAD.asset_id]);

before(async () => {
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/assetd/api/assets" && req.method === "GET") {
      if (rejectScoped) {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: 40100, error: "invalid_token", message: "this endpoint does not accept scoped access tokens" }));
        return;
      }
      lastListQuery = url.search;
      const type = url.searchParams.get("media_type");
      const items = [IMAGE, VIDEO, UPLOAD].filter((item) => !type || item.media_type === type);
      res.end(JSON.stringify({ code: 200, msg: "succeed", data: { items, pagination: { limit: 12, count: items.length, next_cursor: type ? undefined : "cursor-2" } } }));
      return;
    }
    if (url.pathname === "/api/v1/assetd/api/assets/source-urls" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const ids = (JSON.parse(body) as { asset_ids: string[] }).asset_ids;
        sourceUrlBodies.push(ids);
        if (ids.some((id) => !KNOWN.has(id))) {
          res.statusCode = 404;
          res.end(JSON.stringify({ code: 404, msg: "not_found", error: { code: "not_found", retryable: false } }));
          return;
        }
        res.end(
          JSON.stringify({
            code: 200,
            msg: "succeed",
            data: {
              items: ids.map((id) => ({
                asset_id: id,
                source_url: `https://atlas-asset-dev.oss-us-west-1.aliyuncs.com/${id}?Expires=1`,
                expires_at: "2026-10-28T09:18:42Z",
                mime_type: id === VIDEO.asset_id ? "video/mp4" : "image/jpeg",
              })),
            },
          })
        );
      });
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

async function callTool(cards: boolean, name: string, args: Record<string, unknown>) {
  const saved = process.env.MCP_UI_CARDS;
  if (cards) process.env.MCP_UI_CARDS = "1";
  else delete process.env.MCP_UI_CARDS;
  const { createAtlasCloudServer } = await import("../src/server.js");
  const server = createAtlasCloudServer("stdio");
  const client = new Client({ name: "assets-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    const result = await client.callTool({ name, arguments: args });
    return { tools, result };
  } finally {
    await client.close();
    await server.close();
    if (saved === undefined) delete process.env.MCP_UI_CARDS;
    else process.env.MCP_UI_CARDS = saved;
  }
}

function text(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks.map((block) => block.text ?? "").join("\n");
}

test("搜索：只要能用的素材，按类型筛；占位标题换成「类型 · 模型 结果」", async () => {
  const { result } = await callTool(false, "atlas_search_assets", { query: "sneaker", media_type: "image", limit: 5 });
  const query = new URLSearchParams(lastListQuery);
  assert.equal(query.get("q"), "sneaker");
  assert.equal(query.get("media_type"), "image");
  assert.equal(query.get("limit"), "5");
  assert.equal(query.get("status"), "ready");
  const structured = result.structuredContent as { count: number; assets: Array<Record<string, unknown>> };
  assert.equal(structured.count, 2);
  assert.equal(structured.assets[0]!.name, "Image · material-clone result");
  assert.equal(structured.assets[0]!.prompt, "a red sneaker on white");
  assert.equal(structured.assets[1]!.name, "sneaker-front.jpg");
  assert.equal(structured.assets[1]!.origin, "upload");
  // 签名失败的相对路径丢掉。
  assert.equal(structured.assets[1]!.thumbnail_url, undefined);
  assert.match(text(result), /call atlas_use_assets/);
  assert.equal(result._meta?.["atlascloud/assets"], undefined, "卡片关着不带卡片数据");
});

test("搜索 + 卡片：工具挂卡片，结果带资产库卡数据；视频没有缩略图时用预览取第一帧", async () => {
  const { tools, result } = await callTool(true, "atlas_search_assets", {});
  const tool = tools.find((t) => t.name === "atlas_search_assets");
  assert.ok((tool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri);
  const card = result._meta?.["atlascloud/assets"] as Record<string, unknown>;
  assert.equal(card.view, "assets");
  assert.equal(card.next_cursor, "cursor-2");
  assert.equal(card.max_pick, 10);
  const items = card.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 3);
  assert.equal(items[0]!.thumb_url, IMAGE.thumbnail_url);
  assert.equal(items[0]!.preview_url, undefined, "图片用缩略图，不带大图预览");
  assert.equal(items[1]!.kind, "video");
  assert.equal(items[1]!.thumb_url, undefined);
  assert.equal(items[1]!.preview_url, VIDEO.preview_url);
  // 卡片前端解析得出同样的数据。
  assert.deepEqual(assetsFromToolResult(result)?.items, items);
});

test("换原图地址：一次换好；use 工具声明卡片可调但自己不画卡片", async () => {
  sourceUrlBodies.length = 0;
  const { tools, result } = await callTool(true, "atlas_use_assets", { asset_ids: [IMAGE.asset_id, VIDEO.asset_id, IMAGE.asset_id] });
  assert.deepEqual(sourceUrlBodies, [[IMAGE.asset_id, VIDEO.asset_id]], "重复的编号只换一次");
  const tool = tools.find((t) => t.name === "atlas_use_assets");
  assert.equal(tool?._meta?.["openai/widgetAccessible"], true);
  assert.equal((tool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, undefined);
  const used = usedFromToolResult(result);
  assert.equal(used?.assets.length, 2);
  assert.deepEqual(used?.missing, []);
  assert.match(text(result), /expire at 2026-10-28T09:18:42Z/);
  assert.equal(assetsFromToolResult(result), undefined, "use 的结果不能被当成资产库卡");
});

test("换原图地址：整批 404 时逐个再换，挑出不可用的；全都不可用算出错", async () => {
  sourceUrlBodies.length = 0;
  const missing = "asset_deleted000000000000000000000001";
  const { result } = await callTool(false, "atlas_use_assets", { asset_ids: [IMAGE.asset_id, missing] });
  assert.deepEqual(sourceUrlBodies, [[IMAGE.asset_id, missing], [IMAGE.asset_id], [missing]]);
  const structured = result.structuredContent as { assets: unknown[]; missing: string[] };
  assert.equal(structured.assets.length, 1);
  assert.deepEqual(structured.missing, [missing]);
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Not available/);

  const { result: none } = await callTool(false, "atlas_use_assets", { asset_ids: [missing] });
  assert.equal(none.isError, true);
});

test("后端还没给插件令牌放开资产库：说清楚，让模型改用上传", async () => {
  rejectScoped = true;
  try {
    const { result } = await callTool(false, "atlas_search_assets", {});
    assert.equal(result.isError, true);
    assert.match(text(result), /isn't available to this Atlas Cloud connection yet/);
    assert.match(text(result), /atlas_get_upload_url/);
  } finally {
    rejectScoped = false;
  }
});

test("编号格式不对的在参数校验就拦下", async () => {
  const { result } = await callTool(false, "atlas_use_assets", { asset_ids: ["../../asset-library/settings"] });
  assert.equal(result.isError, true);
});

test("交给模型的文字：带编号，说清地址是临时的、过期了怎么换", () => {
  const forModel = assetsForModel([{ asset_id: IMAGE.asset_id, label: "Image · material-clone result", kind: "image", url: "https://x/a.jpg" }]);
  assert.match(forModel, /1 file from their Atlas Asset Library/);
  assert.match(forModel, new RegExp(`\\(image, ${IMAGE.asset_id}\\): https://x/a.jpg`));
  assert.match(forModel, /atlas_use_assets/);

  // 上传卡里混着上传的文件和资产库选来的：资产库的带编号和提示，上传的照旧。
  const mixed = filesForModel([
    { name: "photo.jpg", kind: "image", url: "https://u/photo.jpg" },
    { name: "sneaker-front.jpg", kind: "image", url: "https://x/s.jpg", asset_id: UPLOAD.asset_id },
  ]);
  assert.match(mixed, /- photo\.jpg \(image\): https:\/\/u\/photo\.jpg/);
  assert.match(mixed, new RegExp(`from the Asset Library, ${UPLOAD.asset_id}\\): https://x/s.jpg`));
  assert.match(mixed, /temporary/);
  assert.doesNotMatch(filesForModel([{ name: "photo.jpg", kind: "image", url: "https://u/p.jpg" }]), /temporary/);
});
