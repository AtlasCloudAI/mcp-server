import assert from "node:assert/strict";
import test from "node:test";
import { historyResponseSchema } from "../src/response-schemas.js";
import { summarizeHistoryItem } from "../src/tools/predictions.js";

// 2026-09-28 从生产 /model/history 抄下来的形状：code 是字符串，createdAt 是秒级
// 时间戳字符串，requestBody 是 JSON 字符串。别把它改成"看起来更合理"的样子。
const liveShaped = {
  code: "200",
  data: {
    total: 550,
    pageNo: 1,
    pageSize: 20,
    items: [
      {
        ID: "732a5576dd93469cbb010ffd346b7865",
        model: "bytedance/seedream-v5.0-lite",
        status: "failed",
        createdAt: "1790583543",
        requestBody: '{"model":"bytedance/seedream-v5.0-lite","prompt":"a fluffy chick"}',
        result: {
          error: "Upstream access denied, please contact administrator.",
          error_code: 1013002,
        },
      },
      {
        ID: "969b879f6ed14e0abde67c18456f45c0",
        model: "bytedance/seedream-v4.7/text-to-image",
        status: "completed",
        createdAt: 1790583216,
        requestBody: {
          model: "bytedance/seedream-v4.7/text-to-image",
          prompt: "x".repeat(200),
        },
        result: {
          outputs: [
            "https://atlas-media.oss-us-west-1.aliyuncs.com/a.jpeg",
            "https://atlas-media.oss-us-west-1.aliyuncs.com/b.jpeg",
          ],
        },
      },
    ],
  },
};

test("history 响应按后端实际形状解析", () => {
  const parsed = historyResponseSchema.parse(liveShaped);
  assert.equal(parsed.data.total, 550);
  assert.equal(parsed.data.items.length, 2);
  assert.equal(parsed.data.items[0]!.status, "failed");
});

test("items 为 null 时按空列表处理，total 缺省为 0", () => {
  const parsed = historyResponseSchema.parse({ code: "200", data: { items: null } });
  assert.deepEqual(parsed.data.items, []);
  assert.equal(parsed.data.total, 0);
});

test("摘要：失败条目带 error、完成条目带 outputs；秒级时间戳转 ISO；长 prompt 截断", () => {
  const parsed = historyResponseSchema.parse(liveShaped);
  const [failed, completed] = parsed.data.items.map(summarizeHistoryItem);
  assert.deepEqual(failed, {
    prediction_id: "732a5576dd93469cbb010ffd346b7865",
    model: "bytedance/seedream-v5.0-lite",
    status: "failed",
    created_at: new Date(1790583543 * 1000).toISOString(),
    outputs: [],
    error: "Upstream access denied, please contact administrator.",
    prompt: "a fluffy chick",
  });
  assert.equal(completed!.status, "completed");
  assert.equal(completed!.outputs.length, 2);
  assert.equal(completed!.created_at, new Date(1790583216 * 1000).toISOString());
  assert.equal(completed!.prompt!.length, 160);
  assert.ok(completed!.prompt!.endsWith("..."));
  assert.equal(completed!.error, undefined);
});

test("摘要容忍缺失字段：没有 result / requestBody / createdAt 也不抛", () => {
  const parsed = historyResponseSchema.parse({
    code: 200,
    data: { total: 1, items: [{ ID: "abc", model: "m", status: null }] },
  });
  assert.deepEqual(summarizeHistoryItem(parsed.data.items[0]!), {
    prediction_id: "abc",
    model: "m",
    status: "unknown",
    outputs: [],
  });
});
