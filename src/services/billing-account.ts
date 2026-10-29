import { z } from "zod";
import { balanceResponseSchema } from "../response-schemas.js";
import type { BalanceResponse } from "../types.js";
import { type ApiRequestOptions, publicApi } from "./api-client.js";

// 报价要写明从哪个账户扣费、余额多少（需求文档 6.1「计费账号：显示实际扣费账号及余额」）。
// 账户名和调用者来自 GET /public/v1/account（tasks:read，kubedl#789），余额来自
// /public/v1/balance（billing:read）。两个都尽力而为：后端还没有这个接口、令牌没有
// billing:read、超时，都只是少显示一项，报价照常返回。服务端这里查失败只是吞掉一个
// 上游错误，不会让客户端重新授权（scope 只按调用的工具检查）。

const accountResponseSchema = z
  .object({
    account: z
      .object({ id: z.string().optional(), name: z.string(), type: z.string().optional() })
      .passthrough(),
    user: z
      .object({ name: z.string().optional(), email: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

type AccountResponse = z.output<typeof accountResponseSchema>;

export interface BillingAccount {
  name: string;
  type?: string;
  user_name?: string;
  user_email?: string;
  /** 可用余额（美元）；没有 billing:read 或不是美元时没有。 */
  available_usd?: number;
}

/** 两个查询并行，各自最多等这么久：报价本身不能被它拖住。 */
const LOOKUP_TIMEOUT_MS = 3_000;

export async function billingAccount(
  options: { fetcher?: ApiRequestOptions["fetcher"] } = {}
): Promise<BillingAccount | undefined> {
  const common = {
    maxRetries: 0,
    timeout: LOOKUP_TIMEOUT_MS,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  };
  const [account, balance] = await Promise.all([
    publicApi<AccountResponse>("/account", { ...common, responseSchema: accountResponseSchema }).catch(
      () => undefined
    ),
    publicApi<BalanceResponse>("/balance", { ...common, responseSchema: balanceResponseSchema }).catch(
      () => undefined
    ),
  ]);
  // 个人账户在库里没有名字（实测 test 上 account.name 为空）：用户名、邮箱兜底，和授权页
  // 「Signed in as …」一致。
  const name =
    account?.account.name || balance?.account?.name || account?.user?.name || account?.user?.email;
  if (!name) return undefined;
  const type = account?.account.type || balance?.account?.type;
  const available = Number(balance?.available?.value);
  const usd = balance?.available?.currency.toLowerCase() === "usd" && Number.isFinite(available);
  return {
    name,
    ...(type ? { type } : {}),
    ...(account?.user?.name ? { user_name: account.user.name } : {}),
    ...(account?.user?.email ? { user_email: account.user.email } : {}),
    ...(usd ? { available_usd: available } : {}),
  };
}

function formatUsd(value: number): string {
  return value < 0 ? `-$${(-value).toFixed(2)}` : `$${value.toFixed(2)}`;
}

/** 报价文字里的一行：「Lovelace Studio (personal account, ada@example.com) · $8.50 available」。 */
export function describeBillingAccount(account: BillingAccount): string {
  const who = [account.type ? `${account.type} account` : null, account.user_email ?? null].filter(Boolean);
  return (
    `${account.name}${who.length > 0 ? ` (${who.join(", ")})` : ""}` +
    (account.available_usd !== undefined ? ` · ${formatUsd(account.available_usd)} available` : "")
  );
}
