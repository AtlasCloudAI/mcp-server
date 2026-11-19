import assert from "node:assert/strict";
import test from "node:test";
import { resolveUsageRange, spendByDay, usageRangeNotes } from "../src/tools/account.js";

const NOW = Date.parse("2026-11-11T04:36:00.000Z");

test("不填日期：最近 7 天，并且包含今天（end_date 不含，所以默认到明天）", () => {
  assert.deepEqual(resolveUsageRange(undefined, undefined, NOW), {
    start_date: "2026-11-05",
    end_date: "2026-11-12",
  });
  assert.deepEqual(resolveUsageRange(undefined, "2026-11-08", NOW), {
    start_date: "2026-11-01",
    end_date: "2026-11-08",
  });
  assert.deepEqual(resolveUsageRange("2026-11-01", "2026-11-03", NOW), {
    start_date: "2026-11-01",
    end_date: "2026-11-03",
  });
});

test("end_date 填成今天：提醒今天没算进去，并给出该填的日期（11-11 Claude G8）", () => {
  const notes = usageRangeNotes({ start_date: "2026-11-04", end_date: "2026-11-11" }, [], NOW);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /Today \(2026-11-11 UTC\) is not in this range/);
  assert.match(notes[0]!, /2026-11-12/);
});

test("范围包含今天时不提醒；今天的桶是 partial 时提醒还在累计", () => {
  assert.deepEqual(
    usageRangeNotes({ start_date: "2026-11-05", end_date: "2026-11-12" }, [{ partial: false }], NOW),
    []
  );
  const notes = usageRangeNotes(
    { start_date: "2026-11-05", end_date: "2026-11-12" },
    [{ partial: false }, { partial: true }],
    NOW
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /partial/);
});

test("只查过去的日子（整个范围在今天之前）也提醒今天不在范围里", () => {
  const notes = usageRangeNotes({ start_date: "2026-10-01", end_date: "2026-10-08" }, [], NOW);
  assert.match(notes[0]!, /not in this range/);
});

test("金额按天合计：分组时同一天各组相加，读不出金额的跳过", () => {
  const spend = spendByDay([
    {
      date: "2026-11-10",
      results: [
        { object: "model_cost.result", amount: { value: "0.984249", currency: "usd" } },
      ],
    },
    {
      date: "2026-11-11",
      results: [
        { object: "model_cost.result", model: "a", amount: { value: "0.018000", currency: "usd" } },
        { object: "model_cost.result", model: "b", amount: { value: "0.069000", currency: "usd" } },
        { object: "model_cost.result", model: "c" },
      ],
    },
    { date: "2026-11-09", results: [] },
  ]);
  assert.deepEqual(spend, [
    { date: "2026-11-10", amount: { value: "0.984249", currency: "usd" } },
    { date: "2026-11-11", amount: { value: "0.087000", currency: "usd" } },
  ]);
});
