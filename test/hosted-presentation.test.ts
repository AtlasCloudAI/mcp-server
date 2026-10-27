// 托管模式端到端：真实的 MCP HTTP 服务端 + 假的 Atlas 接口，按客户端身份核对
// atlas_get_prediction / atlas_get_upload_url 给模型的说明。
//
// Atlas 接口地址在模块加载时就定下来了，所以先起假接口、设环境变量，再动态 import 服务端。
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const CLIENTS: Record<string, string> = {
  codex: "https://chatgpt.com/oauth/codex/client.json",
  chatgpt: "https://chatgpt.com/oauth/client.json",
  claude: "https://claude.ai/oauth/mcp-oauth-client-metadata",
};

let apiOrigin = "";
const pollCounts = new Map<string, number>();

function predictionFor(id: string): Record<string, unknown> {
  const n = (pollCounts.get(id) ?? 0) + 1;
  pollCounts.set(id, n);
  const now = new Date().toISOString();
  const owned = `${apiOrigin}/media/${id}.mp4`;
  switch (id) {
    case "done":
      return { status: "completed", outputs: [owned], created_at: now, completed_at: now };
    case "upstream":
      // 先是火山上游链接，第二次查询才换成自家存储。
      return n === 1
        ? {
            status: "completed",
            outputs: ["https://ark-x.tos-ap-southeast-1.volces.com/out.mp4?X-Tos-Expires=86400"],
            created_at: now,
            completed_at: now,
          }
        : { status: "completed", outputs: [owned], created_at: now, completed_at: now };
    case "canceled":
      return { status: "canceled", outputs: [], created_at: now };
    case "running":
      return {
        status: "processing",
        outputs: [],
        created_at: new Date(Date.now() - 90_000).toISOString(),
      };
    default:
      return { status: "failed", outputs: [], error: "unknown id" };
  }
}

async function startFakeAtlas(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = url.pathname.match(/^\/api\/v1\/model\/prediction\/([^/]+)$/);
    if (req.method === "GET" && match) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 200, data: { id: match[1], ...predictionFor(match[1]!) } }));
      return;
    }
    if ((req.method === "HEAD" || req.method === "GET") && url.pathname.startsWith("/media/")) {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": "12345" });
      res.end(req.method === "HEAD" ? undefined : Buffer.alloc(12345));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

class StubVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return {
      token,
      clientId: CLIENTS[token] ?? CLIENTS.chatgpt!,
      scopes: ["tasks:read", "tasks:write", "billing:read"],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      resource: new URL("http://127.0.0.1/mcp"),
      extra: { sub: "test-user" },
    };
  }
}

test("托管模式：按客户端给出不同的展示说明", async (t) => {
  const fake = await startFakeAtlas();
  apiOrigin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.ATLASCLOUD_API_BASE_URL = apiOrigin;
  process.env.ATLASCLOUD_GENERATION_API_BASE_URL = apiOrigin;
  process.env.MCP_OWNED_MEDIA_HOSTS = "127.0.0.1";
  process.env.MCP_PREDICTION_WAIT_SECONDS = "0";

  const { loadHttpServerConfig } = await import("../src/config.js");
  const { createHttpApp } = await import("../src/http.js");
  const { InMemoryIdempotencyStore } = await import("../src/services/idempotency.js");
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
    OPENAI_APPS_CHALLENGE_TOKEN: "exact-challenge-token",
  });
  const app = createHttpApp(config, {
    verifier: new StubVerifier(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    credentialResolver: {
      async resolve() {
        return { subject: "test-user", apiKey: "test-atlas-key" };
      },
    },
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => fake.close(r));
  });

  async function call(token: string, name: string, args: Record<string, unknown>) {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, Origin: "https://chatgpt.com" } },
    });
    const client = new Client({ name: "hosted-presentation-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return { text, structured: result.structuredContent as Record<string, unknown>, isError: result.isError };
    } finally {
      await client.close();
    }
  }

  await t.test("Codex：图片语法 + 等下载结束 + 完整文件大小", async () => {
    const r = await call("codex", "atlas_get_prediction", { prediction_id: "done" });
    assert.equal(r.isError, undefined);
    assert.equal(r.structured.status, "completed");
    assert.match(r.text, /!\[<short title>\]\(\/absolute\/path\/<descriptive-name>\.mp4\)/);
    assert.match(r.text, /keep waiting on the same process/);
    assert.match(r.text, /12345 bytes/);
  });

  await t.test("ChatGPT 和 Claude 网页：不跑脚本下载，直接给链接", async () => {
    for (const token of ["chatgpt", "claude"]) {
      const r = await call(token, "atlas_get_prediction", { prediction_id: "done" });
      assert.match(r.text, /Do not run code to download/, token);
      assert.doesNotMatch(r.text, /curl -L/, token);
    }
  });

  await t.test("上游链接先扣住，转存后再交出", async () => {
    pollCounts.delete("upstream");
    const first = await call("codex", "atlas_get_prediction", { prediction_id: "upstream" });
    assert.equal(first.structured.transfer_pending, true);
    assert.match(first.text, /still being copied to Atlas storage/);
    assert.doesNotMatch(first.text, /!\[<short title>\]/);
    const second = await call("codex", "atlas_get_prediction", { prediction_id: "upstream" });
    assert.equal(second.structured.transfer_pending, undefined);
    assert.match(String((second.structured.outputs as string[])[0]), /\/media\/upstream\.mp4$/);
  });

  await t.test("已取消的任务不会被要求一直查", async () => {
    const r = await call("codex", "atlas_get_prediction", { prediction_id: "canceled" });
    assert.match(r.text, /is not a running state/);
    assert.doesNotMatch(r.text, /keep polling/);
  });

  await t.test("处理中：告诉模型已运行多久，并要求同一回合继续查", async () => {
    const r = await call("codex", "atlas_get_prediction", { prediction_id: "running" });
    assert.match(r.text, /submitted 1\.5 min ago/);
    assert.match(r.text, /keep polling in this turn/);
    assert.match(r.text, /replying "continue"/);
  });

  await t.test("上传：命令兼容旧版 curl；ChatGPT 没网时请用户给公开链接", async () => {
    const codex = await call("codex", "atlas_get_upload_url", { filename_hint: "ref.png" });
    // 短上传地址：模型抄得准。
    assert.match(String(codex.structured.upload_url), /\/upload\/t_[A-Za-z0-9_-]{22}$/);
    assert.doesNotMatch(String(codex.structured.curl_example), /--fail-with-body/);
    assert.match(String(codex.structured.curl_example), /-w "\\nHTTP %\{http_code\}\\n"/);
    assert.match(codex.text, /escalated permissions/);
    const chat = await call("chatgpt", "atlas_get_upload_url", { filename_hint: "ref.png" });
    assert.match(chat.text, /ask the user for a public link/);
  });
  await t.test("生成工具的描述讲清本地文件先上传，且不写给模型的流程指令", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer codex", Origin: "https://chatgpt.com" } },
    });
    const client = new Client({ name: "hosted-presentation-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      for (const name of [
        "atlas_generate_image",
        "atlas_generate_video",
        "atlas_generate_audio",
        "atlas_transcribe_audio",
        "atlas_quick_generate",
      ]) {
        const tool = tools.find((x) => x.name === name);
        assert.ok(tool, name);
        assert.match(String(tool.description), /atlas_get_upload_url/, name);
        assert.match(String(tool.description), /no API key is involved/, name);
        // ChatGPT 把描述里的流程指令判成「存在可疑指令」（2026-10-23 报价、提交两步都被标）。
        // 流程留在服务端总说明和报价结果里，描述只陈述事实。
        assert.doesNotMatch(String(tool.description), /Show the user|and stop|Only after a new user message|do not ask the user/i, name);
        assert.match(String(tool.description), /only prices the request/, name);
        // 转写工具里曾残留"没有本地上传工具、请用户自己找地方传"，模型照做了（2026-10-20 test）。
        assert.doesNotMatch(String(tool.description), /does not expose a local-file upload tool/, name);
      }
    } finally {
      await client.close();
    }
  });
});
