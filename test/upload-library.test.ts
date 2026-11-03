// 上传存进资产库（资产库二期）：atlas_get_upload_url 先查资产库能不能用，能用就签存进资产库的票；
// 中转把字节边收边转给 AssetD（包成 multipart），再换一个临时地址交回去。
// Atlas 接口地址在模块加载时就定下来了，所以先起假接口、设环境变量，再动态 import 服务端。
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

let fake: Server;
/** 打开后资产库接口回 AssetD 的 403 asset_library_not_activated（充值后才能用）。 */
let notActivated = false;
/** 打开后上传回 AssetD 的 413 upload_quota_exceeded（上传空间满了）。 */
let quotaFull = false;
/** 打开后上传回 AssetD 拒收超像素图片的 422。 */
let tooManyPixels = false;
/** 收到的上传：Content-Type 和原始请求体。 */
const received: Array<{ contentType: string; body: Buffer; authorization: string | undefined }> = [];
const media: string[] = [];

const UPLOADED_ID = "asset_upload11111111111111111111111111";

before(async () => {
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (notActivated && url.pathname.startsWith("/api/v1/assetd/api/assets")) {
        res.statusCode = 403;
        res.end(JSON.stringify({ code: 403, msg: "asset_library_not_activated", error: { code: "asset_library_not_activated" } }));
        return;
      }
      if (url.pathname === "/api/v1/assetd/api/assets" && req.method === "GET") {
        res.end(JSON.stringify({ code: 200, msg: "succeed", data: { items: [], pagination: { limit: 1, count: 0 } } }));
        return;
      }
      if (url.pathname === "/api/v1/assetd/api/assets/uploads" && req.method === "POST" && quotaFull) {
        res.statusCode = 413;
        res.end(JSON.stringify({ code: 413, msg: "upload_quota_exceeded", error: { code: "upload_quota_exceeded" } }));
        return;
      }
      if (url.pathname === "/api/v1/assetd/api/assets/uploads" && req.method === "POST" && tooManyPixels) {
        res.statusCode = 422;
        res.end(
          JSON.stringify({ code: 422, msg: "not_supported: image 8000x6500 exceeds 24000000 pixel limit", error: { code: "not_supported" } })
        );
        return;
      }
      if (url.pathname === "/api/v1/assetd/api/assets/uploads" && req.method === "POST") {
        received.push({ contentType: String(req.headers["content-type"]), body, authorization: req.headers.authorization });
        const mime = /Content-Type: (\S+)\r\n\r\n/.exec(body.toString("latin1"))?.[1] ?? "";
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            code: 201,
            msg: "succeed",
            data: { asset_id: UPLOADED_ID, media_type: mime.split("/")[0], mime_type: mime, size_bytes: 9, status: "ready" },
          })
        );
        return;
      }
      if (url.pathname === "/api/v1/assetd/api/assets/source-urls" && req.method === "POST") {
        const ids = (JSON.parse(body.toString()) as { asset_ids: string[] }).asset_ids;
        res.end(
          JSON.stringify({
            code: 200,
            msg: "succeed",
            data: {
              items: ids.map((id) => ({
                asset_id: id,
                source_url: `https://atlas-asset-dev.oss-us-west-1.aliyuncs.com/${id}?Expires=1`,
                expires_at: "2026-11-03T09:18:42Z",
                mime_type: "image/png",
              })),
            },
          })
        );
        return;
      }
      if (url.pathname === "/api/v1/model/uploadMedia" && req.method === "POST") {
        media.push(String(req.headers["content-type"]));
        res.end(
          JSON.stringify({
            code: 200,
            message: "success",
            data: { type: "image", download_url: "https://atlas-img.example.test/images/x.png", filename: "x.png", size: 9 },
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.ATLASCLOUD_API_BASE_URL = origin;
  process.env.ATLASCLOUD_GENERATION_API_BASE_URL = origin;
});

after(async () => {
  await new Promise((resolve) => fake.close(resolve));
});

class StubVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return {
      token,
      clientId: "https://chatgpt.com/oauth/client.json",
      scopes: ["tasks:read", "tasks:write"],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      resource: new URL("http://127.0.0.1/mcp"),
      extra: { sub: "test-user" },
    };
  }
}

async function startRelay(overrides: Record<string, string> = {}) {
  const { loadHttpServerConfig } = await import("../src/config.js");
  const { createHttpApp } = await import("../src/http.js");
  const { InMemoryIdempotencyStore } = await import("../src/services/idempotency.js");
  const { InMemoryUploadTicketStore } = await import("../src/services/upload-ticket-store.js");
  const config = loadHttpServerConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    MCP_PUBLIC_URL: "http://127.0.0.1/mcp",
    MCP_OAUTH_ISSUER: "http://issuer.test",
    MCP_OAUTH_JWKS_URI: "http://issuer.test/jwks",
    MCP_OAUTH_ALGORITHMS: "RS256",
    MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
    MCP_ALLOWED_ORIGINS: "https://chatgpt.com",
    ATLASCLOUD_API_KEY: "test-atlas-key",
    MCP_IDEMPOTENCY_BACKEND: "memory",
    MCP_UPLOAD_TO_ASSET_LIBRARY: "true",
    // 最小允许值：图片、音频 1 MiB，视频 2 MiB。
    MCP_LIBRARY_UPLOAD_MAX_BYTES: "1048576",
    MCP_LIBRARY_VIDEO_UPLOAD_MAX_BYTES: "2097152",
    ...overrides,
  });
  const mediaNameStore = new InMemoryUploadTicketStore();
  const app = createHttpApp(config, {
    verifier: new StubVerifier(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    credentialResolver: {
      async resolve() {
        return { subject: "test-user", apiKey: "test-atlas-key" };
      },
    },
    mediaNameStore,
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    mediaNameStore,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function mint(baseUrl: string): Promise<{ path: string; structured: Record<string, unknown> }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer all", Origin: "https://chatgpt.com" } },
  });
  const client = new Client({ name: "upload-library-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const minted = await client.callTool({ name: "atlas_get_upload_url", arguments: {} });
    const structured = minted.structuredContent as Record<string, unknown>;
    return { path: new URL(String(structured.upload_url)).pathname, structured };
  } finally {
    await client.close();
  }
}

test("资产库开通了：票据存进资产库，中转边收边转、带上原文件名，回资产编号和临时地址", async () => {
  notActivated = false;
  received.length = 0;
  const relay = await startRelay();
  try {
    const { path, structured } = await mint(relay.baseUrl);
    assert.equal(structured.saves_to_asset_library, true);
    assert.equal(structured.max_bytes, 1_048_576);
    assert.equal(structured.max_video_bytes, 2_097_152);

    const png = Buffer.from("\x89PNG-bytes", "latin1");
    const response = await fetch(`${relay.baseUrl}${path}?filename=${encodeURIComponent("产品图.png")}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: png,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.asset_id, UPLOADED_ID);
    assert.match(String(body.url), new RegExp(`${UPLOADED_ID}\\?Expires=1$`));
    assert.equal(body.media_type, "image");

    assert.equal(received.length, 1);
    const sent = received[0]!;
    assert.equal(sent.authorization, "Bearer test-atlas-key");
    const boundary = /boundary=(\S+)/.exec(sent.contentType)?.[1];
    assert.ok(boundary, "包成 multipart 发");
    const raw = sent.body.toString("utf8");
    // 中文名放在 multipart 里（Go 按 UTF-8 读）；octet-stream 按扩展名补成 image/png。
    assert.match(raw, /filename="产品图\.png"/);
    assert.match(raw, /filename\*=UTF-8''%E4%BA%A7%E5%93%81%E5%9B%BE\.png/);
    assert.match(raw, /Content-Type: image\/png\r\n\r\n/);
    assert.ok(sent.body.includes(png), "文件字节原样转过去");
    assert.ok(raw.endsWith(`\r\n--${boundary}--\r\n`));

    // 报价卡按原名显示、标「Uploaded」，确认时按资产编号换新地址。
    const { rememberedMedia } = await import("../src/services/media-names.js");
    const remembered = await rememberedMedia([String(body.url)], relay.mediaNameStore);
    assert.deepEqual(remembered.get(String(body.url)), { name: "产品图.png", source: "upload", assetId: UPLOADED_ID, kind: "image" });
  } finally {
    await relay.close();
  }
});

test("资产库按类型限大小：图片超了直接 413、不转给上游；视频按视频的上限", async () => {
  notActivated = false;
  received.length = 0;
  const relay = await startRelay();
  try {
    const { path } = await mint(relay.baseUrl);
    const tooBig = await fetch(`${relay.baseUrl}${path}?filename=big.jpg`, { method: "POST", body: Buffer.alloc(1_048_577) });
    assert.equal(tooBig.status, 413);
    const body = (await tooBig.json()) as { error: string; max_bytes: number };
    assert.equal(body.error, "upload_too_large");
    assert.equal(body.max_bytes, 1_048_576);
    assert.equal(received.length, 0, "超限的请求不该到达上游");

    // 不带 Content-Length（分块发）：边收边数，超了就中断，同样回 413。
    const chunked = await fetch(`${relay.baseUrl}${path}?filename=big.png`, {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 5; i += 1) controller.enqueue(new Uint8Array(300_000));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    assert.equal(chunked.status, 413);
    assert.equal(((await chunked.json()) as { max_bytes: number }).max_bytes, 1_048_576);
    received.length = 0;

    const video = await fetch(`${relay.baseUrl}${path}?filename=clip.mp4`, { method: "POST", body: Buffer.alloc(1_500_000) });
    assert.equal(video.status, 200);
    assert.equal(received.length, 1);
    assert.match(received[0]!.body.toString("latin1"), /Content-Type: video\/mp4\r\n\r\n/);
  } finally {
    await relay.close();
  }
});

test("资产库没开通：签普通的票，照旧转投 /model/uploadMedia，上限是 MCP_UPLOAD_MAX_BYTES", async () => {
  notActivated = true;
  received.length = 0;
  media.length = 0;
  const relay = await startRelay();
  try {
    const { path, structured } = await mint(relay.baseUrl);
    assert.equal(structured.saves_to_asset_library, false);
    assert.equal(structured.max_bytes, 33_554_432);
    assert.equal(structured.max_video_bytes, undefined);
    const response = await fetch(`${relay.baseUrl}${path}?filename=cat.png`, { method: "POST", body: Buffer.from("png-bytes") });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.url, "https://atlas-img.example.test/images/x.png");
    assert.equal(body.asset_id, undefined);
    assert.equal(received.length, 0);
    assert.equal(media.length, 1);
    assert.match(media[0]!, /^multipart\/form-data/);
  } finally {
    notActivated = false;
    await relay.close();
  }
});

test("签票后资产库变得不能用：回 401 让卡片换票（换到的是普通的票）", async () => {
  notActivated = false;
  const relay = await startRelay();
  try {
    const { path } = await mint(relay.baseUrl);
    notActivated = true;
    const response = await fetch(`${relay.baseUrl}${path}?filename=cat.png`, { method: "POST", body: Buffer.from("png-bytes") });
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as { error: string }).error, "asset_library_not_activated");
  } finally {
    notActivated = false;
    await relay.close();
  }
});

test("没开这项配置：不查资产库，照旧签普通的票", async () => {
  notActivated = false;
  const relay = await startRelay({ MCP_UPLOAD_TO_ASSET_LIBRARY: "false" });
  try {
    const { structured } = await mint(relay.baseUrl);
    assert.equal(structured.saves_to_asset_library, false);
    assert.equal(structured.max_bytes, 33_554_432);
  } finally {
    await relay.close();
  }
});

test("上传空间满了：回 413 并另给一张普通上传的地址，文件传到那里照样能用，只是不存进资产库", async () => {
  notActivated = false;
  quotaFull = true;
  const relay = await startRelay();
  try {
    const { path } = await mint(relay.baseUrl);
    const response = await fetch(`${relay.baseUrl}${path}?filename=cat.png`, { method: "POST", body: Buffer.from("png-bytes") });
    assert.equal(response.status, 413);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, "upload_quota_exceeded");
    assert.equal(body.quota_bytes, 2_147_483_648);
    assert.equal(body.fallback_max_bytes, 33_554_432);
    assert.match(String(body.message), /fallback_upload_url/);
    assert.equal(typeof body.fallback_expires_at, "string");

    const before = media.length;
    const fallbackPath = new URL(String(body.fallback_upload_url)).pathname;
    const retried = await fetch(`${relay.baseUrl}${fallbackPath}?filename=cat.png`, { method: "POST", body: Buffer.from("png-bytes") });
    assert.equal(retried.status, 200);
    const done = (await retried.json()) as Record<string, unknown>;
    assert.equal(done.url, "https://atlas-img.example.test/images/x.png");
    assert.equal(done.asset_id, undefined);
    assert.equal(media.length, before + 1);
  } finally {
    quotaFull = false;
    await relay.close();
  }
});

test("超像素的图片：回 422 image_too_large，带尺寸和上限，不再当成格式不收", async () => {
  notActivated = false;
  tooManyPixels = true;
  const relay = await startRelay();
  try {
    const { path } = await mint(relay.baseUrl);
    const response = await fetch(`${relay.baseUrl}${path}?filename=hero.png`, { method: "POST", body: Buffer.from("png-bytes") });
    assert.equal(response.status, 422);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, "image_too_large");
    assert.equal(body.width, 8000);
    assert.equal(body.height, 6500);
    assert.equal(body.max_pixels, 24_000_000);
    assert.match(String(body.message), /52 MP\), over the 24 MP limit/);
  } finally {
    tooManyPixels = false;
    await relay.close();
  }
});
