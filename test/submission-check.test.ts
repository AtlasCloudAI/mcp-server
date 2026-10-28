// 报价卡核实「刚才那一单开没开始」：先看幂等记录，记录说不准再按模型、提示词、时间认最近的任务。
import assert from "node:assert/strict";
import test from "node:test";
import { NOT_STARTED_AFTER_MS, checkSubmission, matchSubmission } from "../src/apps/submission-check.js";
import { ApiRequestError } from "../src/services/api-client.js";
import { executeIdempotently } from "../src/services/idempotency.js";
import type { HistoryItem } from "../src/response-schemas.js";
import { remoteToolPolicy } from "../src/tool-policy.js";

const item = (ID: string, model: string, seconds: number, prompt?: string): HistoryItem => ({
  ID,
  model,
  status: "processing",
  createdAt: String(seconds),
  requestBody: JSON.stringify({ model, ...(prompt ? { prompt } : {}) }),
});

test("认提交之后建的、同模型同提示词的最早一条", () => {
  const since = 1_800_000_000_000;
  const s = since / 1000;
  const items = [
    item("newer", "m/a", s + 20, "a cat"),
    item("other-prompt", "m/a", s + 5, "a dog"),
    item("other-model", "m/b", s + 3, "a cat"),
    item("first", "m/a", s + 2, "a cat"),
    item("before", "m/a", s - 600, "a cat"),
  ];
  assert.equal(matchSubmission(items, { model: "m/a", text: "a cat", since }), "first");
  // 两边时钟差在 30 秒内也认。
  assert.equal(matchSubmission([item("skewed", "m/a", s - 20, "a cat")], { model: "m/a", text: "a cat", since }), "skewed");
  assert.equal(matchSubmission(items, { model: "m/c", text: "a cat", since }), undefined);
  // 没有提示词可比时只按模型和时间认。
  assert.equal(matchSubmission(items, { model: "m/b", since }), "other-model");
});

test("幂等记录有答案就直接用：提交成功、被拒收", async () => {
  const done = "1c2a3b4d-0000-4000-8000-000000000001";
  await executeIdempotently("atlas_generate_image", { prompt: "x" }, done, async () => ({
    ok: true,
    predictionId: "pred-123",
  }));
  assert.deepEqual(await checkSubmission({ tool: "atlas_generate_image", idempotency_key: done }), {
    outcome: "started",
    prediction_id: "pred-123",
  });

  // 快速生成存的是原始响应。
  const quick = "1c2a3b4d-0000-4000-8000-000000000002";
  await executeIdempotently("atlas_quick_generate", { prompt: "x" }, quick, async () => ({ data: { id: "pred-q" } }));
  assert.deepEqual(await checkSubmission({ tool: "atlas_quick_generate", idempotency_key: quick }), {
    outcome: "started",
    prediction_id: "pred-q",
  });

  // 上游收下了却没给任务号：不能说没开始，接着找（这里不带 model，只能先说还在查）。
  const noId = "1c2a3b4d-0000-4000-8000-000000000006";
  await executeIdempotently("atlas_generate_image", { prompt: "x" }, noId, async () => ({ ok: false, message: "no id" }));
  assert.deepEqual(await checkSubmission({ tool: "atlas_generate_image", idempotency_key: noId }), { outcome: "checking" });

  const rejected = "1c2a3b4d-0000-4000-8000-000000000003";
  await executeIdempotently("atlas_generate_image", { prompt: "x" }, rejected, async () => {
    throw new ApiRequestError("router not found", 400);
  }).catch(() => undefined);
  assert.equal((await checkSubmission({ tool: "atlas_generate_image", idempotency_key: rejected })).outcome, "not_started");
});

test("记录说不准、又认不出任务：还在时间窗里就接着查，过了就算没开始", async () => {
  const key = "1c2a3b4d-0000-4000-8000-000000000004";
  await executeIdempotently("atlas_generate_video", { prompt: "x" }, key, async () => {
    throw new Error("fetch failed");
  }).catch(() => undefined);
  // 不带 model 就不翻历史（这里没有可用的接口），只看时间。
  assert.deepEqual(await checkSubmission({ tool: "atlas_generate_video", idempotency_key: key }), { outcome: "checking" });
  const later = await checkSubmission({
    tool: "atlas_generate_video",
    idempotency_key: key,
    now: Date.now() + NOT_STARTED_AFTER_MS + 1_000,
  });
  assert.equal(later.outcome, "not_started");

  // 没有记录（工具根本没跑到），按卡片给的提交时间算。
  const missing = await checkSubmission({
    tool: "atlas_generate_video",
    idempotency_key: "1c2a3b4d-0000-4000-8000-000000000005",
    submitted_at: new Date(Date.now() - NOT_STARTED_AFTER_MS - 5_000).toISOString(),
  });
  assert.equal(missing.outcome, "not_started");
});

test("核实工具只读：和刷新卡片同一个权限", () => {
  const policy = remoteToolPolicy("atlas_card_check_submission");
  assert.equal(policy?.scope, "tasks:read");
  assert.equal(policy?.billable, false);
  assert.equal(policy?.annotations.readOnlyHint, true);
});
