// 2026-11-24：OpenAI 的自动检查四次拦下 atlas_generate_image / video / quick_generate（"operations that are not
// individually exposed"），描述怎么改都拦；同结构但只有一种任务的 atlas_transcribe_audio、atlas_chat 一直过。
// 开关 MCP_CHATGPT_TASK_TOOLS 打开后，ChatGPT 另拿 5 个「一个任务一个工具」：模型是枚举、参数是固定字段。
// 这里核对：工具形状符合 OpenAI 指南 6.2 / 6.3；换算出的上游参数对；其他客户端和本地版一个字不变。
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

const API = "https://api.task-tools.example";
const SCHEMA_HOST = "https://static.atlascloud.ai";
const CHATGPT = "https://chatgpt.com/oauth/client.json";
const OTHER_CLIENTS = {
  claude: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  codex: "https://chatgpt.com/oauth/codex/client.json",
  "claude-code": "https://claude.ai/oauth/claude-code-client-metadata",
  cursor: "dcr-cursor",
} as const;
const MCP_APPS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
const TASK_TOOLS = [
  "atlas_text_to_image",
  "atlas_edit_image",
  "atlas_text_to_video",
  "atlas_image_to_video",
  "atlas_reference_to_video",
];

// 线上目录里的 20 个默认路由模型（11-24 上游 schema 的相关字段，够校验用）。
const str = (values?: string[]) => (values ? { type: "string", enum: values } : { type: "string" });
const urls = (max: number) => ({ type: "array", items: { type: "string" }, maxItems: max });
const SEEDREAM_SIZES = ["2048*2048", "2368*1776", "1776*2368", "2816*1584", "1584*2816", "2496*1664", "1664*2496", "3136*1344", "1024*1024", "1536*1536", "1776*1328", "1328*1776", "2048*1152", "1152*2048"];
const GPT_SIZES = ["1024x1024", "1024x768", "768x1024", "1024x1536", "1536x1024", "2048x2048", "2048x1152", "1152x2048", "2560x1088", "1088x2560", "2880x2160", "2160x2880", "3840x2160", "2160x3840"];
const NANO_RATIOS = ["auto", "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "4:1", "1:4", "8:1", "1:8"];
const SEEDANCE = { duration: { type: "integer" }, resolution: str(["480p", "720p", "1080p", "4k"]), ratio: str(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]), generate_audio: { type: "boolean" } };
const KLING = { duration: { type: "integer", minimum: 3, maximum: 30 }, resolution: str(["720p", "1080p", "4k"]), aspect_ratio: str(["auto", "16:9", "9:16", "1:1", "21:9"]) };
const WAN = { duration: { type: "number" }, resolution: str(["1080p", "720p", "480p"]), ratio: str(["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"]), audio: { type: "boolean" } };
const refers = { type: "array", maxItems: 20, items: { type: "object", properties: { url: { type: "string" }, type: str(["image", "video", "audio"]) }, required: ["url", "type"] } };

const MODELS: Record<string, { type: string; required: string[]; properties: Record<string, unknown> }> = {
  "bytedance/seedream-v5.0-pro/text-to-image": { type: "Image", required: ["prompt"], properties: { prompt: str(), size: str(SEEDREAM_SIZES) } },
  "bytedance/seedream-v5.0-pro/edit": { type: "Image", required: ["prompt", "images"], properties: { prompt: str(), size: str(SEEDREAM_SIZES), images: urls(10) } },
  "openai/gpt-image-2.5-sunburst/text-to-image": { type: "Image", required: ["prompt"], properties: { prompt: str(), size: str(["auto", ...GPT_SIZES]), quality: str(["low", "medium", "high"]), n: { type: "integer" } } },
  "openai/gpt-image-2.5-sunburst/edit": { type: "Image", required: ["prompt", "images"], properties: { prompt: str(), size: str(["auto", ...GPT_SIZES]), quality: str(["low", "medium", "high"]), n: { type: "integer" }, images: urls(16) } },
  "google/nano-banana-2.1/text-to-image": { type: "Image", required: ["prompt"], properties: { prompt: str(), aspect_ratio: str(NANO_RATIOS), resolution: str(["1k", "2k", "4k"]) } },
  "google/nano-banana-2.1/edit": { type: "Image", required: ["prompt", "reference_images"], properties: { prompt: str(), aspect_ratio: str(NANO_RATIOS), resolution: str(["1k", "2k", "4k"]), reference_images: urls(14) } },
  "openai/gpt-image-2/text-to-image": { type: "Image", required: ["prompt"], properties: { prompt: str(), size: str(GPT_SIZES), quality: str(["low", "medium", "high"]) } },
  "openai/gpt-image-2/edit": { type: "Image", required: ["prompt", "images"], properties: { prompt: str(), size: str(GPT_SIZES), quality: str(["low", "medium", "high"]), images: urls(10) } },
  "bytedance/seedance-2.5/text-to-video": { type: "Video", required: ["prompt"], properties: { prompt: str(), ...SEEDANCE } },
  "bytedance/seedance-2.5/image-to-video": { type: "Video", required: ["image"], properties: { prompt: str(), image: str(), last_image: str(), ...SEEDANCE } },
  "bytedance/seedance-2.5/reference-to-video": { type: "Video", required: [], properties: { prompt: str(), reference_images: urls(30), reference_videos: urls(10), reference_audios: urls(10), ...SEEDANCE } },
  "kwaivgi/kling-v4.0/text-to-video": { type: "Video", required: ["prompt"], properties: { prompt: str(), ...KLING } },
  "kwaivgi/kling-v4.0/image-to-video": { type: "Video", required: ["image"], properties: { prompt: str(), image: str(), last_image: str(), duration: KLING.duration, resolution: KLING.resolution } },
  "kwaivgi/kling-v4.0/reference-to-video": { type: "Video", required: ["prompt"], properties: { prompt: str(), reference_images: urls(10), reference_videos: urls(5), ...KLING } },
  "alibaba/wan-3.0/text-to-video": { type: "Video", required: ["prompt"], properties: { prompt: str(), ...WAN } },
  "alibaba/wan-3.0/image-to-video": { type: "Video", required: ["prompt", "image"], properties: { prompt: str(), image: str(), last_image: str(), duration: WAN.duration, resolution: WAN.resolution, audio: WAN.audio } },
  "alibaba/wan-3.0/reference-to-video": { type: "Video", required: ["prompt"], properties: { prompt: str(), refers, ...WAN } },
  "bytedance/seedance-2.0/text-to-video": { type: "Video", required: ["prompt"], properties: { prompt: str(), ...SEEDANCE } },
  "bytedance/seedance-2.0/image-to-video": { type: "Video", required: ["image"], properties: { prompt: str(), image: str(), last_image: str(), ...SEEDANCE } },
  "bytedance/seedance-2.0/reference-to-video": { type: "Video", required: [], properties: { prompt: str(), reference_images: urls(9), reference_videos: urls(3), reference_audios: urls(3), ...SEEDANCE } },
};

let previous: Dispatcher;
let agent: MockAgent;
const submitted: Array<Record<string, unknown>> = [];
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ATLASCLOUD_API_BASE_URL", "ATLASCLOUD_GENERATION_API_BASE_URL", "ATLASCLOUD_API_KEY", "MCP_INPUT_LINK_CHECK", "MCP_MEDIA_PREVIEW_HOSTS", "MCP_UI_CARDS", "MCP_CHATGPT_TASK_TOOLS"]) {
    savedEnv[key] = process.env[key];
  }
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[key];
  process.env.ATLASCLOUD_API_BASE_URL = API;
  process.env.ATLASCLOUD_GENERATION_API_BASE_URL = API;
  process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
  process.env.MCP_INPUT_LINK_CHECK = "off";
  process.env.MCP_MEDIA_PREVIEW_HOSTS = "preview.invalid";
  process.env.MCP_UI_CARDS = "1";

  previous = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const json = { headers: { "content-type": "application/json" } };
  const api = agent.get(API);
  api
    .intercept({ path: (path) => path.startsWith("/api/v1/models"), method: "GET" })
    .reply(200, {
      code: 200,
      data: Object.entries(MODELS).map(([model, spec], index) => ({
        uuid: String(index),
        model,
        type: spec.type,
        displayName: model,
        schema: `${SCHEMA_HOST}/schemas/${encodeURIComponent(model)}.json`,
        price: { actual: { base_price: "0.05" } },
      })),
    }, json)
    .persist();
  api
    .intercept({ path: "/api/v1/model/calculate", method: "POST" })
    .reply(200, { code: 200, data: { price: 0.05 } }, json)
    .persist();
  for (const endpoint of ["generateImage", "generateVideo"]) {
    api
      .intercept({ path: `/api/v1/model/${endpoint}`, method: "POST" })
      .reply((options) => {
        submitted.push(JSON.parse(String(options.body)) as Record<string, unknown>);
        return { statusCode: 200, data: { code: 200, data: { id: `task_${submitted.length}`, status: "processing" } }, responseOptions: json };
      })
      .persist();
  }
  for (const [model, spec] of Object.entries(MODELS)) {
    agent
      .get(SCHEMA_HOST)
      .intercept({ path: `/schemas/${encodeURIComponent(model)}.json`, method: "GET" })
      .reply(200, {
        components: {
          schemas: {
            Input: {
              type: "object",
              required: ["model", ...spec.required],
              properties: { model: { type: "string", default: model }, ...spec.properties },
            },
          },
        },
      }, json)
      .persist();
  }
});

after(async () => {
  setGlobalDispatcher(previous);
  await agent.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type Tool = {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, Record<string, unknown>>; additionalProperties?: unknown; required?: string[] };
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

async function connect(profile: "stdio" | "remote", clientId?: string) {
  const { createAtlasCloudServer } = await import("../src/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createAtlasCloudServer(profile, clientId ? { clientId } : {});
  const client = new Client({ name: "task-tools-test", version: "1.0.0" }, { capabilities: MCP_APPS });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: () => client.close() };
}

async function listTools(profile: "stdio" | "remote", clientId?: string): Promise<Tool[]> {
  const { client, close } = await connect(profile, clientId);
  try {
    return (await client.listTools()).tools as Tool[];
  } finally {
    await close();
  }
}

function withTaskTools<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.MCP_CHATGPT_TASK_TOOLS;
  if (value === undefined) delete process.env.MCP_CHATGPT_TASK_TOOLS;
  else process.env.MCP_CHATGPT_TASK_TOOLS = value;
  return run().finally(() => {
    if (saved === undefined) delete process.env.MCP_CHATGPT_TASK_TOOLS;
    else process.env.MCP_CHATGPT_TASK_TOOLS = saved;
  });
}

test("开关：默认关，0/false/no/off 也算关；只认 ChatGPT（含平台插件扫描），不认 Codex", async () => {
  const { chatGptTaskToolsEnabled, usesTaskTools } = await import("../src/services/chatgpt-task-tools.js");
  assert.equal(chatGptTaskToolsEnabled({}), false);
  for (const off of ["", "0", "false", "no", " OFF "]) assert.equal(chatGptTaskToolsEnabled({ MCP_CHATGPT_TASK_TOOLS: off }), false, off);
  for (const on of ["1", "true", "on"]) assert.equal(chatGptTaskToolsEnabled({ MCP_CHATGPT_TASK_TOOLS: on }), true, on);
  await withTaskTools("1", async () => {
    assert.equal(usesTaskTools(CHATGPT), true);
    assert.equal(usesTaskTools("https://platform.openai.com/oauth/client.json"), true);
    assert.equal(usesTaskTools(OTHER_CLIENTS.codex), false);
    assert.equal(usesTaskTools(OTHER_CLIENTS.claude), false);
    assert.equal(usesTaskTools(undefined), false);
  });
});

test("短名 → 模型 ID 全部来自默认路由表，8 个短名 × 各自任务都有对应", async () => {
  const { modelIdFor, IMAGE_MODEL_CHOICES, VIDEO_MODEL_CHOICES } = await import("../src/services/chatgpt-task-tools.js");
  for (const choice of IMAGE_MODEL_CHOICES) {
    for (const tool of ["atlas_text_to_image", "atlas_edit_image"] as const) {
      const id = modelIdFor(choice, tool);
      assert.ok(id && MODELS[id]?.type === "Image", `${choice} ${tool} → ${id}`);
    }
  }
  for (const choice of VIDEO_MODEL_CHOICES) {
    for (const tool of ["atlas_text_to_video", "atlas_image_to_video", "atlas_reference_to_video"] as const) {
      const id = modelIdFor(choice, tool);
      assert.ok(id && MODELS[id]?.type === "Video", `${choice} ${tool} → ${id}`);
    }
  }
});

test("图片比例换算出的 size / aspect_ratio 都在上游枚举里", async () => {
  const { imageParams, IMAGE_MODEL_CHOICES, IMAGE_ASPECT_RATIOS } = await import("../src/services/chatgpt-task-tools.js");
  for (const choice of IMAGE_MODEL_CHOICES) {
    for (const ratio of IMAGE_ASPECT_RATIOS) {
      const params = imageParams(choice, { prompt: "x", aspect_ratio: ratio });
      if (choice === "seedream-5.0-pro") assert.ok(SEEDREAM_SIZES.includes(params.size as string), `${choice} ${ratio}`);
      else if (choice === "nano-banana-2.1") assert.ok(NANO_RATIOS.includes(params.aspect_ratio as string), `${choice} ${ratio}`);
      else assert.ok(GPT_SIZES.includes(params.size as string), `${choice} ${ratio}`);
    }
  }
});

test("ChatGPT + 开关：图片、视频只剩 5 个任务工具，形状符合 OpenAI 指南 6.2 / 6.3", async () => {
  const tools = await withTaskTools("1", () => listTools("remote", CHATGPT));
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  // 11-24 实测：旧的通用生成工具还在时，ChatGPT 做视频总绕回旧工具，所以开关打开时不再给。
  for (const name of ["atlas_generate_image", "atlas_generate_video", "atlas_quick_generate"]) {
    assert.equal(byName.has(name), false, `${name} 不再给 ChatGPT`);
  }
  // 音频、转写照旧，查模型的两个工具它们还要用。
  for (const name of ["atlas_generate_audio", "atlas_transcribe_audio", "atlas_list_models", "atlas_get_model_info", "atlas_get_prediction"]) {
    assert.ok(byName.has(name), `${name} 照旧在`);
  }
  for (const name of TASK_TOOLS) {
    const tool = byName.get(name);
    assert.ok(tool, name);
    const props = tool.inputSchema.properties ?? {};
    // 不收任意参数：没有 params / extra_params，没有自由对象，顶层不收多余字段。
    for (const banned of ["params", "extra_params", "model_id", "model_keyword", "operation", "action", "endpoint", "tool"]) {
      assert.equal(props[banned], undefined, `${name} 不该有 ${banned}`);
    }
    assert.equal(tool.inputSchema.additionalProperties, false, name);
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /\$ref/, `${name} 不用 $ref（每个字段都写全类型）`);
    for (const [field, schema] of Object.entries(props)) {
      assert.notEqual(schema.type, "object", `${name}.${field} 不能是对象`);
      assert.ok(schema.type !== undefined || schema.enum !== undefined, `${name}.${field} 要有类型`);
    }
    // model 只能从固定的几个里选。
    assert.ok(Array.isArray(props.model?.enum) && (props.model!.enum as string[]).length === 4, `${name}.model 是枚举`);
    // 标注：三个都显式写，生成会扣费、不能撤销。
    assert.deepEqual(
      { r: tool.annotations?.readOnlyHint, d: tool.annotations?.destructiveHint, o: tool.annotations?.openWorldHint },
      { r: false, d: true, o: true },
      name
    );
    // 描述只讲这一种操作：不提发现 / 取 schema / 别的生成工具，不对模型下命令。
    const description = tool.description ?? "";
    assert.doesNotMatch(description, /atlas_list_models|atlas_get_model_info|atlas_quick_generate|atlas_generate_(image|video|audio)/, name);
    assert.doesNotMatch(description, /\b(catalog|any model|hundreds|400\+|3D|lipsync|workflow)\b/i, name);
    assert.doesNotMatch(description, /\b(always|never|must|do not|don't|IMPORTANT)\b/i, name);
    // 挂卡片模板（ChatGPT 副本同步到这一版后就能画卡）。
    assert.ok((tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, `${name} 挂卡片`);
  }
  // 卡片专用工具认得新工具名（卡片点 Generate、查提交、作废报价都按工具名）。
  for (const name of ["atlas_card_check_submission", "atlas_cancel_quote"]) {
    const enumValues = byName.get(name)?.inputSchema.properties?.tool?.enum as string[] | undefined;
    assert.ok(enumValues && TASK_TOOLS.every((tool) => enumValues.includes(tool)), name);
  }
});

test("其他客户端、ChatGPT 关开关、本地版：工具列表和开关关着时逐字节一致", async () => {
  const surfaces: Array<[string, "stdio" | "remote", string | undefined]> = [
    ["stdio", "stdio", undefined],
    ["chatgpt", "remote", CHATGPT],
    ...Object.entries(OTHER_CLIENTS).map(([name, id]) => [name, "remote", id] as [string, "remote", string]),
  ];
  for (const [name, profile, clientId] of surfaces) {
    const off = await withTaskTools(undefined, () => listTools(profile, clientId));
    const on = name === "chatgpt" ? off : await withTaskTools("1", () => listTools(profile, clientId));
    assert.equal(JSON.stringify(on), JSON.stringify(off), name);
    assert.ok(off.every((tool) => !TASK_TOOLS.includes(tool.name)), `${name} 没有任务工具`);
  }
});

test("ChatGPT + 开关：服务器说明不再让模型去 atlas_list_models 找工作流（没有能跑工作流的工具了）", async () => {
  const instructions = await withTaskTools("1", async () => {
    const { client, close } = await connect("remote", CHATGPT);
    try {
      return client.getInstructions() ?? "";
    } finally {
      await close();
    }
  });
  assert.doesNotMatch(instructions, /Workflow/);
  assert.match(instructions, /confirmation_token/);
});

type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text?: string }> };

async function quoteAndConfirm(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const before = submitted.length;
  const { client, close } = await connect("remote", CHATGPT);
  try {
    const quote = (await client.callTool({ name: tool, arguments: args })) as Result;
    assert.notEqual(quote.isError, true, quote.content.map((c) => c.text).join("\n"));
    const quoted = quote.structuredContent!;
    assert.equal(quoted.status, "confirmation_required");
    assert.equal(submitted.length, before, "报价不提交");
    const done = (await client.callTool({
      name: tool,
      arguments: { ...args, confirmed: true, idempotency_key: quoted.idempotency_key, confirmation_token: quoted.confirmation_token },
    })) as Result;
    assert.notEqual(done.isError, true, done.content.map((c) => c.text).join("\n"));
    assert.equal(done.structuredContent?.status, "submitted");
    assert.equal(submitted.length, before + 1);
    return submitted[submitted.length - 1]!;
  } finally {
    await close();
  }
}

test("报价 → 确认 → 提交：不选模型用默认路由第一个；固定字段换算成各家字段名", async () => {
  await withTaskTools("1", async () => {
    const image = await quoteAndConfirm("atlas_text_to_image", { prompt: "a red kite", aspect_ratio: "16:9" });
    assert.equal(image.model, "bytedance/seedream-v5.0-pro/text-to-image");
    assert.equal(image.size, "2816*1584");

    const edit = await quoteAndConfirm("atlas_edit_image", {
      prompt: "put the mug on a desk",
      images: ["https://example.com/mug.png"],
      model: "nano-banana-2.1",
    });
    assert.equal(edit.model, "google/nano-banana-2.1/edit");
    assert.deepEqual(edit.reference_images, ["https://example.com/mug.png"]);

    const kling = await quoteAndConfirm("atlas_text_to_video", { prompt: "a cat surfing", model: "kling-4.0", aspect_ratio: "9:16" });
    assert.equal(kling.model, "kwaivgi/kling-v4.0/text-to-video");
    assert.equal(kling.aspect_ratio, "9:16");
    assert.equal(kling.ratio, undefined);
    // 默认路由的档位照旧由服务端补：720p、5 秒。
    assert.equal(kling.resolution, "720p");
    assert.equal(kling.duration, 5);

    const seedance = await quoteAndConfirm("atlas_image_to_video", { image: "https://example.com/a.png", with_audio: false });
    assert.equal(seedance.model, "bytedance/seedance-2.5/image-to-video");
    assert.equal(seedance.generate_audio, false);

    const wan = await quoteAndConfirm("atlas_reference_to_video", {
      prompt: "the person in image 1 dances to audio 1",
      model: "wan-3.0",
      reference_images: ["https://example.com/p.png"],
      reference_audios: ["https://example.com/a.mp3"],
    });
    assert.equal(wan.model, "alibaba/wan-3.0/reference-to-video");
    assert.deepEqual(wan.refers, [
      { url: "https://example.com/p.png", type: "image" },
      { url: "https://example.com/a.mp3", type: "audio" },
    ]);
  });
});

test("模型做不到的组合在报价前就说明，不报价、不提交", async () => {
  await withTaskTools("1", async () => {
    const before = submitted.length;
    const { client, close } = await connect("remote", CHATGPT);
    try {
      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ["atlas_text_to_video", { prompt: "x", model: "kling-4.0", with_audio: true }, /Kling 4\.0 has no setting for generated audio/],
        ["atlas_reference_to_video", { prompt: "x", model: "kling-4.0", reference_audios: ["https://example.com/a.mp3"] }, /does not take reference audio/],
        ["atlas_reference_to_video", { prompt: "x" }, /at least one reference/],
      ];
      for (const [tool, args, message] of cases) {
        const result = (await client.callTool({ name: tool, arguments: args })) as Result;
        assert.equal(result.isError, true, tool);
        assert.match(result.content.map((c) => c.text).join("\n"), message);
      }
      // 不在枚举里的模型在参数校验这一层就被拒。
      const unknownModel = (await client.callTool({ name: "atlas_text_to_image", arguments: { prompt: "x", model: "flux-dev" } })) as Result;
      assert.equal(unknownModel.isError, true);
    } finally {
      await close();
    }
    assert.equal(submitted.length, before);
  });
});

test("HTTP 远端：任务工具带 securitySchemes（tasks:write），埋点记得到真名", async () => {
  const { remoteToolPolicy } = await import("../src/tool-policy.js");
  for (const name of TASK_TOOLS) {
    const policy = remoteToolPolicy(name);
    assert.equal(policy?.remote, true, name);
    assert.equal(policy?.scope, "tasks:write", name);
    assert.equal(policy?.billable, true, name);
  }
  const { withOpenAIToolSecuritySchemes } = await import("../src/http/openai-tool-metadata-transport.js");
  const message = withOpenAIToolSecuritySchemes({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [{ name: "atlas_text_to_video", inputSchema: { type: "object" } }] },
  } as never) as unknown as { result: { tools: Array<{ securitySchemes?: unknown }> } };
  assert.deepEqual(message.result.tools[0]!.securitySchemes, [{ type: "oauth2", scopes: ["tasks:write"] }]);
});
