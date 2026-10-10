import { z } from "zod";
import { generationApi, type ApiRequestOptions } from "./api-client.js";
import { schemaDefaults } from "../utils/schema-validator.js";

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
  const thresholdUsd = autoSubmitThresholdUsd();
  if (thresholdUsd <= 0) {
    return {
      autoSubmit: false,
      quotedUsd: null,
      thresholdUsd,
      reason: "auto-submit disabled",
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

export function formatUsd(amount: number): string {
  // Sub-cent prices are normal here, so do not round them away to $0.01.
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
