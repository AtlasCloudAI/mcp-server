import { z } from "zod";
import { generationApi, type ApiRequestOptions } from "./api-client.js";

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

  let quote: z.output<typeof calculateResponseSchema>;
  try {
    quote = await generationApi("/model/calculate", {
      method: "POST",
      body: requestBody,
      responseSchema: calculateResponseSchema,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
  } catch (error) {
    return {
      autoSubmit: false,
      quotedUsd: null,
      thresholdUsd,
      reason: `quote unavailable: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }

  const quotedUsd = quote.price ?? null;
  if (quotedUsd === null) {
    return {
      autoSubmit: false,
      quotedUsd: null,
      thresholdUsd,
      reason: "quote did not include a price",
    };
  }
  if (quote.estimate_partial === true) {
    return {
      autoSubmit: false,
      quotedUsd,
      thresholdUsd,
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
 * The user still has to be told what they were charged — skipping the
 * confirmation is about not blocking them, not about spending quietly.
 */
export function autoSubmitNotice(decision: SpendDecision): string {
  if (!decision.autoSubmit || decision.quotedUsd === null) return "";
  return (
    `- **Charge**: ${formatUsd(decision.quotedUsd)} — submitted without a separate ` +
    `confirmation because it is under the ${formatUsd(decision.thresholdUsd)} limit. ` +
    `Report this amount to the user.`
  );
}
