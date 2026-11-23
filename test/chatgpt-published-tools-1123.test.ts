// 2026-11-23：精简描述（MCP_CHATGPT_LEAN_DESCRIPTIONS=1）要是还被 OpenAI 拦，退一步用 published：
// atlas_generate_image / video / quick_generate 换成 ChatGPT 已发布的原文（services/chatgpt-published-tools.ts），
// 只多挂卡片模板。同一天通过的 atlas_generate_audio 和它的已发布原文的唯一区别就是卡片模板。
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { REMOTE_SCOPES, loadHttpServerConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { chatGptLeanDescriptionsEnabled, chatGptPublishedToolsEnabled } from "../src/services/chatgpt-lean.js";
import { CHATGPT_PUBLISHED_TOOLS } from "../src/services/chatgpt-published-tools.js";

const CHATGPT = "https://chatgpt.com/oauth/client.json";
const CLIENTS = {
  chatgpt: CHATGPT,
  claude: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  codex: "https://chatgpt.com/oauth/codex/client.json",
  "claude-code": "https://claude.ai/oauth/claude-code-client-metadata",
  cursor: "dcr-cursor",
  workbuddy: "dcr-workbuddy",
} as const;
const MCP_APPS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
const PUBLISHED = ["atlas_generate_image", "atlas_generate_video", "atlas_quick_generate"];

// 令牌就是 client_id。
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

type Tool = {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, { enum?: string[]; description?: string }> };
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

async function surface(baseUrl: string, clientId: string): Promise<{ tools: Tool[]; instructions: string }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${clientId}` } },
  });
  const client = new Client({ name: "atlas-cloud", version: "1.0.0" }, { capabilities: MCP_APPS });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools as Tool[];
    return { tools, instructions: client.getInstructions() ?? "" };
  } finally {
    await client.close();
  }
}

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

const byName = (tools: Tool[]) => new Map(tools.map((tool) => [tool.name, tool]));
const cardTemplate = (tool: Tool | undefined): unknown =>
  (tool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri;

test("开关：只有 published 走已发布原文，它同时也算精简版开着", () => {
  for (const value of [undefined, "", "0", "off", "1", "true", "lean"]) {
    assert.equal(chatGptPublishedToolsEnabled({ MCP_CHATGPT_LEAN_DESCRIPTIONS: value }), false, String(value));
  }
  for (const value of ["published", " Published "]) {
    assert.equal(chatGptPublishedToolsEnabled({ MCP_CHATGPT_LEAN_DESCRIPTIONS: value }), true, value);
    assert.equal(chatGptLeanDescriptionsEnabled({ MCP_CHATGPT_LEAN_DESCRIPTIONS: value }), true, value);
  }
});

test("ChatGPT 已发布原文：只换 ChatGPT 三个生成工具的描述和参数结构，卡片模板照挂", async (t) => {
  const restore = withEnv({ MCP_UI_CARDS: "1", MCP_CHATGPT_LEAN_DESCRIPTIONS: "1" });
  const { baseUrl, server } = await startHarness();
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restore();
  });

  const lean: Record<string, { tools: Tool[]; instructions: string }> = {};
  for (const [label, clientId] of Object.entries(CLIENTS)) lean[label] = await surface(baseUrl, clientId);
  process.env.MCP_CHATGPT_LEAN_DESCRIPTIONS = "published";
  const published: Record<string, { tools: Tool[]; instructions: string }> = {};
  for (const [label, clientId] of Object.entries(CLIENTS)) published[label] = await surface(baseUrl, clientId);
  delete process.env.MCP_CHATGPT_LEAN_DESCRIPTIONS;
  const full: Record<string, { tools: Tool[]; instructions: string }> = {};
  for (const [label, clientId] of Object.entries(CLIENTS)) full[label] = await surface(baseUrl, clientId);

  await t.test("其他客户端：和开关关着逐字节一样", () => {
    for (const label of Object.keys(CLIENTS).filter((name) => name !== "chatgpt")) {
      assert.deepEqual(published[label]!.tools, full[label]!.tools, `${label} 的工具列表变了`);
      assert.equal(published[label]!.instructions, full[label]!.instructions, `${label} 的服务器说明变了`);
    }
  });

  await t.test("ChatGPT：三个工具的描述和参数结构逐字等于已发布原文", () => {
    const tools = byName(published.chatgpt!.tools);
    for (const name of PUBLISHED) {
      const tool = tools.get(name)!;
      assert.equal(tool.description, CHATGPT_PUBLISHED_TOOLS[name]!.description, `${name} 描述`);
      assert.deepEqual(tool.inputSchema, CHATGPT_PUBLISHED_TOOLS[name]!.inputSchema, `${name} 参数结构`);
    }
  });

  await t.test("ChatGPT：标注、卡片模板和其他工具都和精简版一样，服务器说明也一样", () => {
    const before = byName(lean.chatgpt!.tools);
    const after = byName(published.chatgpt!.tools);
    assert.deepEqual([...after.keys()], [...before.keys()], "工具列表本身不变");
    for (const [name, tool] of after) {
      if (PUBLISHED.includes(name)) {
        const { description: _d1, inputSchema: _s1, ...rest } = tool;
        const { description: _d2, inputSchema: _s2, ...restBefore } = before.get(name)!;
        assert.deepEqual(rest, restBefore, `${name} 除描述和参数结构外不该变`);
        assert.match(String(cardTemplate(tool)), /^ui:\/\/atlascloud\/generation-card/, `${name} 卡片模板`);
      } else {
        assert.deepEqual(tool, before.get(name), `${name} 不该变`);
      }
    }
    assert.equal(published.chatgpt!.instructions, lean.chatgpt!.instructions);
  });
});

test("ChatGPT 已发布原文：按已发布参数结构调用，服务端校验照常通过", async (t) => {
  const restore = withEnv({ MCP_UI_CARDS: "1", MCP_CHATGPT_LEAN_DESCRIPTIONS: "published" });
  // 本地测试服务照常走真 fetch；发往 Atlas 的请求一律断网，只看参数校验这一关。
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    throw new TypeError("fetch failed (offline in test)");
  });
  const { baseUrl, server } = await startHarness();
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restore();
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${CHATGPT}` } },
  });
  const client = new Client({ name: "atlas-cloud", version: "1.0.0" }, { capabilities: MCP_APPS });
  await client.connect(transport);
  try {
    const calls = [
      {
        name: "atlas_generate_image",
        arguments: { idempotency_key: "5d0c9a52-1f7e-4c1b-9a51-0d7f3c2a8e11", model: "bytedance/seedream-v5.0-pro/text-to-image", params: { prompt: "a cat" } },
      },
      {
        name: "atlas_generate_video",
        arguments: { idempotency_key: "5d0c9a52-1f7e-4c1b-9a51-0d7f3c2a8e12", model: "bytedance/seedance-2.5/text-to-video", params: { prompt: "a cat" } },
      },
      {
        name: "atlas_quick_generate",
        arguments: { idempotency_key: "5d0c9a52-1f7e-4c1b-9a51-0d7f3c2a8e13", model_keyword: "seedream", type: "Image", prompt: "a cat" },
      },
    ];
    for (const call of calls) {
      const result = await client
        .callTool(call)
        .catch((error: unknown) => ({ isError: true, content: [{ type: "text", text: String(error) }] }));
      assert.doesNotMatch(JSON.stringify(result.content), /Input validation error|Invalid arguments/, call.name);
    }
  } finally {
    await client.close();
  }
});
