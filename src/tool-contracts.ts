import { z } from "zod";
import type { Model, SubmitKind } from "./types.js";

export const idempotencyKeySchema = z
  .string()
  .uuid()
  .describe(
    "A UUID that identifies this intentional write. Reuse it only when retrying the exact same request; use a new UUID for a new generation."
  );

export const generationConfirmationTokenSchema = z
  .string()
  .min(32)
  .max(4096)
  .optional()
  .describe(
    "Opaque token returned by this tool's quote-only first call. Supply it only after the user explicitly confirms the exact model, validated parameters, and current pricing. Reuse the same idempotency_key and unchanged arguments."
  );

export const predictionIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/,
    "Prediction ID must be a single URL-safe path segment"
  );

export const modelSummarySchema = z.object({
  model_id: z.string(),
  display_name: z.string(),
  type: z.string(),
  provider: z.string().optional(),
  profile: z.string().optional(),
});

export const modelSearchOutputSchema = {
  query: z.string().optional(),
  filter_type: z.string().optional(),
  count: z.number().int().nonnegative(),
  total_count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
  models: z.array(modelSummarySchema),
};

export const modelPageLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(50)
  .describe("Maximum models to return in this page (1-100; default 50)");

export const modelPageOffsetSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Zero-based result offset for pagination (default 0)");

export const modelInfoOutputSchema = {
  model: modelSummarySchema,
  pricing: z
    .object({
      discount: z.string().optional(),
      actual: z
        .object({
          input_price: z.string().optional(),
          output_price: z.string().optional(),
          base_price: z.string().optional(),
          cache_price: z.string().optional(),
          output_image_price: z.string().optional(),
          request_price: z.string().optional(),
        })
        .optional(),
      origin: z
        .object({
          input_price: z.string().optional(),
          output_price: z.string().optional(),
          base_price: z.string().optional(),
          cache_price: z.string().optional(),
          output_image_price: z.string().optional(),
          request_price: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  schema_available: z.boolean(),
  documentation_available: z.boolean(),
};

const generationPriceFieldsSchema = z.object({
  input_price: z.string().optional(),
  output_price: z.string().optional(),
  base_price: z.string().optional(),
  cache_price: z.string().optional(),
  output_image_price: z.string().optional(),
  request_price: z.string().optional(),
});

export const generationPricingSchema = z.object({
  discount: z.string().optional(),
  actual: generationPriceFieldsSchema,
  origin: generationPriceFieldsSchema.optional(),
});

export const generationOutputSchema = {
  prediction_id: predictionIdSchema.optional(),
  model_id: z.string(),
  model_name: z.string(),
  kind: z.enum(["image", "video", "audio", "transcription"]),
  status: z.enum(["confirmation_required", "submitted"]),
  confirmation_token: z.string().min(32).optional(),
  confirmation_expires_at: z.string().datetime().optional(),
  pricing: generationPricingSchema.optional(),
};

export type GenerationStructuredContent = Record<string, unknown> &
  (
    | {
        prediction_id: string;
        model_id: string;
        model_name: string;
        kind: SubmitKind;
        status: "submitted";
      }
    | {
        model_id: string;
        model_name: string;
        kind: SubmitKind;
        status: "confirmation_required";
        confirmation_token: string;
        confirmation_expires_at: string;
        pricing: z.infer<typeof generationPricingSchema>;
      }
  );

export function toModelSummary(model: Model): {
  model_id: string;
  display_name: string;
  type: string;
  provider?: string;
  profile?: string;
} {
  return {
    model_id: model.model,
    display_name: model.displayName,
    type: model.type,
    ...(model.organization ? { provider: model.organization } : {}),
    ...(model.profile ? { profile: model.profile } : {}),
  };
}

export function generationStructuredContent(
  predictionId: string,
  model: Model,
  kind: SubmitKind
): GenerationStructuredContent {
  return {
    prediction_id: predictionId,
    model_id: model.model,
    model_name: model.displayName,
    kind,
    status: "submitted",
  };
}

export function generationConfirmationStructuredContent(
  model: Model,
  kind: SubmitKind,
  confirmation: {
    confirmationToken: string;
    expiresAt: string;
    pricing: z.infer<typeof generationPricingSchema>;
  }
): GenerationStructuredContent {
  return {
    model_id: model.model,
    model_name: model.displayName,
    kind,
    status: "confirmation_required",
    confirmation_token: confirmation.confirmationToken,
    confirmation_expires_at: confirmation.expiresAt,
    pricing: confirmation.pricing,
  };
}
