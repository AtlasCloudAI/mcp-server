import assert from "node:assert/strict";
import test from "node:test";
import {
  disableEnvironmentApiKey,
  localSourceHeaders,
  request,
  uploadMediaBuffer,
} from "../src/services/api-client.js";
import { clientState } from "../src/telemetry/state.js";

// npm 本地版（stdio）的消费要记成 atlas-mcp、带上客户端名（aiproxy v1.5.72 读这两个头）；
// 远程服务的入口关掉环境变量 key 时一起关掉，托管流量照旧按 OAuth 客户端归属。

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function capture(): { fetcher: typeof fetch; seen: Array<Record<string, string>> } {
  const seen: Array<Record<string, string>> = [];
  const fetcher = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ ...(init?.headers ?? {}) });
    return new Response(JSON.stringify({ code: 200, message: "ok", data: { type: "image/png", download_url: "https://cdn.example.test/a.png", filename: "a.png", size: 12 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

test("stdio: authed requests carry X-Source-From and, once known, X-Atlas-MCP-Client", async () => {
  process.env.ATLASCLOUD_API_KEY = "test-key";
  const { fetcher, seen } = capture();

  await request("https://api.example.test", "/balance", { fetcher });
  assert.equal(seen[0]["X-Source-From"], "atlas-mcp");
  assert.equal(seen[0]["X-Atlas-MCP-Client"], undefined, "no client header before initialize");

  clientState.name = "claude-code";
  clientState.version = "2.1.321";
  await request("https://api.example.test", "/balance", { fetcher });
  assert.equal(seen[1]["X-Atlas-MCP-Client"], "claude-code/2.1.321");

  // 资产库换原图地址走 requireAuth:false + 自带 Authorization，也要带。
  await request("https://api.example.test", "/assetd/api/assets/source-urls", {
    method: "POST",
    requireAuth: false,
    headers: { Authorization: "Bearer test-key" },
    fetcher,
  });
  assert.equal(seen[2]["X-Source-From"], "atlas-mcp");

  // 不带 key 的请求（公开目录）不带。
  await request("https://api.example.test", "/models", { requireAuth: false, fetcher });
  assert.equal(seen[3]["X-Source-From"], undefined);

  await uploadMediaBuffer(PNG, "a.png", "test-key", { fetcher });
  assert.equal(seen[4]["X-Source-From"], "atlas-mcp");
  assert.equal(seen[4]["X-Atlas-MCP-Client"], "claude-code/2.1.321");
});

test("remote: once the environment key is disabled, no source headers are sent", async () => {
  disableEnvironmentApiKey();
  assert.deepEqual(localSourceHeaders(), {});
  const { fetcher, seen } = capture();
  await request("https://api.example.test", "/x", {
    requireAuth: false,
    headers: { Authorization: "Bearer oauth-derived" },
    fetcher,
  });
  assert.equal(seen[0]["X-Source-From"], undefined);
  assert.equal(seen[0]["X-Atlas-MCP-Client"], undefined);
});

test("upload outside the default root says which folder and what to do", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { uploadMedia } = await import("../src/services/api-client.js");
  const dir = mkdtempSync(join(tmpdir(), "upload-outside-"));
  const file = join(dir, "a.png");
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  delete process.env.ATLASCLOUD_UPLOAD_ROOTS;
  await assert.rejects(uploadMedia(file), (error: Error) => {
    assert.match(error.message, /folder the MCP client started it in/);
    assert.match(error.message, /ATLASCLOUD_UPLOAD_ROOTS/);
    assert.ok(error.message.includes(process.cwd()));
    return true;
  });
});
