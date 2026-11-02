import assert from "node:assert/strict";
import test from "node:test";
import { availableBalanceUsd, quoteBalanceNotice } from "../src/services/quote-balance.js";
import { handleError } from "../src/utils/error-handler.js";
import { ApiRequestError } from "../src/services/api-client.js";
import type { BalanceResponse } from "../src/types.js";

function balance(value: string, currency = "USD"): () => Promise<BalanceResponse> {
  return async () => ({ object: "balance", scope: "self", available: { value, currency } });
}

test("报价余额：够用时报余额和生成后大约剩多少", async () => {
  const line = await quoteBalanceNotice(0.26, balance("12.50"));
  assert.match(line, /\$12\.50 available, enough for this estimate/);
  assert.match(line, /about \$12\.24 left afterwards/);
});

test("报价余额：不够时说清会失败，并给充值页和降档两条路", async () => {
  const line = await quoteBalanceNotice(3.24, balance("1.00"));
  assert.match(line, /less than this estimate/);
  assert.match(line, /atlascloud\.ai\/console\/billing/);
  assert.match(line, /cheaper model/);
});

test("报价余额：没有可比总价时只报余额", async () => {
  assert.equal(await quoteBalanceNotice(null, balance("5")), "- **Balance**: $5.00 available.");
});

test("报价余额：读不到（无权限、超时）、非美元、非数字都不显示，也不抛错", async () => {
  const denied = async () => {
    throw new ApiRequestError("insufficient_scope", 403);
  };
  assert.equal(await quoteBalanceNotice(0.26, denied), "");
  assert.equal(await quoteBalanceNotice(0.26, balance("9", "CNY")), "");
  assert.equal(await quoteBalanceNotice(0.26, balance("abc")), "");
  assert.equal(await availableBalanceUsd(async () => ({ object: "balance", scope: "self" })), null);
});

test("报价余额：可以用环境变量关掉", async (t) => {
  const prev = process.env.MCP_QUOTE_BALANCE_ENABLED;
  process.env.MCP_QUOTE_BALANCE_ENABLED = "false";
  t.after(() => {
    if (prev === undefined) delete process.env.MCP_QUOTE_BALANCE_ENABLED;
    else process.env.MCP_QUOTE_BALANCE_ENABLED = prev;
  });
  assert.equal(await quoteBalanceNotice(0.26, balance("12.50")), "");
});

test("接口不收插件令牌时，不让用户去重新授权", () => {
  const scoped = handleError(
    new ApiRequestError("this endpoint does not accept scoped access tokens", 401)
  );
  assert.match(scoped, /does not accept plugin sign-in yet/);
  assert.doesNotMatch(scoped, /Reauthenticate/);
  const expired = handleError(new ApiRequestError("access token expired", 401));
  assert.match(expired, /invalid or expired/);
});
