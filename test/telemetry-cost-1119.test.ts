import assert from "node:assert/strict";
import test from "node:test";
import { chargeTelemetry, telemetryUsd, ToolCallTelemetry } from "../src/services/tool-call-telemetry.js";
import { evaluateSpend } from "../src/services/spend-policy.js";
import { runWithRequestContext } from "../src/services/request-context.js";

// 11-19：生产看板要能看到 MCP 带来的钱。报价那次带预估总价，查结果那次带结算状态和实扣金额。

test("USD amounts are finite, non-negative and rounded to micro-dollars", () => {
  assert.equal(telemetryUsd(0.003), 0.003);
  assert.equal(telemetryUsd(0.1 + 0.2), 0.3);
  assert.equal(telemetryUsd(1.23456789), 1.234568);
  assert.equal(telemetryUsd(0), 0);
  assert.equal(telemetryUsd(-1), undefined);
  assert.equal(telemetryUsd(Number.NaN), undefined);
  assert.equal(telemetryUsd(Number.POSITIVE_INFINITY), undefined);
  assert.equal(telemetryUsd("0.5"), undefined);
  assert.equal(telemetryUsd(null), undefined);
});

test("a settled charge reports its amount; unsettled or unknown never reads as $0", () => {
  assert.deepEqual(chargeTelemetry("charged", 0.015), { charge_status: "charged", charged_usd: 0.015 });
  assert.deepEqual(chargeTelemetry("partially_charged", 0.1408), {
    charge_status: "partially_charged",
    charged_usd: 0.1408,
  });
  assert.deepEqual(chargeTelemetry("not_charged", 0.5), { charge_status: "not_charged", charged_usd: 0 });
  assert.deepEqual(chargeTelemetry("refunded", 0.5), { charge_status: "refunded", charged_usd: 0 });
  // 还没结算：只报状态
  assert.deepEqual(chargeTelemetry("pending", 0.5), { charge_status: "pending" });
  // 结算了但价格读不出：只报状态，不报 0
  assert.deepEqual(chargeTelemetry("charged", undefined), { charge_status: "charged" });
  // 老网关没有 charge_status：什么都不报
  assert.deepEqual(chargeTelemetry(undefined, 0.5), {});
});

test("cost fields ride along on the event and only as numbers", () => {
  const call = new ToolCallTelemetry("atlas_get_prediction", 0);
  call.annotate({ execution_mode: "get", stage: "fetch", generation_status: "completed", task_hash: "0123456789abcdef" });
  call.annotate(chargeTelemetry("charged", 0.003));
  const props = call.properties({ product: "atlas-mcp" }, 200, { now: 10 });
  assert.equal(props.charge_status, "charged");
  assert.equal(props.charged_usd, 0.003);
  assert.equal(props.is_error, false);
});

test("a generation quote puts its estimated total on the tool call", async () => {
  const quoteFetcher = (async () =>
    new Response(JSON.stringify({ code: 200, data: { price: "0.003", currency: "USD" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const call = new ToolCallTelemetry("atlas_generate_image", 0);
  const decision = await runWithRequestContext({ toolCall: call, atlasApiKey: "test-atlas-key" } as never, () =>
    evaluateSpend({ model: "black-forest-labs/flux-schnell", prompt: "a duck" }, { fetcher: quoteFetcher })
  );
  const props = call.properties({ product: "atlas-mcp" }, 200, { now: 1 });
  assert.equal(decision.quotedUsd, 0.003);
  assert.equal(props.estimated_cost_usd, 0.003);
  assert.equal(props.estimate_partial, undefined);
});
