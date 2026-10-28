import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

// API 地址在模块加载时就定了，所以先起假目录、设好环境变量，再动态 import。
const CATALOG = [
  ["bytedance/seedance-2.0-mini/text-to-video", "Video"],
  ["bytedance/seedance-2.5/image-to-video", "Video"],
  ["kwaivgi/kling-v4.0/text-to-video", "Video"],
  ["bytedance/seedream-v5.0-flash/text-to-image", "Image"],
].map(([id, type]) => ({ uuid: id, model: id, type, displayName: id }));

test("atlas_quick_generate 不给 model_keyword 时按线上目录走默认路由", async (t) => {
  const fake = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/api/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 200, data: CATALOG }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((r) => fake.close(r)));
  process.env.ATLASCLOUD_API_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  const { resolveDefaultModel } = await import("../src/services/default-models.js");

  // Seedance 2.5 只有图生视频：带图选它，纯文本顺延到 Kling 4.0，不选更便宜的 2.0 Mini。
  const i2v = await resolveDefaultModel("Video", { hasImage: true });
  assert.ok("model" in i2v);
  assert.equal(i2v.model.model, "bytedance/seedance-2.5/image-to-video");
  const t2v = await resolveDefaultModel("Video", { hasImage: false });
  assert.ok("model" in t2v);
  assert.equal(t2v.model.model, "kwaivgi/kling-v4.0/text-to-video");

  const t2i = await resolveDefaultModel("Image", { hasImage: false });
  assert.ok("model" in t2i);
  assert.equal(t2i.model.model, "bytedance/seedream-v5.0-flash/text-to-image");

  const edit = await resolveDefaultModel("Image", { hasImage: true });
  assert.ok("error" in edit);
  assert.match(edit.error, /None of the default Image models offers edit/);

  const audio = await resolveDefaultModel("Audio", { hasImage: false });
  assert.ok("error" in audio);
  assert.match(audio.error, /no default Audio model/);

  const { createAtlasCloudServer } = await import("../src/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createAtlasCloudServer("stdio");
  const client = new Client({ name: "default-route-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());

  assert.match(client.getInstructions() ?? "", /follow the default route/);

  const listed = await client.callTool({ name: "atlas_list_models", arguments: { type: "Video" } });
  const text = (listed.content as Array<{ type: string; text?: string }>)[0]!.text ?? "";
  assert.match(text, /^\*\*Default video models\*\*/);
  assert.match(text, /1\. Seedance 2\.5: `bytedance\/seedance-2\.5\/image-to-video`\n2\. Kling 4\.0/);
  const secondPage = await client.callTool({ name: "atlas_list_models", arguments: { type: "Video", offset: 1 } });
  assert.doesNotMatch((secondPage.content as Array<{ text?: string }>)[0]!.text ?? "", /Default video models/);

  const tools = await client.listTools();
  const video = tools.tools.find((tool) => tool.name === "atlas_generate_video")!;
  assert.match(video.description ?? "", /Default model: when the user has not named a model, the default is Seedance 2\.5/);
  const quick = tools.tools.find((tool) => tool.name === "atlas_quick_generate")!;
  assert.ok(!(quick.inputSchema.required ?? []).includes("model_keyword"));
});
