import assert from "node:assert/strict";
import test from "node:test";
import { fullPrompt } from "../src/apps/history-card.js";
import type { HistoryItem } from "../src/response-schemas.js";

// 单独一个文件：history-card.test.ts 要先设好假接口地址再动态引入 src，这里静态引入会抢在它前面。
test("历史条目带完整提示词给「Reuse prompt」，不是列表里那段 160 字的截断（设计 11-10 第 11 项）", () => {
  const long = `A glass perfume bottle ${"on wet black stone, ".repeat(20)}soft rim light`;
  const item = { ID: "p1", model: "m", status: "completed", requestBody: { prompt: `  ${long}  ` } } as unknown as HistoryItem;
  assert.equal(fullPrompt(item), long);

  const huge = { ...item, requestBody: { prompt: "x".repeat(2500) } } as unknown as HistoryItem;
  assert.equal(fullPrompt(huge)?.length, 2000);
  assert.ok(fullPrompt(huge)?.endsWith("…"));

  assert.equal(fullPrompt({ ...item, requestBody: { prompt: "   " } } as unknown as HistoryItem), undefined);
  assert.equal(fullPrompt({ ...item, requestBody: undefined } as unknown as HistoryItem), undefined);
});

test("历史详情的按钮按设计 11-12：成功 Download + Reuse prompt，失败 Reuse prompt + View request，生成中只有 View request", async () => {
  const { historyDetailButtons } = await import("../ui/generation-card/history.js");
  assert.deepEqual(historyDetailButtons("succeeded", true, true), ["keep-download", "reuse"]);
  assert.deepEqual(historyDetailButtons("failed", true, true), ["reuse", "view-request"]);
  assert.deepEqual(historyDetailButtons("running", true, true), ["view-request"]);
  assert.deepEqual(historyDetailButtons("queued", true, true), ["view-request"]);
  assert.deepEqual(historyDetailButtons("canceled", true, true), []);
  // 卡片不能替用户发消息：换成 Copy prompt。
  assert.deepEqual(historyDetailButtons("succeeded", true, false), ["keep-download", "copy"]);
  assert.deepEqual(historyDetailButtons("failed", true, false), ["copy", "view-request"]);
  // 没有提示词（内容过了保留期）：不放提示词按钮。
  assert.deepEqual(historyDetailButtons("succeeded", false, true), ["keep-download"]);
  assert.deepEqual(historyDetailButtons("failed", false, true), ["view-request"]);
});
