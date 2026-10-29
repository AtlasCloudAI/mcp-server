import assert from "node:assert/strict";
import test from "node:test";
import {
  autoSubmitNotice,
  autoSubmitThresholdUsd,
  confirmationCostNotice,
  confirmationReuseNotice,
  confirmationValidityNotice,
  confirmationValidSeconds,
  evaluateSpend,
  formatUsd,
  generationAutoSubmitThresholdUsd,
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
  withEnv(t, { MCP_GENERATION_AUTOSUBMIT_MAX_USD: "20", ATLASCLOUD_API_KEY: "test-key" });
  const decision = await evaluateSpend(
    { model: "m", prompt: "p" },
    { fetcher: quoteFetcher({ code: 200, data: { price: "0.036", discount: 100 } }) }
  );
  assert.equal(decision.autoSubmit, true);
  assert.equal(decision.quotedUsd, 0.036);
});

test("等于或高于阈值仍然要确认", async (t) => {
  withEnv(t, { MCP_GENERATION_AUTOSUBMIT_MAX_USD: "20", ATLASCLOUD_API_KEY: "test-key" });
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
  withEnv(t, { MCP_GENERATION_AUTOSUBMIT_MAX_USD: "20", ATLASCLOUD_API_KEY: "test-key" });
  const decision = await evaluateSpend(
    {},
    { fetcher: quoteFetcher({ message: "boom" }, 500) }
  );
  assert.equal(decision.autoSubmit, false);
  assert.equal(decision.quotedUsd, null);
  assert.match(decision.reason, /quote unavailable/);
});

test("报价里没有 price 字段时要确认", async (t) => {
  withEnv(t, { MCP_GENERATION_AUTOSUBMIT_MAX_USD: "20", ATLASCLOUD_API_KEY: "test-key" });
  const decision = await evaluateSpend(
    {},
    { fetcher: quoteFetcher({ code: 200, data: { discount: 100 } }) }
  );
  assert.equal(decision.autoSubmit, false);
  assert.match(decision.reason, /did not include a price/);
});

test("平台标了 estimate_partial 时要确认，哪怕数字很小", async (t) => {
  withEnv(t, { MCP_GENERATION_AUTOSUBMIT_MAX_USD: "20", ATLASCLOUD_API_KEY: "test-key" });
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

test("生成类阈值为 0 时仍然拿实时报价，但一律要用户确认", async (t) => {
  withEnv(t, { MCP_GENERATION_AUTOSUBMIT_MAX_USD: "0", ATLASCLOUD_API_KEY: "test-key" });
  const decision = await evaluateSpend(
    { model: "m", prompt: "p" },
    { fetcher: quoteFetcher({ code: 200, data: { price: "0.22" } }) }
  );
  assert.equal(decision.autoSubmit, false);
  assert.equal(decision.quotedUsd, 0.22, "确认里要能给出这次的真实价格");
  assert.match(confirmationCostNotice(decision), /\$0\.22.*confirmed with the user/);
});

test("生成类阈值为 0 且报价失败：照样要确认，价格标为未知", async (t) => {
  withEnv(t, { MCP_GENERATION_AUTOSUBMIT_MAX_USD: "0", ATLASCLOUD_API_KEY: "test-key" });
  const decision = await evaluateSpend({}, { fetcher: quoteFetcher({ message: "boom" }, 500) });
  assert.equal(decision.autoSubmit, false);
  assert.equal(decision.quotedUsd, null);
});

test("生成类默认每次确认；对话保留 20 美元的自动上限", (t) => {
  withEnv(t, { MCP_GENERATION_AUTOSUBMIT_MAX_USD: undefined, MCP_AUTOSUBMIT_MAX_USD: undefined });
  assert.equal(generationAutoSubmitThresholdUsd(), 0);
  assert.equal(autoSubmitThresholdUsd(), 20);
  for (const bad of ["abc", "-1", "NaN"]) {
    process.env.MCP_GENERATION_AUTOSUBMIT_MAX_USD = bad;
    assert.equal(generationAutoSubmitThresholdUsd(), 0, `${bad} 应当退回 0`);
  }
  process.env.MCP_GENERATION_AUTOSUBMIT_MAX_USD = "5";
  assert.equal(generationAutoSubmitThresholdUsd(), 5);
});

test("不足一分钱的价格不被四舍五入成 $0.01", () => {
  assert.equal(formatUsd(0.009), "$0.0090");
  assert.equal(formatUsd(0.0000221), "$0.000022");
  assert.equal(formatUsd(0.0000058), "$0.0000058");
  assert.equal(formatUsd(0.000001), "$0.0000010");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.036), "$0.04");
  assert.equal(formatUsd(20), "$20.00");
});

test("直接提交时文案给的是预估、不是已扣费，且要求告知用户", () => {
  const notice = autoSubmitNotice({
    autoSubmit: true,
    quotedUsd: 0.036,
    thresholdUsd: 20,
    reason: "",
  });
  assert.match(notice, /\$0\.04/);
  assert.match(notice, /\$20\.00/);
  assert.match(notice, /Give the user this estimate/);
  // 异步任务失败不计费，所以这句永远不能说成已经扣掉了。
  assert.match(notice, /not a settled charge/);
  assert.ok(!/\*\*Charge\*\*/.test(notice), "不能再叫 Charge —— 会被当成已扣费");

  // 走确认流程的那次不该冒出这句。
  assert.equal(
    autoSubmitNotice({ autoSubmit: false, quotedUsd: 99, thresholdUsd: 20, reason: "" }),
    ""
  );
});

test("报价有效期说成时长，不给绝对时间，并要求模型照样回传令牌", () => {
  const now = Date.parse("2026-10-20T02:35:30Z");
  const expiresAt = "2026-10-20T03:35:30.000Z";
  assert.equal(confirmationValidSeconds(expiresAt, now), 3600);
  const notice = confirmationValidityNotice(expiresAt, now);
  assert.match(notice, /about 60 minutes/);
  assert.match(notice, /send the confirmation_token back/);
  assert.doesNotMatch(notice, /2026|Z\b|UTC/);
  // 已过期也不出负数
  assert.equal(confirmationValidSeconds(expiresAt, now + 2 * 3600_000), 0);
});

test("工具总说明不再说低于限额直接提交、不要自己加确认", async () => {
  const { createAtlasCloudServer } = await import("../src/server.js");
  const server = createAtlasCloudServer("remote") as unknown as { server: { _instructions?: string } };
  const instructions = String(server.server._instructions ?? "");
  assert.match(instructions, /quote before anything runs/);
  assert.match(instructions, /do not judge expiry from a clock/);
  assert.doesNotMatch(instructions, /Do not add a confirmation step of your own/);
  assert.doesNotMatch(instructions, /submits it straight away and reports the amount/);
  // 「别自己用 curl 调 REST、没有 API key」从工具描述挪到了这里。
  assert.match(instructions, /do not call the Atlas REST API directly/);
});

test("报价里写出本次的幂等键，要求确认时原样传回", () => {
  const notice = confirmationReuseNotice("8d66f088-d57c-42f7-b899-44eef0d7717a");
  assert.match(notice, /8d66f088-d57c-42f7-b899-44eef0d7717a/);
  assert.match(notice, /send this exact value back/);
  assert.match(notice, /do not generate a new one/);
});

test("报价带上预估原因和漏掉的部分，确认文字说清楚", async (t) => {
  withEnv(t, { MCP_GENERATION_AUTOSUBMIT_MAX_USD: undefined, ATLASCLOUD_API_KEY: "test-key" });
  const settles = await evaluateSpend(
    {},
    { fetcher: quoteFetcher({ code: 200, data: { price: "1.5", estimated: true, estimate_reason: "settles_on_usage" } }) }
  );
  assert.equal(settles.estimateReason, "settles_on_usage");
  assert.match(confirmationCostNotice(settles), /\$1\.50 for these exact parameters.*settled on what the job actually uses/);

  const partial = await evaluateSpend(
    {},
    {
      fetcher: quoteFetcher({
        code: 200,
        data: {
          price: "0.5",
          estimated: true,
          estimate_partial: true,
          estimate_reason: "settles_on_usage",
          estimate_missing: ["reference_video_duration"],
        },
      }),
    }
  );
  assert.deepEqual(partial.estimateMissing, ["reference_video_duration"]);
  assert.match(confirmationCostNotice(partial), /at least \$0\.50 .*not included: the reference videos' length/);

  // 老网关不给这两个字段：文字和以前一样。
  const plain = await evaluateSpend({}, { fetcher: quoteFetcher({ code: 200, data: { price: "0.2" } }) });
  assert.equal(plain.estimateReason, undefined);
  assert.doesNotMatch(confirmationCostNotice(plain), /settled/);
});
