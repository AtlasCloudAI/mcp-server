import { type HistoryResponse, historyResponseSchema, type PredictionResponse } from "../response-schemas.js";
import { api, type ApiRequestOptions } from "./api-client.js";
import { asRecord } from "./json-record.js";
import { isFinished } from "./prediction-wait.js";

/** 往前翻多少条找这一单：按 ID 查的一般是刚做完或最近做的。 */
const HISTORY_LOOKUP_SIZE = 20;
const HISTORY_LOOKUP_TIMEOUT_MS = 4_000;

/**
 * 历史接口 billing → 查结果接口那套 price / charge_status。paymentStatus 的含义和
 * tools/predictions.ts 的 chargedUsd 一致（kubedl dmo.ModelBillingPaymentStatus*）：
 * 2 已付、4 部分付；3 已退款（amount 是退回去的那笔）；1 未付是还没结算。老后端不给 paymentStatus 时按 amount。
 */
export function chargeFromBilling(billingRaw: unknown): { price?: number; charge_status: string } | undefined {
  const billing = asRecord(billingRaw);
  if (!billing) return undefined;
  const raw = billing.amount;
  const amount = typeof raw === "string" ? Number.parseFloat(raw) : typeof raw === "number" ? raw : NaN;
  const status = typeof billing.paymentStatus === "number" ? billing.paymentStatus : undefined;
  if (status === 1) return { charge_status: "pending" };
  if (status === 3) return { charge_status: "refunded" };
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  if (status === 4) return { price: amount, charge_status: "partially_charged" };
  if (status === undefined || status === 0 || status === 2) {
    return amount > 0 ? { price: amount, charge_status: "charged" } : { price: 0, charge_status: "not_charged" };
  }
  return undefined;
}

/**
 * 查结果接口对工作流（atlascloud/studio/*）单不给 price、charge_status（11-18 test 实测：Image ads
 * 75672d70… 按 ID 查只有状态和产出，普通模型的单两样都有）。结果是 get_prediction 写不出实扣，WorkBuddy
 * 的模型说「未显示扣费」、ChatGPT 说「Actual charge: Not reported」，列表里却记着 $0.2593 / $0.1408。
 *
 * 已经结束、两样都没有时，到 /model/history 里按这一单的 ID 找账单补上；找不到、查不动就原样返回，
 * 不耽误查结果本身。只补缺的：接口给了的一律以接口为准。
 */
export async function withRecordedCharge(
  predictionId: string,
  result: PredictionResponse,
  options: { fetcher?: ApiRequestOptions["fetcher"] } = {}
): Promise<PredictionResponse> {
  const data = result.data as Record<string, unknown> | undefined;
  if (!data || !isFinished(String(data.status ?? ""))) return result;
  if (data.price !== undefined && data.price !== null && data.price !== "") return result;
  if (typeof data.charge_status === "string" && data.charge_status) return result;
  const model = typeof data.model === "string" && data.model ? data.model : undefined;
  try {
    const history = await api<HistoryResponse>("/model/history", {
      params: { no: 1, size: HISTORY_LOOKUP_SIZE, ...(model ? { model } : {}) },
      responseSchema: historyResponseSchema,
      timeout: HISTORY_LOOKUP_TIMEOUT_MS,
      maxRetries: 0,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    const item = history.data.items.find((entry) => entry.ID === predictionId) as Record<string, unknown> | undefined;
    const charge = item ? chargeFromBilling(item.billing) : undefined;
    if (!charge) return result;
    return {
      ...result,
      data: {
        ...result.data,
        ...(charge.price !== undefined ? { price: charge.price } : {}),
        charge_status: charge.charge_status,
      },
    } as PredictionResponse;
  } catch (error) {
    console.error(`[recorded-charge] history lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
}
