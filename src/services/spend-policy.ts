import { createHash } from "node:crypto";
import { z } from "zod";
import { generationApi, type ApiRequestOptions } from "./api-client.js";
import { getRequestContext } from "./request-context.js";
import { InMemoryUploadTicketStore } from "./upload-ticket-store.js";
import { schemaDefaults } from "../utils/schema-validator.js";
import type { Model, PromptThresholdPrice } from "../types.js";

// Every billable tool used to stop after the first call and wait for the user to
// confirm a quote, without exception. For a $0.009 image that is the wrong trade:
// the confirmation round-trip costs more attention than the generation costs
// money, and a small batch turns into a conversation about prices.
//
// So the product rule is a threshold: below it, submit and report what it cost;
// at or above it, quote and stop. The threshold is deliberately high — the point
// is to catch the genuinely expensive job, not to police routine work.
//
// The number we compare against has to be a real quote, not arithmetic on catalog
// metadata. ModelPrice carries unit prices only, and its own `base_price` is
// labelled "NOT an estimated total" — for a per-second video model there is no
// way to get from that to a total without guessing the billing unit. The platform
// already computes the real figure at /model/calculate, including the duration and
// resolution derivation for token-postpaid video, so ask it.

const numericSchema = z.union([z.string(), z.number()]).transform((value) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
});

const calculateResponseSchema = z.preprocess(
  (response) => {
    if (
      response &&
      typeof response === "object" &&
      "code" in response &&
      "data" in response
    ) {
      return (response as { data: unknown }).data;
    }
    return response;
  },
  z
    .object({
      price: numericSchema.nullable().optional(),
      origin_price: numericSchema.nullable().optional(),
      // Set when the figure is derived from duration/resolution rather than a
      // flat catalog price.
      estimated: z.boolean().optional(),
      // Set when the derivation could not see everything it needed — reference
      // videos it was not allowed to probe, for instance. The true cost is then
      // higher than what came back, so the number cannot clear a threshold.
      estimate_partial: z.boolean().optional(),
      // Why the figure is an estimate ("settles_on_usage": billed on what the job
      // actually used) and, for a partial one, what it left out
      // ("reference_video_duration"). aiproxy#1074; older gateways omit both.
      estimate_reason: z.string().optional(),
      estimate_missing: z.array(z.string()).optional(),
    })
    .passthrough()
);

export interface SpendDecision {
  /** Submit without waiting for the user. */
  autoSubmit: boolean;
  /** Quoted charge in USD, or null when the platform would not give one. */
  quotedUsd: number | null;
  /** Threshold in force, for the message shown to the user. */
  thresholdUsd: number;
  /** Why it went the way it did. Diagnostic, not shown verbatim. */
  reason: string;
  /** The platform flagged the quote as incomplete: the real charge is higher. */
  partial?: boolean;
  /** Why the quote is an estimate, as the platform put it. */
  estimateReason?: string;
  /** What a partial quote left out. */
  estimateMissing?: string[];
  /** Set when the per-request limit passed but the user's daily auto-run budget did not. */
  dailyBudget?: { budgetUsd: number; usedUsd: number };
}

export interface Quote {
  usd: number | null;
  partial: boolean;
  reason?: string;
  missing?: string[];
}

/**
 * Ask the platform what this exact request would cost. Throws when the quote
 * endpoint fails; callers decide whether that is fatal.
 */
export async function fetchQuote(
  requestBody: unknown,
  options: { fetcher?: ApiRequestOptions["fetcher"] } = {}
): Promise<Quote> {
  const quote: z.output<typeof calculateResponseSchema> = await generationApi("/model/calculate", {
    method: "POST",
    body: requestBody,
    responseSchema: calculateResponseSchema,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  return {
    usd: quote.price ?? null,
    partial: quote.estimate_partial === true,
    ...(quote.estimate_reason ? { reason: quote.estimate_reason } : {}),
    ...(quote.estimate_missing?.length ? { missing: quote.estimate_missing } : {}),
  };
}

function estimateDetails(quote: Quote | null): Pick<SpendDecision, "estimateReason" | "estimateMissing"> {
  return {
    ...(quote?.reason ? { estimateReason: quote.reason } : {}),
    ...(quote?.missing ? { estimateMissing: quote.missing } : {}),
  };
}

/**
 * Auto-submit limit for image, video, audio and workflow generation.
 *
 * Defaults to 0: every generation stops first and shows the user the model and its
 * live price, and runs only after an explicit yes. Product decision of 2026-10-19,
 * after testers found jobs had started — and been billed — before they knew which
 * model was used or what it cost. MCP_GENERATION_AUTOSUBMIT_MAX_USD raises it.
 * atlas_chat keeps its own limit (autoSubmitThresholdUsd): a per-message
 * confirmation would make chat unusable.
 */
export function generationAutoSubmitThresholdUsd(): number {
  const raw = process.env.MCP_GENERATION_AUTOSUBMIT_MAX_USD;
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Per-request auto-run limit for atlas_chat (worst-case bound, not the real charge).
 *
 * Was $20. A prompt-injected agent can call atlas_chat in a loop, and every call
 * under the limit ran without the user seeing anything (11-16 security review M1).
 * $1 still covers ordinary chat — its real cost is usually cents — and anything
 * bigger stops for a confirmation. MCP_AUTOSUBMIT_MAX_USD overrides it.
 */
export function autoSubmitThresholdUsd(): number {
  const raw = process.env.MCP_AUTOSUBMIT_MAX_USD;
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number.parseFloat(raw);
  // A malformed threshold must not silently widen the gate. Fall back to
  // confirming everything, which is the behaviour this replaced.
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Decide whether this request can be submitted without a confirmation round-trip.
 *
 * Fails closed on every uncertainty — a quote we could not obtain, a quote the
 * platform flagged as incomplete, a non-numeric price. "We could not establish
 * that this costs less than the threshold" is not the same as "it is cheap", and
 * the whole point of the gate is the expensive case.
 */
export async function evaluateSpend(
  requestBody: unknown,
  options: { fetcher?: ApiRequestOptions["fetcher"] } = {}
): Promise<SpendDecision> {
  const thresholdUsd = generationAutoSubmitThresholdUsd();
  if (thresholdUsd <= 0) {
    // Every generation is confirmed with the user. Still fetch the live quote so the
    // confirmation shows the real price for these parameters, not "unknown".
    let quote: Quote | null = null;
    try {
      quote = await fetchQuote(requestBody, options);
    } catch {
      quote = null;
    }
    return {
      autoSubmit: false,
      quotedUsd: quote?.usd ?? null,
      thresholdUsd,
      ...(quote?.partial ? { partial: true } : {}),
      ...estimateDetails(quote),
      reason: "every generation is confirmed with the user",
    };
  }

  let quote: Quote;
  try {
    quote = await fetchQuote(requestBody, options);
  } catch (error) {
    return {
      autoSubmit: false,
      quotedUsd: null,
      thresholdUsd,
      reason: `quote unavailable: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }

  const quotedUsd = quote.usd;
  if (quotedUsd === null) {
    return {
      autoSubmit: false,
      quotedUsd: null,
      thresholdUsd,
      reason: "quote did not include a price",
    };
  }
  if (quote.partial) {
    return {
      autoSubmit: false,
      quotedUsd,
      thresholdUsd,
      partial: true,
      ...estimateDetails(quote),
      reason: "quote is partial, the real charge is higher",
    };
  }
  if (quotedUsd >= thresholdUsd) {
    return {
      autoSubmit: false,
      quotedUsd,
      thresholdUsd,
      ...estimateDetails(quote),
      reason: "quote is at or above the threshold",
    };
  }
  return {
    autoSubmit: true,
    quotedUsd,
    thresholdUsd,
    ...estimateDetails(quote),
    reason: "quote is below the threshold",
  };
}

// ---- 对话（按 token 计费）----
//
// /model/calculate 不给文本模型报价（按 token 计费，提交前不知道会输出多少），所以对话
// 的闸门用本地算的「最坏情况」：输入按 UTF-8 字节数算 token（字节级 BPE 每个字节至多
// 一个 token，只会高估），输出按 max_tokens，没给就按模型的最大输出；单价取所有阶梯里
// 最贵的一档（含缓存写入价）。高估只会让闸门更早要求确认，不会让贵的请求漏过去。

export interface ChatRequestShape {
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
}

/** 每条消息在内容之外还有角色、分隔符等开销，按 16 个 token 留足。 */
const CHAT_MESSAGE_OVERHEAD_TOKENS = 16;

function parseRate(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function tiersOf(model: Model): PromptThresholdPrice[] {
  const actual = model.price?.actual;
  if (!actual) return [];
  return [actual, ...(actual.prompt_thresholds ?? [])];
}

/** 输入、输出每百万 token 的最高单价；缺任何一个都返回 null（拿不准就不自动提交）。 */
function worstCaseRates(model: Model): { input: number; output: number } | null {
  let input: number | null = null;
  let output: number | null = null;
  for (const tier of tiersOf(model)) {
    for (const rate of [parseRate(tier.input_price), parseRate(tier.cache_creation_price)]) {
      if (rate !== null) input = Math.max(input ?? 0, rate);
    }
    const out = parseRate(tier.output_price);
    if (out !== null) output = Math.max(output ?? 0, out);
  }
  return input === null || output === null ? null : { input, output };
}

export function chatInputTokenUpperBound(request: ChatRequestShape): number {
  return request.messages.reduce(
    (sum, message) => sum + Buffer.byteLength(message.content, "utf8") + CHAT_MESSAGE_OVERHEAD_TOKENS,
    0
  );
}

/** 这次对话最多花多少钱（美元）；单价或输出上限不明时返回 null。 */
export function chatWorstCaseUsd(model: Model, request: ChatRequestShape): number | null {
  const rates = worstCaseRates(model);
  const outputTokens = request.max_tokens ?? model.maxCompletionTokens ?? model.contextLength;
  if (!rates || outputTokens === undefined) return null;
  return (chatInputTokenUpperBound(request) * rates.input + outputTokens * rates.output) / 1_000_000;
}

/**
 * 对话的花费闸门，规则与生成工具相同：低于自动提交上限就直接调用，达到上限或算不出
 * 上限就停下来等确认。quotedUsd 是上限，不是实际花费（实际按用量算，通常小几个数量级）。
 */
export function evaluateChatSpend(model: Model, request: ChatRequestShape): SpendDecision {
  const thresholdUsd = autoSubmitThresholdUsd();
  if (thresholdUsd <= 0) {
    return { autoSubmit: false, quotedUsd: null, thresholdUsd, reason: "auto-submit disabled" };
  }
  const worst = chatWorstCaseUsd(model, request);
  if (worst === null) {
    return { autoSubmit: false, quotedUsd: null, thresholdUsd, reason: "per-token rates or output limit unavailable" };
  }
  if (worst >= thresholdUsd) {
    return { autoSubmit: false, quotedUsd: worst, thresholdUsd, reason: "worst-case cost is at or above the threshold" };
  }
  return { autoSubmit: true, quotedUsd: worst, thresholdUsd, reason: "worst-case cost is below the threshold" };
}

// ---- 对话自动执行的每日额度 ----
//
// 单次上限只管一次调用。被注入的 agent 可以一次次调 atlas_chat，每次都在上限以下，用户一次确认
// 都看不到（11-16 安全审查 M1）。所以每个用户每天（UTC）自动执行的花费再记一笔总账，超过就和
// 单次超限一样停下来要确认。记账按实际用量；算不出实际用量时按最坏情况记。存储和报价记录同一个
// （有 Redis 时多副本共用）；读不出来时按「已经用完」处理，宁可多问一次。

const DEFAULT_DAILY_AUTO_SUBMIT_USD = 5;
const AUTO_SPEND_TTL_SECONDS = 26 * 3600;
const AUTO_SPEND_STORE_TIMEOUT_MS = 800;
const localAutoSpend = new InMemoryUploadTicketStore();

/** 每个用户每天自动执行的总额度（美元）。MCP_AUTOSUBMIT_DAILY_MAX_USD 覆盖；写坏了按 0（全部要确认）。 */
export function dailyAutoSubmitBudgetUsd(): number {
  const raw = process.env.MCP_AUTOSUBMIT_DAILY_MAX_USD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_AUTO_SUBMIT_USD;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function autoSpendKey(now: Date): string {
  const subject = getRequestContext()?.subject ?? "stdio";
  const digest = createHash("sha256").update(subject).digest("hex");
  return `auto-spend:${digest}:${now.toISOString().slice(0, 10)}`;
}

function autoSpendStore() {
  return getRequestContext()?.quoteStore ?? localAutoSpend;
}

function withStoreTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("auto-spend store timed out")), AUTO_SPEND_STORE_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** 今天已经自动执行了多少（美元）；存储出错时返回 Infinity（按用完处理）。 */
export async function autoSpentTodayUsd(now: Date = new Date()): Promise<number> {
  try {
    const raw = await withStoreTimeout(autoSpendStore().get(autoSpendKey(now)));
    if (!raw) return 0;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
  } catch (error) {
    console.error(`[auto-spend] read failed: ${error instanceof Error ? error.message : String(error)}`);
    return Number.POSITIVE_INFINITY;
  }
}

/** 自动执行完一次，把花费记进今天的总账。并发时可能少记一点，额度本来就是兜底。 */
export async function recordAutoSpend(usd: number, now: Date = new Date()): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  try {
    const store = autoSpendStore();
    const key = autoSpendKey(now);
    const current = Number.parseFloat((await withStoreTimeout(store.get(key))) ?? "0");
    const next = (Number.isFinite(current) && current > 0 ? current : 0) + usd;
    await withStoreTimeout(store.put(key, String(next), AUTO_SPEND_TTL_SECONDS));
  } catch (error) {
    console.error(`[auto-spend] write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 单次闸门放行之后再过每日额度：今天已用 + 这次最坏情况超过额度，就改成要确认。
 * 不放行的决定原样返回。
 */
export async function applyDailyAutoSubmitBudget(decision: SpendDecision): Promise<SpendDecision> {
  if (!decision.autoSubmit || decision.quotedUsd === null) return decision;
  const budgetUsd = dailyAutoSubmitBudgetUsd();
  const usedUsd = await autoSpentTodayUsd();
  if (usedUsd + decision.quotedUsd <= budgetUsd) return decision;
  return {
    ...decision,
    autoSubmit: false,
    dailyBudget: { budgetUsd, usedUsd },
    reason: "daily auto-run budget reached",
  };
}

/** 按实际用量算这次对话的花费：输入超过阶梯门槛就用那一档的单价。 */
export function chatUsageCostUsd(
  model: Model,
  usage: { prompt_tokens: number; completion_tokens: number }
): number | null {
  const actual = model.price?.actual;
  if (!actual) return null;
  let tier: PromptThresholdPrice = actual;
  for (const candidate of actual.prompt_thresholds ?? []) {
    if (typeof candidate.threshold === "number" && usage.prompt_tokens > candidate.threshold) {
      if (typeof tier.threshold !== "number" || candidate.threshold > tier.threshold) tier = candidate;
    }
  }
  const input = parseRate(tier.input_price) ?? parseRate(actual.input_price);
  const output = parseRate(tier.output_price) ?? parseRate(actual.output_price);
  if (input === null || output === null) return null;
  return (usage.prompt_tokens * input + usage.completion_tokens * output) / 1_000_000;
}

export function formatUsd(amount: number): string {
  // Sub-cent prices are normal here, so do not round them away to $0.01. A short
  // chat costs millionths of a dollar: keep two significant digits rather than
  // printing $0.0000.
  if (amount > 0 && amount < 0.0001) {
    return `$${amount.toFixed(Math.min(10, 1 - Math.floor(Math.log10(amount))))}`;
  }
  // 一美元以下保留到 4 位小数再去掉末尾的 0：$0.072 不能写成 $0.07，模型会照着报给用户
  // （11-04 WorkBuddy 复测）。一美元以上照旧两位。
  if (amount > 0 && amount < 1) return `$${amount.toFixed(4).replace(/(\.\d\d\d*?)0+$/, "$1")}`;
  return `$${amount.toFixed(2)}`;
}

/**
 * The line appended to a successful submission that went through without asking.
 *
 * The user still has to be told what this costs — skipping the confirmation is
 * about not blocking them, not about spending quietly. It says "estimated"
 * because submission is not settlement: generation is async, and a run that ends
 * in status "failed" is not billed at all. Calling this a charge made the model
 * report money as spent on jobs that later failed and cost nothing.
 */
export function autoSubmitNotice(decision: SpendDecision): string {
  if (!decision.autoSubmit || decision.quotedUsd === null) return "";
  return (
    `- **Estimated cost**: ${formatUsd(decision.quotedUsd)} — submitted without a ` +
    `separate confirmation because it is under the ${formatUsd(decision.thresholdUsd)} limit. ` +
    `Give the user this estimate. It is not a settled charge: generation is async, ` +
    `so treat it as spent only once polling returns a successful result, and a run ` +
    `that ends in status "failed" is not billed.`
  );
}

/**
 * The cost line shown when a request stops for confirmation.
 *
 * The confirmation used to show only the catalog's unit price — for a
 * per-second video model or a Studio workflow that is a starting rate, several
 * times below what the request actually costs, and agents relayed it to users as
 * "the price". The real figure for these exact parameters is already in hand
 * from the quote that triggered the confirmation, so lead with that.
 */
/**
 * How long a quote stays valid, said as a duration.
 *
 * This used to print the expiry as an absolute UTC time. Codex tells the model
 * the date and the user's time zone but not the clock time, and on 2026-10-20
 * in production (user in Asia/Shanghai) the model compared "02:45Z" with the
 * local time it assumed, decided a token minted seconds earlier had expired,
 * re-quoted, and declared the new token expired too: the user could never
 * confirm. The server checks expiry itself, so the model only needs a duration
 * and an instruction to send the token back regardless.
 */
export function confirmationValidSeconds(expiresAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
}

/** 报价里写出这次的幂等键，确认时让模型原样传回（见 GenerationConfirmationQuote）。 */
export function confirmationReuseNotice(idempotencyKey: string, confirmationToken?: string): string {
  return (
    `- **idempotency_key**: \`${idempotencyKey}\`. When the user confirms, send this exact value back ` +
    `with the confirmation_token and unchanged arguments; do not generate a new one.` +
    // 有的客户端只把文字结果交给模型（WorkBuddy 引擎，11-04 问题 46），令牌也写在这里。
    (confirmationToken ? `\n- **confirmation_token**: \`${confirmationToken}\`` : "")
  );
}

export function confirmationValidityNotice(expiresAt: string, now: number = Date.now()): string {
  const minutes = Math.max(1, Math.round(confirmationValidSeconds(expiresAt, now) / 60));
  return (
    `- **Quote valid for**: about ${minutes} minutes. When the user confirms, send the ` +
    `confirmation_token back even if you think it may have lapsed: the server checks expiry ` +
    `itself and says so if it has, and only then do you quote again. Do not judge expiry from a clock.`
  );
}

export function confirmationCostNotice(decision: SpendDecision): string {
  if (decision.quotedUsd === null) {
    return (
      `- **Estimated cost**: not available — the platform could not price this exact request ` +
      `in advance. Do not derive a total from the catalog unit price below; tell the user the ` +
      `cost is unknown until the job runs.`
    );
  }
  if (decision.partial) {
    const missing = decision.estimateMissing?.map(estimateMissingLabel).join(", ");
    return (
      `- **Estimated cost**: at least ${formatUsd(decision.quotedUsd)} — the platform could not ` +
      `see everything it needs to price this request (${missing ? `not included: ${missing}` : "for example a reference video's length"}), ` +
      `so the real charge will be higher.`
    );
  }
  const settles =
    decision.estimateReason === ESTIMATE_SETTLES_ON_USAGE
      ? " The final charge is settled on what the job actually uses, so it can differ slightly."
      : "";
  if (decision.thresholdUsd <= 0) {
    return (
      `- **Estimated cost**: ${formatUsd(decision.quotedUsd)} for these exact parameters (live quote; ` +
      `every generation is confirmed with the user before it runs).${settles}`
    );
  }
  return (
    `- **Estimated cost**: ${formatUsd(decision.quotedUsd)} for these exact parameters (live quote; ` +
    `at or above the ${formatUsd(decision.thresholdUsd)} auto-submit limit, so it needs confirmation).${settles}`
  );
}

/** estimate_reason when the charge is settled on actual usage (token-billed video, for one). */
export const ESTIMATE_SETTLES_ON_USAGE = "settles_on_usage";

const ESTIMATE_MISSING_LABELS: Record<string, string> = {
  reference_video_duration: "the reference videos' length",
};

export function estimateMissingLabel(code: string): string {
  return ESTIMATE_MISSING_LABELS[code] ?? code.replace(/_/g, " ");
}

/** The same figure for structuredContent. */
export function costEstimate(decision: SpendDecision): {
  usd: number | null;
  partial: boolean;
  reason?: string;
  missing?: string[];
} {
  return {
    usd: decision.quotedUsd,
    partial: decision.partial === true,
    ...(decision.estimateReason ? { reason: decision.estimateReason } : {}),
    ...(decision.estimateMissing ? { missing: decision.estimateMissing } : {}),
  };
}

/**
 * Live price of a model at its own defaults, for model documentation. The
 * catalog only carries a starting unit price; agents read it as "the price" and
 * then found the real charge several times higher. Text models are billed per
 * token and have no meaningful per-request figure, so they are skipped. Any
 * failure returns null: documentation must not break because pricing did.
 */
export async function quoteAtDefaults(
  model: { model: string; type?: string },
  schema: Record<string, unknown> | null | undefined,
  options: { fetcher?: ApiRequestOptions["fetcher"] } = {}
): Promise<Quote | null> {
  if (model.type === "Text") return null;
  try {
    const quote = await fetchQuote({ model: model.model, ...schemaDefaults(schema) }, options);
    return quote.usd === null ? null : quote;
  } catch {
    return null;
  }
}
