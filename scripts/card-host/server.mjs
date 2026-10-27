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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
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
