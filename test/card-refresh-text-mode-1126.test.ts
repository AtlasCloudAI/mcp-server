// 2026-11-26 生产：同一用户的 Claude Code 桌面版（画卡片）和命令行版（不声明 MCP Apps）共用一个 OAuth 客户端。
// 命令行一 initialize，这个客户端就被记成文字版，桌面版聊天里的旧卡片调 atlas_card_check_submission /
// atlas_card_status 全报「工具不存在」，1.5 小时约 2700 次，埋点还记成 upstream_failure。
// 修法：文字版会话照样注册这两个只读的卡片刷新工具、能调，但不列进 tools/list；它们的结果不去掉卡片数据；
// 调到没注册的工具时埋点记 tool_not_found。
import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { REMOTE_SCOPES, loadHttpServerConfig } from "../src/config.js";
import { createHttpApp, isCardRefreshCall } from "../src/http.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { CARD_REFRESH_TOOLS, createAtlasCloudServer } from "../src/server.js";
import { ToolCallTelemetry } from "../src/services/tool-call-telemetry.js";

const DCR = "dcr-claude-code-client";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const CODEX = "https://chatgpt.com/oauth/codex/client.json";

async function withCards<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.MCP_UI_CARDS;
  process.env.MCP_UI_CARDS = "1";
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.MCP_UI_CARDS;
    else process.env.MCP_UI_CARDS = saved;
  }
}

async function connect(profile: "stdio" | "remote", client: { clientId?: string; noCards?: boolean }) {
  const server = createAtlasCloudServer(profile, client);
  const mcp = new Client({ name: "card-refresh-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  return { mcp, registered, close: () => mcp.close() };
}

const textModeClients: Array<[string, { clientId?: string; noCards?: boolean }]> = [
  ["认不出、明确没声明 MCP Apps（noCards）", { clientId: DCR, noCards: true }],
  ["Claude Code（按设计不画卡片）", { clientId: CLAUDE_CODE }],
  ["Codex（按设计不画卡片）", { clientId: CODEX }],
];

for (const [label, client] of textModeClients) {
  test(`文字版会话：卡片刷新工具能调但不列出来 —— ${label}`, async () => {
    await withCards(async () => {
      const { mcp, registered, close } = await connect("remote", client);
      try {
        const listed = (await mcp.listTools()).tools.map((tool) => tool.name);
        for (const name of CARD_REFRESH_TOOLS) {
          assert.ok(registered.includes(name), `${name} 要注册`);
          assert.equal(listed.includes(name), false, `${name} 不能列给模型`);
        }
        // 其他卡片专用工具照旧不给（模型会调的作废报价、上传卡）。
        for (const name of ["atlas_cancel_quote", "atlas_open_upload_card"]) {
          assert.equal(registered.includes(name), false, name);
        }
        // 列出来的就是注册的去掉这两个：别的工具一个不少、一个不多。
        assert.deepEqual(listed.sort(), registered.filter((name) => !CARD_REFRESH_TOOLS.includes(name)).sort());

        // 旧卡片调过来不再是「工具不存在」（参数不全时是参数校验错，说明工具接住了）。
        for (const name of CARD_REFRESH_TOOLS) {
          const result = (await mcp.callTool({ name, arguments: {} })) as { isError?: boolean; content: Array<{ text?: string }> };
          const text = result.content.map((c) => c.text ?? "").join(" ");
          assert.doesNotMatch(text, /not found/i, `${name}: ${text}`);
        }
      } finally {
        await close();
      }
    });
  });
}

test("会画卡片的客户端和本地版：卡片工具照旧注册并列出", async () => {
  await withCards(async () => {
    for (const [profile, client] of [
      ["remote", { clientId: DCR }],
      ["stdio", {}],
    ] as const) {
      const { mcp, close } = await connect(profile, client);
      try {
        const listed = (await mcp.listTools()).tools.map((tool) => tool.name);
        for (const name of [...CARD_REFRESH_TOOLS, "atlas_cancel_quote"]) assert.ok(listed.includes(name), `${profile} ${name}`);
      } finally {
        await close();
      }
    }
  });
});

test("卡片关着（MCP_UI_CARDS 没开）：文字版会话不注册卡片工具", async () => {
  const saved = process.env.MCP_UI_CARDS;
  delete process.env.MCP_UI_CARDS;
  try {
    const { registered, close } = await connect("remote", { clientId: DCR, noCards: true });
    await close();
    for (const name of CARD_REFRESH_TOOLS) assert.equal(registered.includes(name), false, name);
  } finally {
    if (saved !== undefined) process.env.MCP_UI_CARDS = saved;
  }
});

test("认得出卡片刷新调用：只认单条 tools/call 且是这两个工具", () => {
  assert.equal(isCardRefreshCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_card_status" } }), true);
  assert.equal(isCardRefreshCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_card_check_submission" } }), true);
  assert.equal(isCardRefreshCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_generate_image" } }), false);
  assert.equal(isCardRefreshCall({ jsonrpc: "2.0", id: 1, method: "tools/list" }), false);
  assert.equal(isCardRefreshCall([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_card_status" } }]), false);
  assert.equal(isCardRefreshCall(undefined), false);
});

test("调到没注册的工具：埋点记 tool_not_found，不再算成 upstream_failure", () => {
  const missing = new ToolCallTelemetry("atlas_text_to_video", 0);
  missing.observeResponse({
    jsonrpc: "2.0",
    id: 1,
    result: { isError: true, content: [{ type: "text", text: "MCP error -32602: Tool atlas_text_to_video not found" }] },
  });
  assert.equal(missing.properties({}, 200, { now: 1 }).error_code, "tool_not_found");

  const other = new ToolCallTelemetry("atlas_generate_image", 0);
  other.observeResponse({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "upstream said no" }] } });
  assert.equal(other.properties({}, 200, { now: 1 }).error_code, "upstream_failure");

  // 提示里顺带提到「not found」的普通报错不算。
  const prediction = new ToolCallTelemetry("atlas_get_prediction", 0);
  prediction.observeResponse({
    jsonrpc: "2.0",
    id: 1,
    result: { isError: true, content: [{ type: "text", text: "Tool atlas_get_prediction not found the task, try again later." }] },
  });
  assert.equal(prediction.properties({}, 200, { now: 1 }).error_code, "upstream_failure");
});

// HTTP 全链路：按设计不画卡片的 Claude Code 客户端（令牌即 client_id），旧卡片发来的核实调用要接住。
class ClientIdVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return {
      token,
      clientId: token,
      scopes: [...REMOTE_SCOPES],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      resource: new URL("http://127.0.0.1/mcp"),
      extra: { sub: "test-user" },
    };
  }
}

test("HTTP：文字版客户端的旧卡片调 atlas_card_check_submission 能接住，工具列表里看不到", async () => {
  await withCards(async () => {
    const config = loadHttpServerConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "3000",
      MCP_PUBLIC_URL: "http://127.0.0.1/mcp",
      MCP_OAUTH_ISSUER: "http://issuer.test",
      MCP_OAUTH_JWKS_URI: "http://issuer.test/jwks",
      MCP_OAUTH_ALGORITHMS: "RS256",
      MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
      MCP_ALLOWED_ORIGINS: "https://claude.ai",
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
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${CLAUDE_CODE}` } },
    });
    const client = new Client({ name: "claude-code", version: "2.1.332" });
    try {
      await client.connect(transport);
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of CARD_REFRESH_TOOLS) assert.equal(listed.includes(name), false, name);
      const result = (await client.callTool({
        name: "atlas_card_check_submission",
        arguments: { tool: "atlas_generate_image", idempotency_key: randomUUID(), on_load: true },
      })) as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: { outcome?: string } };
      const text = result.content.map((c) => c.text ?? "").join(" ");
      assert.doesNotMatch(text, /not found/i, text);
      assert.notEqual(result.isError, true, text);
      assert.equal(typeof result.structuredContent?.outcome, "string");
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
