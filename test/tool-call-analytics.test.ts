import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import test from "node:test";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { analyticsEnvironment, loadHttpServerConfig, REMOTE_SCOPES } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import {
  ClientPlatformMemory,
  createPostHogSink,
  trackToolCalls,
  userDistinctId,
  type AnalyticsEvent,
  type AnalyticsSink,
} from "../src/http/tool-call-analytics.js";
import { clientPlatform } from "../src/services/client-profile.js";
import { GenerationConfirmationError } from "../src/services/generation-confirmation.js";
import { IdempotencyUncertainError, InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { ApiRequestError } from "../src/services/api-client.js";
import {
  normalizeGenerationStatus,
  sanitizeModel,
  ToolCallTelemetry,
} from "../src/services/tool-call-telemetry.js";
import { classifyToolError } from "../src/utils/error-handler.js";
import { SERVER_VERSION } from "../src/version.js";

const BASE_ENV: NodeJS.ProcessEnv = {
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
};

// ---- 字段组装 ----

test("a successful call carries the CLI fields and no error fields", () => {
  const call = new ToolCallTelemetry("atlas_generate_image", 1000);
  call.annotate({ model: "bytedance/seedream-v4", execution_mode: "submit" });
  call.annotate({ generation_status: "processing" });
  // 半路记下的错误不该跟着成功的调用出去
  call.recordError({ code: "network_error" });
  call.observeResponse({ jsonrpc: "2.0", id: 1, result: { content: [] } });

  const props = call.properties(
    { product: "atlas-mcp", environment: "production", version: "9.9.9", client_platform: "codex" },
    200,
    { now: 1234.4 }
  );
  assert.deepEqual(props, {
    product: "atlas-mcp",
    environment: "production",
    version: "9.9.9",
    client_platform: "codex",
    command: "atlas_generate_image",
    duration_ms: 234,
    is_error: false,
    model: "bytedance/seedream-v4",
    execution_mode: "submit",
    generation_status: "processing",
  });
});

test("a tool error reports the first recorded code with CLI category and retryable", () => {
  const call = new ToolCallTelemetry("atlas_generate_video", 0);
  call.annotate({ execution_mode: "quote" });
  call.recordError({ code: "model_schema_unavailable" });
  call.recordError({ code: "upstream_failure" });
  call.observeResponse({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } });

  const props = call.properties({}, 200, { now: 5 });
  assert.equal(props.is_error, true);
  assert.equal(props.error_code, "model_schema_unavailable");
  assert.equal(props.error_category, "model");
  assert.equal(props.retryable, true);
  assert.equal(props.execution_mode, "quote");
  assert.equal("http_status" in props, false);
});

test("unrecorded tool errors fall back to the SDK validation text or upstream_failure", () => {
  const validation = new ToolCallTelemetry("atlas_chat", 0);
  validation.observeResponse({
    jsonrpc: "2.0",
    id: 1,
    result: {
      isError: true,
      content: [{ type: "text", text: "Input validation error: Invalid arguments for tool atlas_chat" }],
    },
  });
  assert.equal(validation.properties({}, 200).error_code, "invalid_param");

  const rpcError = new ToolCallTelemetry("atlas_chat", 0);
  rpcError.observeResponse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } });
  assert.equal(rpcError.properties({}, 200).error_code, "invalid_param");

  const opaque = new ToolCallTelemetry("atlas_chat", 0);
  opaque.observeResponse({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } });
  const props = opaque.properties({}, 200);
  assert.equal(props.error_code, "upstream_failure");
  assert.equal(props.error_category, "internal");
  assert.equal(props.retryable, false);
});

test("HTTP rejections and disconnects are classified without the tool running", () => {
  const limited = new ToolCallTelemetry("atlas_get_prediction", 0).properties({}, 429);
  assert.equal(limited.error_code, "rate_limited");
  assert.equal(limited.retryable, true);
  assert.equal(limited.http_status, 429);

  const unlinked = new ToolCallTelemetry("atlas_get_balance", 0).properties({}, 401);
  assert.equal(unlinked.error_code, "auth_required");
  assert.equal(unlinked.error_category, "auth");

  const gone = new ToolCallTelemetry("atlas_get_prediction", 0).properties({}, 200, {
    disconnected: true,
  });
  assert.equal(gone.is_error, true);
  assert.equal(gone.error_code, "client_disconnected");
  assert.equal(gone.error_category, "network");
});

test("generation status follows the CLI value set; models must look like catalog IDs", () => {
  assert.equal(normalizeGenerationStatus("succeeded"), "completed");
  assert.equal(normalizeGenerationStatus("COMPLETED"), "completed");
  assert.equal(normalizeGenerationStatus("failed"), "failed");
  assert.equal(normalizeGenerationStatus("queued"), "queued");
  assert.equal(normalizeGenerationStatus("starting"), "processing");
  assert.equal(normalizeGenerationStatus("canceled"), "unknown");
  assert.equal(normalizeGenerationStatus(""), undefined);
  assert.equal(normalizeGenerationStatus(null), undefined);

  assert.equal(sanitizeModel("google/nano-banana-2/edit"), "google/nano-banana-2/edit");
  assert.equal(sanitizeModel("a cat on the moon"), undefined);
  assert.equal(sanitizeModel("https://example.com/x.png"), undefined);
  assert.equal(sanitizeModel(42), undefined);
});

test("tool exceptions map to the CLI error codes", () => {
  assert.deepEqual(classifyToolError(new ApiRequestError("Too many", 429)), {
    code: "rate_limited",
    httpStatus: 429,
  });
  assert.deepEqual(classifyToolError(new ApiRequestError("Insufficient balance", 400)), {
    code: "quota_exceeded",
    httpStatus: 400,
  });
  assert.deepEqual(classifyToolError(new ApiRequestError("expired", 401)), {
    code: "auth_required",
    httpStatus: 401,
  });
  assert.deepEqual(classifyToolError(new ApiRequestError("boom", 502)), {
    code: "upstream_failure",
    httpStatus: 502,
  });
  assert.deepEqual(
    classifyToolError(new ApiRequestError("No Atlas Cloud credential is available for this authenticated request")),
    { code: "auth_required" }
  );
  assert.deepEqual(classifyToolError(new GenerationConfirmationError("expired")), {
    code: "confirmation_required",
  });
  assert.deepEqual(classifyToolError(new IdempotencyUncertainError()), {
    code: "submission_unknown",
  });
  const aborted = new Error("aborted");
  aborted.name = "AbortError";
  assert.deepEqual(classifyToolError(aborted), { code: "network_error", cause: "deadline_exceeded" });
  assert.deepEqual(classifyToolError(new Error("weird")), { code: "upstream_failure" });
});

// ---- 平台归一 ----

test("client_platform: metadata documents by URL, registered clients by name prefix", () => {
  const cases: Array<[string | undefined, string | undefined, string]> = [
    ["https://chatgpt.com/oauth/client.json", undefined, "chatgpt"],
    ["https://chatgpt.com/oauth/codex/client.json", undefined, "codex"],
    ["https://claude.ai/oauth/mcp-oauth-client-metadata", undefined, "claude"],
    ["https://claude.ai/oauth/claude-code-client-metadata", undefined, "claude"],
    // URL 认得出时以 URL 为准，名字不改判
    ["https://chatgpt.com/oauth/client.json", "Cursor", "chatgpt"],
    ["7f3c0e", "WorkBuddy", "workbuddy"],
    ["7f3c0e", "WorkBuddy Connector (custom-mcp:atlas-cloud)", "workbuddy"],
    ["7f3c0e", "Hermes Agent", "hermes"],
    ["7f3c0e", "OpenClaw MCP", "openclaw"],
    ["7f3c0e", "Cursor", "cursor"],
    ["7f3c0e", "cursor-vscode", "cursor"],
    ["7f3c0e", "GrokBot", "grok"],
    ["7f3c0e", "codex-mcp-client", "codex"],
    ["7f3c0e", "openai-mcp", "chatgpt"],
    ["7f3c0e", "Cursor/1.7.44 (darwin arm64)", "cursor"],
    ["7f3c0e", "node", "unknown"],
    ["7f3c0e", "My Claude bridge", "unknown"],
    ["https://unknown.example/client.json", undefined, "unknown"],
    [undefined, undefined, "unknown"],
  ];
  for (const [clientId, name, expected] of cases) {
    assert.equal(clientPlatform(clientId, name), expected, `${clientId} / ${name}`);
  }
});

test("platform memory is bounded and keeps the most recent clients", () => {
  const memory = new ClientPlatformMemory(2);
  memory.remember("a", "cursor");
  memory.remember("b", "hermes");
  memory.remember("a", "cursor");
  memory.remember("c", "openclaw");
  assert.equal(memory.recall("b"), undefined);
  assert.equal(memory.recall("a"), "cursor");
  assert.equal(memory.recall("c"), "openclaw");
  assert.equal(memory.recall(undefined), undefined);
});

test("distinct_id is uid-<numeric sub>, the kubedl/aiproxy form; other subjects send nothing", () => {
  assert.equal(userDistinctId("12345"), "uid-12345");
  assert.equal(userDistinctId("test-user"), undefined);
  assert.equal(userDistinctId("user@example.com"), undefined);
  assert.equal(userDistinctId(""), undefined);
  assert.equal(userDistinctId(12345), undefined);
});

// ---- 配置：不配 key 就不发 ----

test("without POSTHOG_KEY analytics is off end to end", async () => {
  for (const key of [undefined, "", "   "]) {
    const config = loadHttpServerConfig({ ...BASE_ENV, ...(key === undefined ? {} : { POSTHOG_KEY: key }) });
    assert.equal(config.analytics, undefined);
    assert.equal(await createPostHogSink(config.analytics), undefined);
  }

  // 就算有人传了发送器，配置里没有 key 也是直通：不建统计对象、不发事件。
  const captured: AnalyticsEvent[] = [];
  const sink: AnalyticsSink = { capture: (e) => captured.push(e), shutdown: async () => {} };
  const middleware = trackToolCalls(loadHttpServerConfig(BASE_ENV), sink);
  const locals: Record<string, unknown> = {};
  let nextCalled = false;
  middleware(
    {
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "atlas_list_models" } },
      auth: { extra: { sub: "42" } },
    } as never,
    { locals } as never,
    () => {
      nextCalled = true;
    }
  );
  assert.equal(nextCalled, true);
  assert.deepEqual(locals, {});
  assert.equal(captured.length, 0);
});

test("POSTHOG_KEY turns analytics on; environment follows the deployment", () => {
  const config = loadHttpServerConfig({ ...BASE_ENV, POSTHOG_KEY: " phc_test " });
  assert.deepEqual(config.analytics, {
    key: "phc_test",
    host: "https://us.i.posthog.com",
    environment: "dev",
  });
  const custom = loadHttpServerConfig({
    ...BASE_ENV,
    POSTHOG_KEY: "phc_test",
    POSTHOG_HOST: "https://eu.i.posthog.com/",
    MCP_ANALYTICS_ENVIRONMENT: "test",
  });
  assert.equal(custom.analytics?.host, "https://eu.i.posthog.com");
  assert.equal(custom.analytics?.environment, "test");

  assert.equal(analyticsEnvironment("production", new URL("https://mcp.atlascloud.ai/mcp")), "production");
  assert.equal(analyticsEnvironment("staging", new URL("https://mcp.test.atlascloud.ai/mcp")), "test");
  assert.equal(analyticsEnvironment("staging", new URL("https://atlascloud-mcp.dev.atlascloud.ai/mcp")), "dev");
  assert.equal(analyticsEnvironment("staging", new URL("https://mcp.atlascloud.ai/mcp"), "production"), "production");
});

test("a configured key loads the PostHog SDK lazily and shuts down cleanly", async () => {
  // 什么都没入队，shutdown 不会发请求；这里只验证动态加载与关闭这条路走得通。
  const sink = await createPostHogSink({
    key: "phc_test",
    host: "http://127.0.0.1:9",
    environment: "dev",
  });
  assert.ok(sink);
  await sink.shutdown();
});

// ---- 真实 HTTP 链路 ----

// 令牌写成「客户端:sub[:ro]」：客户端 chatgpt 是元数据文档客户端，dcr 是动态注册的；ro 只有只读 scope。
class TokenVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const [client, sub, mode] = token.split(":");
    return {
      token,
      clientId: client === "dcr" ? "dcr-7f3c0e" : "https://chatgpt.com/oauth/client.json",
      scopes: mode === "ro" ? ["tasks:read"] : [...REMOTE_SCOPES],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      resource: new URL("http://127.0.0.1/mcp"),
      extra: { sub },
    };
  }
}

async function startHarness(sink: AnalyticsSink): Promise<{ baseUrl: string; server: Server }> {
  const config = loadHttpServerConfig({ ...BASE_ENV, POSTHOG_KEY: "phc_test" });
  const app = createHttpApp(config, {
    verifier: new TokenVerifier(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    credentialResolver: {
      async resolve(auth) {
        return { subject: String(auth.extra?.sub), apiKey: "test-atlas-key" };
      },
    },
    analytics: sink,
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test("tool calls over HTTP emit one mcp_tool_call each, with no user data", async (t) => {
  const captured: AnalyticsEvent[] = [];
  const sink: AnalyticsSink = { capture: (e) => captured.push(e), shutdown: async () => {} };
  const { baseUrl, server } = await startHarness(sink);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const rpc = (token: string, method: string, params: Record<string, unknown>) =>
    fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "user-agent": "node",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  // finish 在响应交给内核时触发，客户端可能先一步读完；等事件落下来再断言。
  const nextEvent = async (count: number): Promise<AnalyticsEvent> => {
    for (let i = 0; i < 50 && captured.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(captured.length, count);
    return captured[count - 1];
  };

  // 成功：铸一张上传票据，不碰网络
  const ok = await rpc("chatgpt:42", "tools/call", {
    name: "atlas_get_upload_url",
    arguments: { filename_hint: "secret-holiday-photo.png" },
  });
  assert.equal(ok.status, 200);
  const success = await nextEvent(1);
  assert.equal(success.event, "mcp_tool_call");
  assert.equal(success.distinctId, "uid-42");
  assert.equal(success.properties.product, "atlas-mcp");
  assert.equal(success.properties.command, "atlas_get_upload_url");
  assert.equal(success.properties.environment, "dev");
  assert.equal(success.properties.version, SERVER_VERSION);
  assert.equal(success.properties.client_platform, "chatgpt");
  assert.equal(success.properties.is_error, false);
  assert.equal(typeof success.properties.duration_ms, "number");
  assert.equal("error_code" in success.properties, false);
  // 不带任何用户数据：文件名、上传地址、令牌都不在事件里
  const serialized = JSON.stringify(success);
  for (const secret of ["secret-holiday-photo", "/upload/", "chatgpt:42", "Bearer"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  // 工具自己拒绝：缺 model 参数
  await rpc("chatgpt:42", "tools/call", { name: "atlas_get_model_info", arguments: {} });
  const failed = await nextEvent(2);
  assert.equal(failed.properties.command, "atlas_get_model_info");
  assert.equal(failed.properties.is_error, true);
  assert.equal(failed.properties.error_code, "invalid_param");
  assert.equal(failed.properties.error_category, "invalid_request");

  // 只读令牌调生成：scope 不够，工具没跑，按 HTTP 403 记
  const denied = await rpc("chatgpt:42:ro", "tools/call", { name: "atlas_generate_image", arguments: {} });
  assert.equal(denied.status, 403);
  const forbidden = await nextEvent(3);
  assert.equal(forbidden.properties.error_code, "access_denied");
  assert.equal(forbidden.properties.http_status, 403);

  // 不是工具调用、sub 不是数字用户 ID：都不发
  await rpc("chatgpt:42", "tools/list", {});
  await rpc("chatgpt:test-user", "tools/call", { name: "atlas_get_model_info", arguments: {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(captured.length, 3);

  // 动态注册的客户端：initialize 报了名字，之后的工具调用按名字归平台
  await rpc("dcr:7", "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "WorkBuddy Connector (custom-mcp:atlas-cloud)", version: "5.5.6" },
  });
  await rpc("dcr:7", "tools/call", { name: "atlas_get_model_info", arguments: {} });
  const registered = await nextEvent(4);
  assert.equal(registered.distinctId, "uid-7");
  assert.equal(registered.properties.client_platform, "workbuddy");
});
