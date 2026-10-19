import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { clientProfile, wantsImageBlocks } from "../src/services/client-profile.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { buildImagePreviews } from "../src/services/media-preview.js";
import { runWithRequestContext } from "../src/services/request-context.js";
import { isAtlasStorageUrl, isPendingTransfer } from "../src/services/owned-storage.js";
import { waitForPrediction } from "../src/services/prediction-wait.js";
import type { PredictionResponse } from "../src/response-schemas.js";

test("按 OAuth client_id 区分聊天客户端、带 shell 的客户端和其他", () => {
  assert.equal(clientProfile("https://chatgpt.com/oauth/client.json"), "chat");
  assert.equal(clientProfile("https://chatgpt.com/oauth/codex/client.json"), "shell");
  assert.equal(clientProfile("https://claude.ai/oauth/mcp-oauth-client-metadata"), "chat");
  assert.equal(clientProfile("https://claude.ai/oauth/claude-code-client-metadata"), "shell");
  assert.equal(clientProfile("dcr-client-123"), "other");
  assert.equal(clientProfile(undefined), "other");
});

test("图片块只不给 Codex：它把块当文字读，会把 base64 原样贴回回复", () => {
  assert.equal(wantsImageBlocks("https://chatgpt.com/oauth/codex/client.json"), false);
  assert.equal(wantsImageBlocks("https://chatgpt.com/oauth/client.json"), true);
  assert.equal(wantsImageBlocks("https://claude.ai/oauth/claude-code-client-metadata"), true);
  assert.equal(wantsImageBlocks("https://claude.ai/oauth/mcp-oauth-client-metadata"), true);
  assert.equal(wantsImageBlocks("dcr-client-123"), true);
  assert.equal(wantsImageBlocks(undefined), true);
});

test("Codex 请求里不抓预览图；其他客户端照常去抓", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (message: string) => logs.push(String(message)));
  const contextFor = (clientId: string) => ({
    authInfo: { token: "t", clientId, scopes: ["tasks:read"] } as AuthInfo,
    subject: "user-1",
    atlasApiKey: "k",
    idempotencyStore: new InMemoryIdempotencyStore(),
    idempotencyTtlSeconds: 60,
    generationConfirmationSecret: "s".repeat(32),
    generationConfirmationTtlSeconds: 600,
  });
  // example.com 不在预览白名单里：真去抓会在发请求前就被拒，记一条 fail，不碰网络。
  const urls = ["https://example.com/out.png"];

  const codex = await runWithRequestContext(contextFor("https://chatgpt.com/oauth/codex/client.json"), () =>
    buildImagePreviews(urls)
  );
  assert.deepEqual(codex, []);
  assert.ok(logs.some((l) => l.includes("skipped: client gets no image blocks")));
  assert.ok(!logs.some((l) => l.includes("fail example.com")));

  logs.length = 0;
  const chat = await runWithRequestContext(contextFor("https://chatgpt.com/oauth/client.json"), () =>
    buildImagePreviews(urls)
  );
  assert.deepEqual(chat, []);
  assert.ok(logs.some((l) => l.includes("fail example.com/out.png")));
});

test("自家存储：atlascloud.ai 与 atlas-* 桶；其他阿里云桶和火山 TOS 不算", () => {
  assert.equal(isAtlasStorageUrl("https://atlas-media.oss-us-west-1.aliyuncs.com/a.mp4"), true);
  assert.equal(isAtlasStorageUrl("https://atlas-media-dev.oss-us-west-1.aliyuncs.com/a.mp4"), true);
  assert.equal(isAtlasStorageUrl("https://atlas-img.oss-accelerate-overseas.aliyuncs.com/i.png"), true);
  assert.equal(isAtlasStorageUrl("https://media.atlascloud.ai/a.mp4"), true);
  assert.equal(isAtlasStorageUrl("https://static.atlascloud.ai/x.png"), true);
  // 有些上游厂商也从阿里云出结果，光看后缀不能算自家。
  assert.equal(isAtlasStorageUrl("https://dashscope-result.oss-cn-beijing.aliyuncs.com/a.mp4"), false);
  assert.equal(
    isPendingTransfer("https://ark-acg-ap-southeast-1.tos-ap-southeast-1.volces.com/x.mp4?X-Tos-Expires=86400"),
    true
  );
  // 只有慢 CDN（火山 TOS）是「先给上游链接、后台再转存」。S3 桥的交付链接本身就是最终的，
  // 转存失败的上游链接也不会再变——这些都不能扣，否则每个任务白等 5 分钟。
  assert.equal(isPendingTransfer("https://bucket.s3.us-east-1.amazonaws.com/out.mp4?X-Amz-Signature=x"), false);
  assert.equal(isPendingTransfer("https://v3.fal.media/files/out.mp4"), false);
  assert.equal(isPendingTransfer("not a url"), false);
});

function prediction(status: string, outputs: string[] = [], completedAt?: string): PredictionResponse {
  return {
    code: 200,
    data: { status, outputs, ...(completedAt ? { completed_at: completedAt } : {}) },
  } as unknown as PredictionResponse;
}

test("服务端等待：处理中会继续查，完成且已在自家存储就立刻返回", async (t) => {
  t.after(() => delete process.env.MCP_PREDICTION_WAIT_SECONDS);
  process.env.MCP_PREDICTION_WAIT_SECONDS = "20";
  let clock = 0;
  const answers = [
    prediction("processing"),
    prediction("processing"),
    prediction("completed", ["https://atlas-media.oss-us-west-1.aliyuncs.com/a.mp4"]),
  ];
  let calls = 0;
  const { result, waitedSeconds } = await waitForPrediction(async () => answers[calls++]!, {
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(calls, 3);
  assert.equal(result.data?.status, "completed");
  assert.equal(waitedSeconds, 10);
});

test("服务端等待：完成但还是上游链接时继续等转存；等满就返回让调用方提示", async (t) => {
  t.after(() => delete process.env.MCP_PREDICTION_WAIT_SECONDS);
  process.env.MCP_PREDICTION_WAIT_SECONDS = "10";
  let clock = 0;
  let calls = 0;
  const upstream = prediction(
    "completed",
    ["https://x.tos-ap-southeast-1.volces.com/a.mp4"],
    new Date().toISOString()
  );
  const { result } = await waitForPrediction(async () => {
    calls++;
    return upstream;
  }, {
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(result.data?.status, "completed");
  assert.ok(calls >= 2 && calls <= 3, `calls=${calls}`);
});

test("等待时间为 0 时只查一次", async (t) => {
  t.after(() => delete process.env.MCP_PREDICTION_WAIT_SECONDS);
  process.env.MCP_PREDICTION_WAIT_SECONDS = "0";
  let calls = 0;
  await waitForPrediction(async () => {
    calls++;
    return prediction("processing");
  });
  assert.equal(calls, 1);
});

test("完成超过 5 分钟仍没转存，就不再扣住上游链接（服务端无状态，靠 completed_at 判断）", async () => {
  const { hasUntransferredMedia, secondsSince } = await import("../src/services/prediction-wait.js");
  const upstream = ["https://x.tos-ap-southeast-1.volces.com/a.mp4"];
  const justNow = new Date(Date.now() - 30_000).toISOString();
  const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  assert.equal(hasUntransferredMedia(upstream, justNow), true);
  assert.equal(hasUntransferredMedia(upstream, longAgo), false);
  // 没有完成时间就没法给扣留设上限：直接放行，不能无限让模型「过会儿再查」。
  assert.equal(hasUntransferredMedia(upstream, undefined), false);
  assert.equal(secondsSince("not a date"), null);
});

test("服务端等待中重查出错：返回已拿到的结果，而不是把整次调用变成失败", async (t) => {
  t.after(() => delete process.env.MCP_PREDICTION_WAIT_SECONDS);
  process.env.MCP_PREDICTION_WAIT_SECONDS = "20";
  let clock = 0;
  let calls = 0;
  const { result } = await waitForPrediction(
    async () => {
      calls++;
      if (calls === 1) return prediction("processing");
      throw new Error("HTTP 502");
    },
    { sleep: async (ms) => { clock += ms; }, now: () => clock }
  );
  assert.equal(result.data?.status, "processing");
  assert.equal(calls, 2);
});

test("等待上限最多 30 秒，留出图片预览和大小探测的时间", async (t) => {
  const { predictionWaitSeconds } = await import("../src/services/prediction-wait.js");
  t.after(() => delete process.env.MCP_PREDICTION_WAIT_SECONDS);
  process.env.MCP_PREDICTION_WAIT_SECONDS = "60";
  assert.equal(predictionWaitSeconds(), 30);
  delete process.env.MCP_PREDICTION_WAIT_SECONDS;
  assert.equal(predictionWaitSeconds(), 20);
});

test("服务端等待：首查带重试，等待期间的重查不重试、超时不超过剩余预算", async (t) => {
  t.after(() => delete process.env.MCP_PREDICTION_WAIT_SECONDS);
  process.env.MCP_PREDICTION_WAIT_SECONDS = "20";
  let clock = 0;
  const budgets: Array<{ timeoutMs: number; maxRetries: number }> = [];
  await waitForPrediction(
    async (budget) => {
      budgets.push(budget);
      return prediction("processing");
    },
    { sleep: async (ms) => { clock += ms; }, now: () => clock }
  );
  assert.equal(budgets[0]!.maxRetries, 1);
  assert.ok(budgets[0]!.timeoutMs <= 15_000);
  for (const b of budgets.slice(1)) {
    assert.equal(b.maxRetries, 0);
    assert.ok(b.timeoutMs <= 10_000);
  }
  assert.ok(budgets.length >= 3);
});
