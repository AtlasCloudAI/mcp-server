// 2026-11-20：OpenAI 的自动检查拦下了 atlas_list_models、atlas_generate_image、atlas_generate_video、
// atlas_quick_generate 的新版本（"operations that are not individually exposed"），ChatGPT 副本停在没有卡片
// 模板的旧版本。对比已发布旧定义和被拦新定义，触发点是新加的工作流说明、默认路由链路和「发现 → 取参数 →
// 生成」的明说链路。开关 MCP_CHATGPT_LEAN_DESCRIPTIONS 打开后只给 ChatGPT 精简版，其他客户端一个字不变。
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
import { chatGptLeanDescriptionsEnabled } from "../src/services/chatgpt-lean.js";
import { isChatGptClient } from "../src/services/client-profile.js";

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
const LEAN_TOOLS = ["atlas_list_models", "atlas_generate_image", "atlas_generate_video", "atlas_quick_generate"];

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

// 被拦新版里新加、触发检查的说法。
const FLAGGED_PHRASES = [
  /Workflow/,
  /ready-made marketing workflows/i,
  /in this order/i,
  /chosen from the catalog/i,
  /gives exact model IDs for/i,
  /default route/i,
  /like any other model/i,
];

test("开关：默认关，0/false/no/off 也算关", () => {
  assert.equal(chatGptLeanDescriptionsEnabled({}), false);
  assert.equal(chatGptLeanDescriptionsEnabled({ MCP_CHATGPT_LEAN_DESCRIPTIONS: "" }), false);
  for (const off of ["0", "false", "no", "off", " OFF "]) {
    assert.equal(chatGptLeanDescriptionsEnabled({ MCP_CHATGPT_LEAN_DESCRIPTIONS: off }), false, off);
  }
  for (const on of ["1", "true", "on"]) {
    assert.equal(chatGptLeanDescriptionsEnabled({ MCP_CHATGPT_LEAN_DESCRIPTIONS: on }), true, on);
  }
});

test("ChatGPT 判定：OpenAI 域名的元数据客户端算（平台插件扫描也是），Codex 和其他不算", () => {
  assert.equal(isChatGptClient(CHATGPT), true);
  assert.equal(isChatGptClient("https://platform.openai.com/oauth/client.json"), true);
  assert.equal(isChatGptClient(CLIENTS.codex), false);
  assert.equal(isChatGptClient(CLIENTS.claude), false);
  assert.equal(isChatGptClient("dcr-cursor"), false);
  assert.equal(isChatGptClient(undefined), false);
});

test("ChatGPT 精简描述：只改 ChatGPT 的 4 个工具和一句服务器说明", async (t) => {
  const restore = withEnv({ MCP_UI_CARDS: "1", MCP_CHATGPT_LEAN_DESCRIPTIONS: undefined });
  const { baseUrl, server } = await startHarness();
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restore();
  });

  const off: Record<string, { tools: Tool[]; instructions: string }> = {};
  for (const [label, clientId] of Object.entries(CLIENTS)) off[label] = await surface(baseUrl, clientId);
  process.env.MCP_CHATGPT_LEAN_DESCRIPTIONS = "1";
  const on: Record<string, { tools: Tool[]; instructions: string }> = {};
  for (const [label, clientId] of Object.entries(CLIENTS)) on[label] = await surface(baseUrl, clientId);

  await t.test("开关关着：ChatGPT 还是完整版（含 Workflow 和默认路由）", () => {
    const tools = byName(off.chatgpt!.tools);
    assert.match(tools.get("atlas_list_models")!.description!, /type="Workflow"/);
    assert.deepEqual(tools.get("atlas_list_models")!.inputSchema.properties!.type!.enum, [
      "Text",
      "Image",
      "Video",
      "Audio",
      "Workflow",
    ]);
    assert.match(tools.get("atlas_generate_image")!.description!, /in this order/);
    assert.match(off.chatgpt!.instructions, /type "Workflow"/);
  });

  await t.test("其他客户端：开关开不开，工具列表和服务器说明逐字节一样", () => {
    for (const label of Object.keys(CLIENTS).filter((name) => name !== "chatgpt")) {
      assert.deepEqual(on[label]!.tools, off[label]!.tools, `${label} 的工具列表变了`);
      assert.equal(on[label]!.instructions, off[label]!.instructions, `${label} 的服务器说明变了`);
      assert.match(
        byName(on[label]!.tools).get("atlas_generate_image")!.description!,
        /in this order/,
        `${label} 应该还是完整版`
      );
    }
  });

  await t.test("ChatGPT：只有 4 个工具的描述 / 类型选项变了，其余工具一样", () => {
    const before = byName(off.chatgpt!.tools);
    const after = byName(on.chatgpt!.tools);
    assert.deepEqual([...after.keys()], [...before.keys()], "工具列表本身不变");
    for (const [name, tool] of after) {
      if (LEAN_TOOLS.includes(name)) {
        assert.notEqual(tool.description, before.get(name)!.description, `${name} 应该换成精简版`);
        // 标注、卡片模板、输出等都不动。
        assert.deepEqual(tool.annotations, before.get(name)!.annotations, `${name} 标注变了`);
        assert.deepEqual(tool._meta, before.get(name)!._meta, `${name} 元数据变了`);
      } else {
        assert.deepEqual(tool, before.get(name), `${name} 不该变`);
      }
    }
  });

  await t.test("ChatGPT：4 个工具里没有触发检查的说法", () => {
    const tools = byName(on.chatgpt!.tools);
    for (const name of LEAN_TOOLS) {
      const tool = tools.get(name)!;
      const text = JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema });
      for (const phrase of FLAGGED_PHRASES) assert.doesNotMatch(text, phrase, `${name}: ${phrase}`);
    }
  });

  await t.test("ChatGPT：list_models 回到审核过的旧版类型选项", () => {
    const type = byName(on.chatgpt!.tools).get("atlas_list_models")!.inputSchema.properties!.type!;
    assert.deepEqual(type.enum, ["Text", "Image", "Video", "Audio"]);
    assert.equal(type.description, "Filter by model type: Text, Image, Video, or Audio");
  });

  await t.test("ChatGPT：生成工具只点名一个默认模型的各个变体，卡片模板照挂", () => {
    const tools = byName(on.chatgpt!.tools);
    const image = tools.get("atlas_generate_image")!;
    assert.match(image.description!, /Default model: when the user has not named one, it is Seedream 5\.0 Pro/);
    assert.match(image.description!, /bytedance\/seedream-v5\.0-pro\/text-to-image/);
    assert.match(image.description!, /bytedance\/seedream-v5\.0-pro\/edit/);
    assert.doesNotMatch(image.description!, /gpt-image|nano-banana/, "不列备选模型");
    const video = tools.get("atlas_generate_video")!;
    for (const variant of ["text-to-video", "image-to-video", "reference-to-video"]) {
      assert.match(video.description!, new RegExp(`bytedance/seedance-2\\.5/${variant}`));
    }
    assert.doesNotMatch(video.description!, /kling|wan-3\.0|seedance-2\.0/, "不列备选模型");
    for (const name of ["atlas_generate_image", "atlas_generate_video", "atlas_quick_generate"]) {
      assert.match(String(cardTemplate(tools.get(name))), /^ui:\/\/atlascloud\/generation-card/, name);
    }
  });

  await t.test("ChatGPT：每个工具的三个标注都显式写了", () => {
    for (const tool of on.chatgpt!.tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
        assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name}.${hint}`);
      }
    }
  });

  await t.test("ChatGPT：服务器说明只少了 Workflow 那一句", () => {
    const sentence =
      'For marketing content such as product ads, UGC videos, try-on or e-commerce listing images, check atlas_list_models with type "Workflow" first: those ready-made workflows usually fit better than assembling base models. ';
    assert.ok(off.chatgpt!.instructions.includes(sentence));
    assert.equal(on.chatgpt!.instructions, off.chatgpt!.instructions.replace(sentence, ""));
  });
});

test("ChatGPT 精简版：list_models 不再接受 Workflow", async (t) => {
  const restore = withEnv({ MCP_UI_CARDS: "1", MCP_CHATGPT_LEAN_DESCRIPTIONS: "1" });
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
    const result = await client.callTool({ name: "atlas_list_models", arguments: { type: "Workflow" } }).catch(
      (error: unknown) => ({ isError: true, content: [{ type: "text", text: String(error) }] })
    );
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Workflow|Invalid|invalid/);
  } finally {
    await client.close();
  }
});
