import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { REMOTE_SCOPES, loadHttpServerConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { withoutCards } from "../src/http/openai-tool-metadata-transport.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";

// 11-19：认不出名字、initialize 时明确没声明 MCP Apps 的客户端（WorkBuddy、GrokBot）只给文字版。
// WorkBuddy 的 CodeBuddy 引擎 clientInfo 报的是用户给服务起的名字、capabilities 为空，却照工具上的
// _meta.ui.resourceUri 画卡片，宿主又把卡片的调用弹回、拦掉，按钮点不动。

// 令牌就是 client_id：dcr-* 是动态注册的客户端（认不出），chatgpt 是 ChatGPT 的元数据文档客户端。
class ClientIdVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return {
      token,
      clientId: token === "chatgpt" ? "https://chatgpt.com/oauth/client.json" : token,
      scopes: [...REMOTE_SCOPES],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      resource: new URL("http://127.0.0.1/mcp"),
      extra: { sub: "test-user" },
    };
  }
}

async function startHarness(): Promise<{ baseUrl: string; server: Server }> {
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
  });
  const app = createHttpApp(config, {
    verifier: new ClientIdVerifier(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    credentialResolver: {
      async resolve() {
        return { subject: "test-user", apiKey: "test-atlas-key" };
      },
    },
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const MCP_APPS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
const CARD_ONLY_TOOLS = ["atlas_open_upload_card", "atlas_cancel_quote", "atlas_card_status", "atlas_card_check_submission"];

async function listToolsAs(
  baseUrl: string,
  clientId: string,
  capabilities: Record<string, unknown>
): Promise<Array<{ name: string; _meta?: Record<string, unknown> }>> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${clientId}` } },
  });
  // 名字照 WorkBuddy 的样子写成服务名，证明认的是声明，不是名字。
  const client = new Client({ name: "atlas-cloud", version: "1.0.0" }, { capabilities });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
  } finally {
    await client.close();
  }
}

const cardTemplate = (tool: { _meta?: Record<string, unknown> } | undefined): unknown =>
  (tool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri ?? tool?._meta?.["ui/resourceUri"];

test("卡片打开时：没声明 MCP Apps 的动态注册客户端只给文字版，声明了的和 ChatGPT 照旧有卡片", async (t) => {
  const saved = process.env.MCP_UI_CARDS;
  process.env.MCP_UI_CARDS = "1";
  const { baseUrl, server } = await startHarness();
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (saved === undefined) delete process.env.MCP_UI_CARDS;
    else process.env.MCP_UI_CARDS = saved;
  });

  await t.test("WorkBuddy 式客户端（capabilities 为空）：工具上没有卡片模板，也没有卡片专用工具", async () => {
    const tools = await listToolsAs(baseUrl, "dcr-workbuddy", {});
    const names = tools.map((tool) => tool.name);
    for (const name of CARD_ONLY_TOOLS) assert.equal(names.includes(name), false, name);
    for (const tool of tools) {
      assert.equal(cardTemplate(tool), undefined, `${tool.name} 还挂着卡片模板`);
      assert.equal(tool._meta?.["openai/widgetAccessible"], undefined, tool.name);
    }
    // 生成工具和自传上传照旧在，权限声明照旧带。
    const image = tools.find((tool) => tool.name === "atlas_generate_image");
    assert.ok(image);
    assert.ok(image._meta?.securitySchemes);
    assert.ok(names.includes("atlas_get_upload_url"));
  });

  await t.test("同一个客户端之后不带 initialize 的请求（服务无状态）也记得它不显示卡片", async () => {
    // 用原始 JSON-RPC 发 tools/list，不先 initialize：走 Redis 里记下的声明。
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer dcr-workbuddy",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> } };
    assert.ok(body.result.tools.length > 0);
    for (const tool of body.result.tools) assert.equal(cardTemplate(tool), undefined, tool.name);
    assert.equal(body.result.tools.some((tool) => CARD_ONLY_TOOLS.includes(tool.name)), false);
  });

  await t.test("Cursor 式客户端（声明了 MCP Apps）：照旧有卡片", async () => {
    const tools = await listToolsAs(baseUrl, "dcr-cursor", MCP_APPS);
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("atlas_open_upload_card"));
    assert.ok(names.includes("atlas_cancel_quote"));
    assert.match(String(cardTemplate(tools.find((tool) => tool.name === "atlas_generate_image"))), /^ui:\/\/atlascloud\/generation-card/);
  });

  await t.test("没有声明记录的客户端（没 initialize 过）：照旧有卡片，不比以前差", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer dcr-never-initialized",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
    });
    const body = (await response.json()) as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> } };
    assert.match(String(cardTemplate(body.result.tools.find((tool) => tool.name === "atlas_generate_image"))), /^ui:\/\/atlascloud\/generation-card/);
  });

  await t.test("ChatGPT 按 OAuth 客户端认，不看声明：照旧有卡片", async () => {
    const tools = await listToolsAs(baseUrl, "chatgpt", {});
    assert.match(String(cardTemplate(tools.find((tool) => tool.name === "atlas_generate_image"))), /^ui:\/\/atlascloud\/generation-card/);
  });
});

test("withoutCards：只去掉卡片的键，别的元数据和结果内容原样保留", () => {
  const list = withoutCards({
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: [
        {
          name: "atlas_generate_image",
          _meta: { ui: { resourceUri: "ui://x" }, "ui/resourceUri": "ui://x", "openai/widgetAccessible": true, "openai/fileParams": ["files"] },
        },
        { name: "atlas_card_only", _meta: { ui: { resourceUri: "ui://x" } } },
        { name: "atlas_list_models" },
      ],
    },
  } as JSONRPCMessage) as unknown as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> } };
  assert.deepEqual(list.result.tools[0]._meta, { "openai/fileParams": ["files"] });
  assert.equal("_meta" in list.result.tools[1], false);
  assert.deepEqual(list.result.tools[2], { name: "atlas_list_models" });

  const call = withoutCards({
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{ type: "text", text: "Quote: $0.03" }],
      structuredContent: { status: "confirmation_required" },
      _meta: { "atlascloud/card": { state: "quote" }, "atlascloud/not_started": true, other: 1 },
    },
  } as JSONRPCMessage) as unknown as { result: Record<string, unknown> };
  assert.deepEqual(call.result._meta, { other: 1 });
  assert.deepEqual(call.result.structuredContent, { status: "confirmation_required" });
  assert.deepEqual(call.result.content, [{ type: "text", text: "Quote: $0.03" }]);

  const plain = { jsonrpc: "2.0", id: 3, result: { content: [] } } as JSONRPCMessage;
  assert.equal(withoutCards(plain), plain);
});
