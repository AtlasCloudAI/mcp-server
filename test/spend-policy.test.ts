import assert from "node:assert/strict";
import test from "node:test";
import {
  autoSubmitNotice,
  autoSubmitThresholdUsd,
  evaluateSpend,
  formatUsd,
} from "../src/services/spend-policy.js";

function quoteFetcher(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function withEnv(t: import("node:test").TestContext, vars: Record<string, string | undefined>) {
  const previous = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]])
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("阈值默认 20，写坏了退回 0（= 全部要确认）而不是放行", (t) => {
  withEnv(t, { MCP_AUTOSUBMIT_MAX_USD: undefined });
  assert.equal(autoSubmitThresholdUsd(), 20);

  // 一个配错的阈值绝不能把闸门开得更大。
  for (const bad of ["", "  ", "abc", "-1", "NaN"]) {
    process.env.MCP_AUTOSUBMIT_MAX_USD = bad;
    const value = autoSubmitThresholdUsd();
    assert.ok(value === 0 || value === 20, `${bad} → ${value}`);
    if (bad.trim() !== "") assert.equal(value, 0, `${bad} 应当退回 0`);
  }

  process.env.MCP_AUTOSUBMIT_MAX_USD = "0.5";
  assert.equal(autoSubmitThresholdUsd(), 0.5);
});

test("低于阈值直接提交", async (t) => {
  withEnv(t, { MCP_AUTOSUBMIT_MAX_USD: "20", ATLASCLOUD_API_KEY: "test-key" });
  const decision = await evaluateSpend(
    { model: "m", prompt: "p" },
    { fetcher: quoteFetcher({ code: 200, data: { price: "0.036", discount: 100 } }) }
  );
  assert.equal(decision.autoSubmit, true);
  assert.equal(decision.quotedUsd, 0.036);
});

test("等于或高于阈值仍然要确认", async (t) => {
  withEnv(t, { MCP_AUTOSUBMIT_MAX_USD: "20", ATLASCLOUD_API_KEY: "test-key" });
  // 边界取「大于等于」：正好 20 属于该拦的那一侧。
  for (const price of ["20", "20.0001", "35.5"]) {
    const decision = await evaluateSpend(
      {},
      { fetcher: quoteFetcher({ code: 200, data: { price } }) }
    );
    assert.equal(decision.autoSubmit, false, `${price} 不该直接提交`);
    assert.equal(decision.quotedUsd, Number.parseFloat(price));
  }
});

// 下面三条是同一件事的三种形态：拿不到可信报价时，"没能证明它便宜" 不等于
// "它便宜"。全部必须落到要确认那一侧。
test("报价接口失败时要确认", async (t) => {
  withEnv(t, { MCP_AUTOSUBMIT_MAX_USD: "20", ATLASCLOUD_API_KEY: "test-key" });
  const decision = await evaluateSpend(
    {},
    { fetcher: quoteFetcher({ message: "boom" }, 500) }
  );
  assert.equal(decision.autoSubmit, false);
  assert.equal(decision.quotedUsd, null);
  assert.match(decision.reason, /quote unavailable/);
});

test("报价里没有 price 字段时要确认", async (t) => {
  withEnv(t, { MCP_AUTOSUBMIT_MAX_USD: "20", ATLASCLOUD_API_KEY: "test-key" });
  const decision = await evaluateSpend(
    {},
    { fetcher: quoteFetcher({ code: 200, data: { discount: 100 } }) }
  );
  assert.equal(decision.autoSubmit, false);
  assert.match(decision.reason, /did not include a price/);
});

test("平台标了 estimate_partial 时要确认，哪怕数字很小", async (t) => {
  withEnv(t, { MCP_AUTOSUBMIT_MAX_USD: "20", ATLASCLOUD_API_KEY: "test-key" });
  // 参考视频没被探测到时报价是偏低的，真实扣费更高，这个数字不能用来过闸。
  const decision = await evaluateSpend(
    {},
    {
      fetcher: quoteFetcher({
        code: 200,
        data: { price: "0.5", estimated: true, estimate_partial: true },
      }),
    }
  );
  assert.equal(decision.autoSubmit, false);
  assert.match(decision.reason, /partial/);
});

test("阈值设为 0 时连报价都不发，直接回到全部确认", async (t) => {
  withEnv(t, { MCP_AUTOSUBMIT_MAX_USD: "0", ATLASCLOUD_API_KEY: "test-key" });
  let called = false;
  const decision = await evaluateSpend(
    {},
    {
      fetcher: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    }
  );
  assert.equal(decision.autoSubmit, false);
  assert.equal(called, false, "关掉之后不该再打报价接口");
});

test("不足一分钱的价格不被四舍五入成 $0.01", () => {
  assert.equal(formatUsd(0.009), "$0.0090");
  assert.equal(formatUsd(0.036), "$0.04");
  assert.equal(formatUsd(20), "$20.00");
});

test("直接提交时文案带上实际扣费，要求告知用户", () => {
  const notice = autoSubmitNotice({
    autoSubmit: true,
    quotedUsd: 0.036,
    thresholdUsd: 20,
    reason: "",
  });
  assert.match(notice, /\$0\.04/);
  assert.match(notice, /\$20\.00/);
  assert.match(notice, /Report this amount/);

  // 走确认流程的那次不该冒出这句。
  assert.equal(
    autoSubmitNotice({ autoSubmit: false, quotedUsd: 99, thresholdUsd: 20, reason: "" }),
    ""
  );
});
