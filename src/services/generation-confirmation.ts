import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { ModelPrice } from "../types.js";
import { idempotencyFingerprint } from "./idempotency.js";
import { getRequestContext } from "./request-context.js";

const localConfirmationSecret = randomBytes(32).toString("base64url");

const confirmationPayloadSchema = z.object({
  version: z.literal(1),
  subject_hash: z.string().regex(/^[a-f0-9]{64}$/),
  tool_name: z.string().min(1).max(128),
  idempotency_key: z.string().uuid(),
  request_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pricing_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.number().int().positive(),
});

type ConfirmationPayload = z.infer<typeof confirmationPayloadSchema>;

export type ConfirmedModelPrice = ModelPrice & {
  actual: NonNullable<ModelPrice["actual"]>;
};

export interface GenerationConfirmationQuote {
  confirmationToken: string;
  expiresAt: string;
  pricing: ConfirmedModelPrice;
}

export class GenerationConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationConfirmationError";
  }
}

function currentPricing(price: ModelPrice | undefined): ConfirmedModelPrice {
  if (!price?.actual || Object.values(price.actual).every((value) => !value)) {
    throw new GenerationConfirmationError(
      "Current pricing metadata is unavailable for this model. No billable request was submitted."
    );
  }
  return {
    ...(price.discount ? { discount: price.discount } : {}),
    actual: { ...price.actual },
    ...(price.origin ? { origin: { ...price.origin } } : {}),
  };
}

function subjectHash(subject: string): string {
  return createHash("sha256").update(subject).digest("hex");
}

function runtime(): {
  subject: string;
  secret: string;
  ttlSeconds: number;
} {
  const context = getRequestContext();
  return {
    subject: context?.subject ?? "stdio",
    secret:
      context?.generationConfirmationSecret ??
      process.env.MCP_GENERATION_CONFIRMATION_SECRET ??
      localConfirmationSecret,
    ttlSeconds: context?.generationConfirmationTtlSeconds ?? 600,
  };
}

function fingerprints(
  request: Record<string, unknown>,
  pricing: ModelPrice
): { requestFingerprint: string; pricingFingerprint: string } {
  return {
    requestFingerprint: idempotencyFingerprint(request),
    pricingFingerprint: idempotencyFingerprint({ pricing }),
  };
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueGenerationConfirmation(
  toolName: string,
  idempotencyKey: string,
  request: Record<string, unknown>,
  modelPrice: ModelPrice | undefined
): GenerationConfirmationQuote {
  const pricing = currentPricing(modelPrice);
  const { subject, secret, ttlSeconds } = runtime();
  const { requestFingerprint, pricingFingerprint } = fingerprints(
    request,
    pricing
  );
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const payload: ConfirmationPayload = {
    version: 1,
    subject_hash: subjectHash(subject),
    tool_name: toolName,
    idempotency_key: idempotencyKey,
    request_fingerprint: requestFingerprint,
    pricing_fingerprint: pricingFingerprint,
    expires_at: expiresAt,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url"
  );
  return {
    confirmationToken: `${encodedPayload}.${sign(encodedPayload, secret)}`,
    expiresAt: new Date(expiresAt).toISOString(),
    pricing,
  };
}

export function verifyGenerationConfirmation(
  token: string,
  toolName: string,
  idempotencyKey: string,
  request: Record<string, unknown>,
  modelPrice: ModelPrice | undefined
): void {
  const pricing = currentPricing(modelPrice);
  const { subject, secret } = runtime();
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    throw new GenerationConfirmationError(
      "Generation confirmation is invalid. Request a new quote. No billable request was submitted."
    );
  }

  const expectedSignature = Buffer.from(sign(encodedPayload, secret));
  const receivedSignature = Buffer.from(encodedSignature);
  if (
    expectedSignature.length !== receivedSignature.length ||
    !timingSafeEqual(expectedSignature, receivedSignature)
  ) {
    throw new GenerationConfirmationError(
      "Generation confirmation is invalid. Request a new quote. No billable request was submitted."
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );
  } catch {
    throw new GenerationConfirmationError(
      "Generation confirmation is invalid. Request a new quote. No billable request was submitted."
    );
  }
  const parsed = confirmationPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new GenerationConfirmationError(
      "Generation confirmation is invalid. Request a new quote. No billable request was submitted."
    );
  }
  if (parsed.data.expires_at <= Date.now()) {
    throw new GenerationConfirmationError(
      "Generation confirmation expired. Request a new quote. No billable request was submitted."
    );
  }

  const { requestFingerprint, pricingFingerprint } = fingerprints(
    request,
    pricing
  );
  const matches =
    parsed.data.subject_hash === subjectHash(subject) &&
    parsed.data.tool_name === toolName &&
    parsed.data.idempotency_key === idempotencyKey &&
    parsed.data.request_fingerprint === requestFingerprint &&
    parsed.data.pricing_fingerprint === pricingFingerprint;
  if (!matches) {
    throw new GenerationConfirmationError(
      "Generation confirmation does not match the current user, tool, idempotency key, request, or pricing. Request a new quote. No billable request was submitted."
    );
  }
}

export function formatGenerationPricing(pricing: ModelPrice): string {
  const labels: Record<string, string> = {
    input_price: "input price per million tokens",
    output_price: "output price per million tokens",
    cache_price: "cached-input price per million tokens",
    output_image_price: "price per output image",
    request_price: "price per request",
    base_price: "catalog billing-unit price (NOT an estimated total)",
  };
  const parts = Object.entries(pricing.actual ?? {})
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([field, value]) => `${labels[field] ?? field}: $${value}`);
  if (pricing.discount && pricing.discount !== "100") {
    parts.push(`catalog discount: ${pricing.discount}%`);
  }
  return parts.join("; ");
}
