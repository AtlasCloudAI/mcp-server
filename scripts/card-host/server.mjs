#!/usr/bin/env node
// 本地卡片测试宿主：不用 ChatGPT / Claude，也能按 MCP Apps 协议把生成卡真跑起来看。
//
//   npm run build
//   MCP_CARD_HOST_PORT=5199 node scripts/card-host/server.mjs
//   打开 http://127.0.0.1:5199
//
// 它像真宿主一样：用 stdio 拉起本仓库的 MCP 服务（打开卡片和测试卡片），在 initialize 里
// 声明支持 MCP Apps，读卡片资源，在加了 CSP 的沙箱 iframe 里加载，用官方 AppBridge 发工具
// 输入、工具结果，并转发卡片发起的工具调用。查真实任务要在环境变量里给 ATLASCLOUD_API_KEY。

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const port = Number.parseInt(process.env.MCP_CARD_HOST_PORT ?? "5199", 10);
const UI_MIME = "text/html;profile=mcp-app";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repo, "dist", "index.js")],
  env: {
    ...process.env,
    MCP_UI_CARDS: "1",
    MCP_UI_SELFTEST: "1",
  },
  stderr: "inherit",
});
const client = new Client(
  { name: "atlas-card-host", version: "1.0.0" },
  { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } } } }
);
await client.connect(transport);

const hostScript = (
  await build({
    entryPoints: [join(here, "host.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    write: false,
    logLevel: "warning",
  })
).outputFiles[0].text;

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

// 模拟上传中转（上传卡在测试宿主里传到这里，不碰真实存储）。地址最后一段是场景：
//   ok      慢慢收完再回地址；fail-once 第一次回 502、之后成功；
//   expired 回 410（卡片该去换新地址，换来的是 ok）；toolarge 回 413。
const failedOnce = new Set();
async function mockUpload(req, res, mode) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "Content-Type, X-Atlas-Filename");
  if (req.method === "OPTIONS") return send(res, 204, "");
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    await new Promise((r) => setTimeout(r, 15)); // 放慢接收，卡片才看得到进度
  }
  const url = new URL(req.url ?? "/", "http://x");
  const name = url.searchParams.get("filename") ?? "file";
  await new Promise((r) => setTimeout(r, 800)); // 中转转存到 Atlas 的那几秒
  if (mode === "expired") return send(res, 410, { error: "upload_ticket_expired" });
  if (mode === "toolarge") return send(res, 413, { error: "upload_too_large" });
  if (mode === "fail-once" && !failedOnce.has(name)) {
    failedOnce.add(name);
    return send(res, 502, { error: "upstream_upload_failed" });
  }
  return send(res, 200, {
    url: `https://static.atlascloud.ai/model/example/material/product-shot-01.jpg?mock=${encodeURIComponent(name)}`,
    filename: name,
    size_bytes: size,
    media_type: "image",
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/mock-upload/")) {
      return await mockUpload(req, res, url.pathname.slice("/mock-upload/".length));
    }
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, readFileSync(join(here, "index.html"), "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/host.js") {
      return send(res, 200, hostScript, "text/javascript; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/tools") {
      return send(res, 200, await client.listTools());
    }
    if (req.method === "GET" && url.pathname === "/api/resource") {
      const uri = url.searchParams.get("uri") ?? "";
      return send(res, 200, await client.readResource({ uri }));
    }
    if (req.method === "POST" && url.pathname === "/api/call") {
      const { name, arguments: args } = await readBody(req);
      return send(res, 200, await client.callTool({ name, arguments: args ?? {} }, undefined, { timeout: 120_000 }));
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`card host: http://127.0.0.1:${port}`);
});

const shutdown = async () => {
  server.close();
  await client.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
