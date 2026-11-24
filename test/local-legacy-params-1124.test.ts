import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

// npm 1.x → 2.x：本地版（stdio）保留 1.x 用户在用的老参数，托管版工具定义一字不变。
// API 地址在模块加载时就定了，所以先起假的 Atlas 接口、设好环境变量，再动态 import。

const CATALOG = [
  { uuid: "1", model: "deepseek-ai/deepseek-v3.2", type: "Text", displayName: "DeepSeek V3.2", tags: [] },
  {
    uuid: "2",
    model: "google/gemini-native-only",
    type: "Text",
    displayName: "Gemini Native",
    tags: [],
    supported_protocols: ["gemini.generate"],
    input_modalities: ["text", "image"],
    price: { actual: { input_price: "0.1", output_price: "0.4" } },
    maxCompletionTokens: 1000,
  },
  { uuid: "3", model: "suno/chirp-v5", type: "Audio", displayName: "Suno", tags: ["MUSIC"], categories: ["TEXT-TO-SPEECH"] },
  { uuid: "4", model: "minimax/speech-2.8", type: "Audio", displayName: "MiniMax Speech", tags: [], categories: ["TEXT-TO-SPEECH"] },
  { uuid: "5", model: "kwaivgi/kling-v4.0/text-to-video", type: "Video", displayName: "Kling 4.0", tags: [] },
];

interface Seen {
  method: string;
  url: string;
  body: string;
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test("local server keeps npm 1.x parameters; hosted tool definitions are unchanged", async (t) => {
  const seen: Seen[] = [];
  const fake = createServer(async (req, res) => {
    const body = await bodyOf(req);
    seen.push({ method: req.method ?? "", url: req.url ?? "", body });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url?.startsWith("/api/v1/models")) {
      res.end(JSON.stringify({ code: 200, data: CATALOG }));
    } else if (req.url?.startsWith("/api/v1/model/history")) {
      res.end(JSON.stringify({ code: 200, data: { total: 0, items: [] } }));
    } else if (req.method === "POST" && req.url?.includes(":generateContent")) {
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "native hello" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
        })
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((r) => fake.close(r)));
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[name];
  process.env.ATLASCLOUD_API_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.ATLASCLOUD_API_KEY = "test-key";

  const { createAtlasCloudServer } = await import("../src/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  async function connect(server: ReturnType<typeof createAtlasCloudServer>) {
    const client = new Client({ name: "legacy-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(() => client.close());
    return client;
  }

  const local = await connect(createAtlasCloudServer("stdio"));
  const remote = await connect(createAtlasCloudServer("remote"));
  const paramsOf = async (client: Awaited<ReturnType<typeof connect>>) =>
    Object.fromEntries(
      (await client.listTools()).tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {})])
    );
  const localParams = await paramsOf(local);
  const remoteParams = await paramsOf(remote);

  const legacy: Record<string, string[]> = {
    atlas_list_models: ["kind", "query"],
    atlas_list_predictions: ["prediction_id", "status", "limit"],
    atlas_quick_generate: ["video_url", "dry_run"],
    atlas_chat: ["extra_params"],
    atlas_upload_media: [],
    atlas_generate_image: ["dry_run"],
    atlas_generate_video: ["dry_run"],
    atlas_generate_audio: ["dry_run"],
    atlas_transcribe_audio: ["dry_run"],
  };
  for (const [tool, params] of Object.entries(legacy)) {
    for (const param of params) {
      assert.ok(localParams[tool]?.includes(param), `local ${tool} has ${param}`);
      if (remoteParams[tool]) assert.ok(!remoteParams[tool].includes(param), `remote ${tool} has no ${param}`);
    }
  }

  const required = async (client: Awaited<ReturnType<typeof connect>>, name: string) =>
    (await client.listTools()).tools.find((tool) => tool.name === name)?.inputSchema.required ?? [];
  assert.ok(!(await required(local, "atlas_chat")).includes("idempotency_key"), "local chat: key optional (1.x)");
  assert.ok((await required(remote, "atlas_chat")).includes("idempotency_key"), "hosted chat: key still required");
  assert.ok(!(await required(local, "atlas_upload_media")).includes("idempotency_key"), "local upload: key optional (1.x)");

  // list_models: query + kind 过滤（1.x 的 kind="music" 只要 Suno，不要 TTS）。
  const music = await local.callTool({ name: "atlas_list_models", arguments: { kind: "music" } });
  const musicIds = (music.structuredContent as { models: Array<{ model_id: string }> }).models.map((m) => m.model_id);
  assert.deepEqual(musicIds, ["suno/chirp-v5"]);
  const kling = await local.callTool({ name: "atlas_list_models", arguments: { query: "kling" } });
  assert.deepEqual(
    (kling.structuredContent as { models: Array<{ model_id: string }> }).models.map((m) => m.model_id),
    ["kwaivgi/kling-v4.0/text-to-video"]
  );

  // list_predictions: 老参数原样带给 /model/history（sessionID 就是任务 ID），limit 当 size。
  await local.callTool({
    name: "atlas_list_predictions",
    arguments: { prediction_id: "abc123def456", status: "failed", limit: 5 },
  });
  const history = new URL(seen.filter((s) => s.url.startsWith("/api/v1/model/history")).at(-1)!.url, "http://x");
  assert.equal(history.searchParams.get("sessionID"), "abc123def456");
  assert.equal(history.searchParams.get("status"), "failed");
  assert.equal(history.searchParams.get("size"), "5");

  // chat：只会说 gemini.generate 的模型，本地版走原生接口（报价 → 确认 → 提交）。
  const chatArgs = {
    model: "google/gemini-native-only",
    messages: [{ role: "user", content: "hello", images: ["https://cdn.example.test/a.png"] }],
    // npm 1.x 的 atlas_chat 没有 idempotency_key：报价和确认都不带，服务端按参数找回报价。
  };
  const quote = await local.callTool({ name: "atlas_chat", arguments: chatArgs });
  const quoted = quote.structuredContent as { status: string; confirmation_token: string };
  assert.equal(quoted.status, "confirmation_required", "attachments always stop for confirmation");
  const done = await local.callTool({
    name: "atlas_chat",
    arguments: { ...chatArgs, confirmed: true, confirmation_token: quoted.confirmation_token },
  });
  assert.equal(done.isError, undefined, JSON.stringify(done.content));
  const reply = done.structuredContent as { status: string; message: string; usage: { total_tokens: number } };
  assert.equal(reply.status, "completed");
  assert.equal(reply.message, "native hello");
  assert.equal(reply.usage.total_tokens, 5);
  const native = seen.find((s) => s.url.includes(":generateContent"));
  assert.ok(native, "called generateContent");
  assert.match(native.url, /\/v1\/models\/google\/gemini-native-only:generateContent/);
  const sent = JSON.parse(native.body) as { contents: Array<{ parts: unknown[] }> };
  assert.equal(sent.contents[0]?.parts.length, 2, "text + image part");
});

test("dry_run only ever quotes: confirmation is dropped and auto-submit is off", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { z } = await import("zod");
  const { installLegacyDryRun } = await import("../src/legacy-params.js");
  const { generationAutoSubmitThresholdUsd } = await import("../src/services/spend-policy.js");

  process.env.MCP_GENERATION_AUTOSUBMIT_MAX_USD = "5";
  const server = new McpServer({ name: "t", version: "0" });
  installLegacyDryRun(server);
  const received: Array<{ args: Record<string, unknown>; threshold: number }> = [];
  server.registerTool(
    "atlas_generate_image",
    { inputSchema: { model: z.string(), confirmed: z.boolean().optional(), confirmation_token: z.string().optional() } },
    async (args) => {
      received.push({ args, threshold: generationAutoSubmitThresholdUsd() });
      return { content: [{ type: "text" as const, text: "Confirmation required" }] };
    }
  );
  const client = new Client({ name: "c", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);

  const tools = await client.listTools();
  assert.ok(Object.keys(tools.tools[0]!.inputSchema.properties ?? {}).includes("dry_run"));

  const result = await client.callTool({
    name: "atlas_generate_image",
    arguments: { model: "m", dry_run: true, confirmed: true, confirmation_token: "x".repeat(40) },
  });
  assert.deepEqual(received[0]!.args, { model: "m" });
  assert.equal(received[0]!.threshold, 0);
  assert.match((result.content as Array<{ text: string }>)[0]!.text, /^Dry run:/);

  await client.callTool({ name: "atlas_generate_image", arguments: { model: "m" } });
  assert.equal(received[1]!.threshold, 5, "without dry_run the deployment's limit applies");
  delete process.env.MCP_GENERATION_AUTOSUBMIT_MAX_USD;
  await client.close();
});
