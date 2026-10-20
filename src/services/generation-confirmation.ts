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

export type ConfirmedModelPrice = ModelPrice & {
  actual: NonNullable<ModelPrice["actual"]>;
};

export interface GenerationConfirmationQuote {
  /**
   * 原样回给调用方。确认提交必须带同一个幂等键，但 Codex 的模型常在 JavaScript 单元里
   * 随手生成一个、存进局部变量，自己从没看到过这个值；下一轮确认时就拿不出来，只能
   * 重新报价（2026-10-20 生产实测）。报价里写明这个值，模型照抄即可。
   */
  idempotencyKey: string;
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
    ttlSeconds: context?.generationConfirmationTtlSeconds ?? 3600,
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
  return {
    confirmationToken: compactToken(
      {
        subjectHash: subjectHash(subject),
        toolName,
        idempotencyKey,
        requestFingerprint,
        pricingFingerprint,
      },
      expiresAt,
      secret
    ),
    expiresAt: new Date(expiresAt).toISOString(),
    pricing,
    idempotencyKey,
  };
}

// 令牌只带版本、过期时间和一段 128 位的签名，其余（用户、工具、幂等键、请求与价格指纹）
// 由服务端在校验时从当前请求重新算出。旧格式把整段 JSON 编进令牌，长约 570 个字符，
// 2026-10-19 在 test 上实测模型回传时抄丢了一个字符，用户被迫二次确认。现在约 35 个字符。
const COMPACT_PREFIX = "c2";

interface TokenFacts {
  subjectHash: string;
  toolName: string;
  idempotencyKey: string;
  requestFingerprint: string;
  pricingFingerprint: string;
}

function compactMac(facts: TokenFacts, expiresAt: number, secret: string): string {
  const material = JSON.stringify([
    COMPACT_PREFIX,
    facts.subjectHash,
    facts.toolName,
    facts.idempotencyKey,
    facts.requestFingerprint,
    facts.pricingFingerprint,
    expiresAt,
  ]);
  return createHmac("sha256", secret).update(material).digest().subarray(0, 16).toString("base64url");
}

function compactToken(facts: TokenFacts, expiresAt: number, secret: string): string {
  return `${COMPACT_PREFIX}.${expiresAt.toString(36)}.${compactMac(facts, expiresAt, secret)}`;
}

const INVALID =
  "Generation confirmation is invalid. Request a new quote. No billable request was submitted.";

function verifyCompact(token: string, facts: TokenFacts, secret: string): void {
  const [, expPart, mac, extra] = token.split(".");
  if (!expPart || !mac || extra !== undefined || !/^[0-9a-z]+$/.test(expPart)) {
    throw new GenerationConfirmationError(INVALID);
  }
  const expiresAt = Number.parseInt(expPart, 36);
  if (!Number.isSafeInteger(expiresAt)) throw new GenerationConfirmationError(INVALID);
  const expected = Buffer.from(compactMac(facts, expiresAt, secret));
  const received = Buffer.from(mac);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    // The facts are recomputed from this request, so a mismatch means the request,
    // price or user changed — or the token was copied incorrectly.
    throw new GenerationConfirmationError(
      "Generation confirmation does not match this request: the arguments, price or user changed, " +
        "or the token was not copied exactly. Request a new quote. No billable request was submitted."
    );
  }
  if (expiresAt <= Date.now()) {
    throw new GenerationConfirmationError(
      "Generation confirmation expired. Request a new quote. No billable request was submitted."
    );
  }
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
  if (token.startsWith(`${COMPACT_PREFIX}.`)) {
    const { requestFingerprint, pricingFingerprint } = fingerprints(request, pricing);
    verifyCompact(
      token,
      { subjectHash: subjectHash(subject), toolName, idempotencyKey, requestFingerprint, pricingFingerprint },
      secret
    );
    return;
  }
  // Legacy JSON tokens issued before the compact format, still honoured until they expire.
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
    cache_creation_price: "cache-write price per million tokens",
    output_image_price: "price per output image",
    request_price: "price per request",
    base_price: "starting rate per billing unit (not this request's total)",
  };
  const parts = Object.entries(pricing.actual ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
    .map(([field, value]) => `${labels[field] ?? field}: $${value}`);
  for (const tier of pricing.actual?.prompt_thresholds ?? []) {
    if (typeof tier.threshold !== "number") continue;
    const rates = [
      tier.input_price ? `input $${tier.input_price}` : "",
      tier.output_price ? `output $${tier.output_price}` : "",
    ].filter(Boolean);
    if (rates.length) parts.push(`above ${tier.threshold} input tokens: ${rates.join(", ")} per million tokens`);
  }
  if (pricing.discount && pricing.discount !== "100") {
    parts.push(`catalog discount: ${pricing.discount}%`);
  }
  return parts.join("; ");
}
