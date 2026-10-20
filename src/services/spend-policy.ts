import { z } from "zod";
import { generationApi, type ApiRequestOptions } from "./api-client.js";
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
}

export interface Quote {
  usd: number | null;
  partial: boolean;
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
  return { usd: quote.price ?? null, partial: quote.estimate_partial === true };
}

/**
 * Auto-submit limit for image, video, audio and workflow generation.
 *
 * Defaults to 0: every generation stops first and shows the user the model and its
 * live price, and runs only after an explicit yes. Product decision of 2026-10-19,
 * after testers found jobs had started — and been billed — before they knew which
 * model was used or what it cost. MCP_GENERATION_AUTOSUBMIT_MAX_USD raises it.
 * atlas_chat keeps its own limit (autoSubmitThresholdUsd): a per-message
 * confirmation would make chat unusable, and its worst case is cents.
 */
export function generationAutoSubmitThresholdUsd(): number {
  const raw = process.env.MCP_GENERATION_AUTOSUBMIT_MAX_USD;
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export function autoSubmitThresholdUsd(): number {
  const raw = process.env.MCP_AUTOSUBMIT_MAX_USD;
  if (raw === undefined || raw.trim() === "") return 20;
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
      reason: "quote is partial, the real charge is higher",
    };
  }
  if (quotedUsd >= thresholdUsd) {
    return {
      autoSubmit: false,
      quotedUsd,
      thresholdUsd,
      reason: "quote is at or above the threshold",
    };
  }
  return {
    autoSubmit: true,
    quotedUsd,
    thresholdUsd,
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
  const decimals = amount > 0 && amount < 0.01 ? 4 : 2;
  return `$${amount.toFixed(decimals)}`;
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
    return (
      `- **Estimated cost**: at least ${formatUsd(decision.quotedUsd)} — the platform could not ` +
      `see everything it needs to price this request (for example a reference video's length), ` +
      `so the real charge will be higher.`
    );
  }
  if (decision.thresholdUsd <= 0) {
    return (
      `- **Estimated cost**: ${formatUsd(decision.quotedUsd)} for these exact parameters (live quote; ` +
      `every generation is confirmed with the user before it runs).`
    );
  }
  return (
    `- **Estimated cost**: ${formatUsd(decision.quotedUsd)} for these exact parameters (live quote; ` +
    `at or above the ${formatUsd(decision.thresholdUsd)} auto-submit limit, so it needs confirmation).`
  );
}

/** The same figure for structuredContent. */
export function costEstimate(decision: SpendDecision): { usd: number | null; partial: boolean } {
  return { usd: decision.quotedUsd, partial: decision.partial === true };
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
