// 11-18 全客户端回归（ChatGPT / Cursor / WorkBuddy）里能在 mcp-server 修的问题。
import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withGenerationCard } from "../src/apps/generation-quote.js";
import { NOT_STARTED_META_KEY as SERVER_KEY } from "../src/apps/generation-card.js";
import { NOT_STARTED_META_KEY, notStartedReason } from "../ui/generation-card/card.js";

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

function fakeServer(): McpServer {
  const capabilities = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
  return { server: { getClientCapabilities: () => capabilities } } as unknown as McpServer;
}

const IMAGE_ARGS = { model: "bytedance/seedream-v5.0-pro/edit", params: { prompt: "x", images: ["file:///etc/passwd"] } };
const errorResult = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

// ---------- 问题 1：报价前被拒，卡片显示成「Couldn't load this task · Error + Refresh」 ----------

test("1 服务端：报价前就被拒的生成报错打上 not_started 标记，可能已提交的不打", async () => {
  assert.equal(SERVER_KEY, NOT_STARTED_META_KEY);
  const restore = withEnv({ MCP_UI_CARDS: "1" });
  try {
    const rejected = await withGenerationCard(fakeServer(), "atlas_generate_image", async () =>
      errorResult("No quote was made and nothing was charged: this input link can't be used.\n- images: file:///etc/passwd — only http and https links can be used.")
    )(IMAGE_ARGS, {});
    assert.equal(rejected.isError, true);
    assert.equal(rejected._meta?.[NOT_STARTED_META_KEY], true);
    // 结构化结果不动：客户端 SDK 出错时也按 outputSchema 校验它。
    assert.equal(rejected.structuredContent, undefined);

    const uncertain = await withGenerationCard(fakeServer(), "atlas_generate_image", async () =>
      errorResult("Error: Request timed out. The request ended without a confirmed response, so it may already have gone through.")
    )({ ...IMAGE_ARGS, confirmed: true, confirmation_token: "c2.1.abcdefghijklmnopqrstuvwxyz0123456789" }, {});
    assert.equal(uncertain._meta?.[NOT_STARTED_META_KEY], undefined);
  } finally {
    restore();
  }
});

test("1 卡片：认出没开始的报错，给原因；登录失效、可能已提交、查单报错都不算", () => {
  const reason = "images: file:///etc/passwd — only http and https links can be used.";
  // 服务端打了标记
  assert.equal(notStartedReason({ ...errorResult(reason), _meta: { [NOT_STARTED_META_KEY]: true } }), reason);
  // 宿主没转 _meta：生成调用 + 报价前被拒的原话
  const validation = "Parameter validation failed for `bytedance/seedance-2.5/image-to-video`. The request was NOT submitted (no credits were spent). Fix the following and retry:\n\n- image is required";
  assert.equal(notStartedReason(errorResult(validation), { args: IMAGE_ARGS }), validation);
  assert.equal(
    notStartedReason(errorResult('Model "x/y" not found. Use atlas_list_models with type="Image" to see available image models.'), { args: IMAGE_ARGS }),
    'Model "x/y" not found. Use atlas_list_models with type="Image" to see available image models.'
  );
  // 查单（带 prediction_id）的报错照旧走 Couldn't load this task
  assert.equal(notStartedReason(errorResult(validation), { args: { prediction_id: "abc" } }), undefined);
  // 可能已经提交的：就算打了标记也不认
  assert.equal(
    notStartedReason({ ...errorResult("The request ended without a confirmed response"), _meta: { [NOT_STARTED_META_KEY]: true } }),
    undefined
  );
  // 登录失效走「需要重新连接」
  assert.equal(
    notStartedReason({ ...errorResult("Connector authorization required"), _meta: { [NOT_STARTED_META_KEY]: true } }),
    undefined
  );
  // 不是报错
  assert.equal(notStartedReason({ content: [{ type: "text", text: "ok" }] }), undefined);
});
