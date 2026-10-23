import { BILLING_URL } from "../constants.js";
import { balanceResponseSchema } from "../response-schemas.js";
import type { BalanceResponse } from "../types.js";
import { publicApi } from "./api-client.js";
import { formatUsd } from "./spend-policy.js";

/**
 * 报价时顺带告诉用户余额够不够。
 *
 * 以前报价只有价格：用户确认后才发现余额不够，提交失败，再充值、再报价、再确认。
 * 竞品在报价里直接列余额和「生成后预计余额」（2026-10-23 ChatGPT 实测），
 * 用户在确认前就知道要不要先充值。
 *
 * 只是一行提示，不是闸：读余额要 billing:read，插件令牌未必带；接口慢或报错也一样。
 * 任何失败都返回空串，报价照常给出，绝不因为读不到余额拖住或打断报价。
 */

export type BalanceFetcher = () => Promise<BalanceResponse>;

const BALANCE_TIMEOUT_MS = 1500;

function enabled(): boolean {
  const raw = process.env.MCP_QUOTE_BALANCE_ENABLED;
  if (raw === undefined || raw.trim() === "") return true;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

const defaultFetcher: BalanceFetcher = () =>
  publicApi<BalanceResponse>("/balance", {
    responseSchema: balanceResponseSchema,
    timeout: BALANCE_TIMEOUT_MS,
    maxRetries: 0,
  });

/** 可用余额（美元）；读不到、不是美元或不是数字都返回 null。 */
export async function availableBalanceUsd(
  fetchBalance: BalanceFetcher = defaultFetcher
): Promise<number | null> {
  try {
    const res = await fetchBalance();
    const value = res.available?.value;
    const currency = res.available?.currency;
    if (value === undefined) return null;
    if (currency && currency.toUpperCase() !== "USD") return null;
    const amount = Number.parseFloat(value);
    return Number.isFinite(amount) ? amount : null;
  } catch {
    return null;
  }
}

/**
 * 报价文字里的余额那一行（不带结尾换行）；不该显示时返回空串。
 * estimateUsd 为 null 表示这次报价没有可比的总价，只报余额本身。
 */
export async function quoteBalanceNotice(
  estimateUsd: number | null,
  fetchBalance: BalanceFetcher = defaultFetcher
): Promise<string> {
  if (!enabled()) return "";
  const available = await availableBalanceUsd(fetchBalance);
  if (available === null) return "";
  if (estimateUsd === null) {
    return `- **Balance**: ${formatUsd(available)} available.`;
  }
  if (available >= estimateUsd) {
    return `- **Balance**: ${formatUsd(available)} available, enough for this estimate (about ${formatUsd(Math.max(0, available - estimateUsd))} left afterwards).`;
  }
  return (
    `- **Balance**: ${formatUsd(available)} available, less than this estimate, so the job would fail for insufficient balance. ` +
    `Tell the user before they confirm: they can top up at ${BILLING_URL}, or choose a cheaper model or a shorter, lower-resolution output.`
  );
}
