// 11-18 上线前审查 H1：同步出结果的模型在提交响应里就带了成品，工具返回 status "completed" 和 outputs。
// 生成工具的 outputSchema 原来只允许 confirmation_required / submitted，SDK 的输出校验把这个已经扣费的
// 成功结果换成了报错，用户以为没成、再交一次就重复扣费。这里用真实的 McpServer + Client（内存传输）
// 走一遍「报价 → 确认 → 同步出结果」。
//
// 接口地址在模块加载时就定了，所以先设环境变量、装好假网关，再动态 import 服务端。模型 schema 只从
// https 的 static.atlascloud.ai 取，所以假网关用 undici 的 MockAgent，不起本地 http 服务。
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

const API = "https://api.sync-test.example";
const SCHEMA_URL = "https://static.atlascloud.ai/schemas/sync-image.json";
const OUTPUT = "https://atlas-media.oss-us-west-1.aliyuncs.com/sync/out.png";
const MODEL = "test/sync-image";

let previous: Dispatcher;
let agent: MockAgent;
const submitted: Array<Record<string, unknown>> = [];

before(() => {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[key];
  process.env.ATLASCLOUD_API_BASE_URL = API;
  process.env.ATLASCLOUD_GENERATION_API_BASE_URL = API;
  process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
  process.env.MCP_INPUT_LINK_CHECK = "off";
  // 不去拉成品做预览：这里只核对结构化结果。
  process.env.MCP_MEDIA_PREVIEW_HOSTS = "preview.invalid";
  delete process.env.MCP_UI_CARDS;

  previous = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const api = agent.get(API);
  api
    .intercept({ path: (path) => path.startsWith("/api/v1/models"), method: "GET" })
    .reply(200, {
      code: 200,
      data: [
        {
          uuid: "1",
          model: MODEL,
          type: "Image",
          displayName: "Sync Image",
          schema: SCHEMA_URL,
          price: { actual: { base_price: "0.01" } },
        },
      ],
    }, { headers: { "content-type": "application/json" } })
    .persist();
  api
    .intercept({ path: "/api/v1/model/calculate", method: "POST" })
    .reply(200, { code: 200, data: { price: 0.01 } }, { headers: { "content-type": "application/json" } })
    .persist();
  api
    .intercept({ path: "/api/v1/model/generateImage", method: "POST" })
    .reply((options) => {
      submitted.push(JSON.parse(String(options.body)) as Record<string, unknown>);
      return {
        statusCode: 200,
        data: { code: 200, data: { id: "sync_1", status: "completed", outputs: [OUTPUT] } },
        responseOptions: { headers: { "content-type": "application/json" } },
      };
    })
    .persist();
  agent
    .get("https://static.atlascloud.ai")
    .intercept({ path: "/schemas/sync-image.json", method: "GET" })
    .reply(200, {
      components: {
        schemas: {
          Input: { type: "object", required: ["model", "prompt"], properties: { prompt: { type: "string" } } },
        },
      },
    }, { headers: { "content-type": "application/json" } })
    .persist();
});

after(async () => {
  setGlobalDispatcher(previous);
  await agent.close();
});

test("H1: a model that finishes synchronously returns status completed with outputs, not an output-validation error", async () => {
  const { createAtlasCloudServer } = await import("../src/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createAtlasCloudServer("stdio");
  const client = new Client({ name: "sync-output-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const args = { model: MODEL, params: { prompt: "a red kite" } };
    const quote = await client.callTool({ name: "atlas_generate_image", arguments: args });
    assert.notEqual(quote.isError, true, JSON.stringify(quote.content));
    const quoted = quote.structuredContent as Record<string, unknown>;
    assert.equal(quoted.status, "confirmation_required");
    assert.equal(submitted.length, 0);

    const done = await client.callTool({
      name: "atlas_generate_image",
      arguments: {
        ...args,
        confirmed: true,
        idempotency_key: quoted.idempotency_key,
        confirmation_token: quoted.confirmation_token,
      },
    });
    const text = (done.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    assert.notEqual(done.isError, true, text);
    assert.doesNotMatch(text, /Output validation error/);
    const structured = done.structuredContent as Record<string, unknown>;
    assert.equal(structured.status, "completed");
    assert.deepEqual(structured.outputs, [OUTPUT]);
    assert.equal(structured.prediction_id, "sync_1");
    assert.equal(submitted.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("H1: the advertised output schema lists completed and outputs", async () => {
  const { generationOutputSchema } = await import("../src/tool-contracts.js");
  const { z } = await import("zod");
  const schema = z.object(generationOutputSchema);
  const parsed = schema.safeParse({
    prediction_id: "sync_1",
    model_id: MODEL,
    model_name: "Sync Image",
    kind: "image",
    status: "completed",
    outputs: [OUTPUT],
  });
  assert.equal(parsed.success, true);
});
