import { z } from "zod";
import { predictionIdSchema } from "./tool-contracts.js";

const moneyValueSchema = z.object({
  value: z.string(),
  currency: z.string(),
});

const priceFieldsSchema = z.object({
  input_price: z.string().optional(),
  output_price: z.string().optional(),
  base_price: z.string().optional(),
  cache_price: z.string().optional(),
  output_image_price: z.string().optional(),
  request_price: z.string().optional(),
});

export const modelResponseSchema = z
  .object({
    uuid: z.string(),
    model: z.string().min(1),
    type: z.string().min(1),
    displayName: z.string().min(1),
    profile: z.string().default(""),
    avatar: z.string().default(""),
    readme: z.string().default(""),
    schema: z.string().optional(),
    tags: z.array(z.string()).default([]),
    price: z
      .object({
        discount: z.string().optional(),
        actual: priceFieldsSchema.optional(),
        origin: priceFieldsSchema.optional(),
      })
      .optional(),
    contextLength: z.number().optional(),
    maxCompletionTokens: z.number().optional(),
    avgLatency: z.union([z.number(), z.string()]).optional(),
    categories: z
      .array(z.string())
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
    organization: z.string().optional(),
    example: z.string().optional(),
    familyName: z.string().optional(),
    familyDisplayName: z.string().optional(),
    totalParameters: z.string().optional(),
    activeParameters: z.string().optional(),
    architectureType: z.string().optional(),
    knowledgeCutoff: z.string().optional(),
    coreStrengths: z.array(z.string()).optional(),
    useCases: z.array(z.string()).optional(),
    display_console: z.boolean().optional(),
  })
  .passthrough();

export const modelsResponseSchema = z
  .object({
    code: z.union([z.string(), z.number()]),
    data: z.array(modelResponseSchema),
  })
  .passthrough();

const predictionDataSchema = z
  .object({
    id: predictionIdSchema.optional(),
    prediction_id: predictionIdSchema.optional(),
    request_id: predictionIdSchema.optional(),
    status: z.string().nullable().optional(),
    output: z.union([z.string(), z.array(z.string())]).nullable().optional(),
    outputs: z.array(z.string()).nullable().optional(),
    error: z.string().nullable().optional(),
    metrics: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    const ids = [value.id, value.prediction_id, value.request_id].filter(
      (candidate): candidate is string => candidate !== undefined
    );
    if (new Set(ids).size > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: "id, prediction_id, and request_id must identify the same prediction",
      });
    }
  })
  .transform(({ prediction_id, request_id, ...value }) => ({
    ...value,
    ...(value.id === undefined && (prediction_id ?? request_id) !== undefined
      ? { id: prediction_id ?? request_id }
      : {}),
  }));

const wrappedPredictionResponseSchema = z
  .object({
    code: z.union([z.string(), z.number()]),
    data: predictionDataSchema,
  })
  .passthrough();

export const predictionResponseSchema = z.preprocess((response) => {
  if (
    response &&
    typeof response === "object" &&
    "code" in response &&
    "data" in response
  ) {
    return response;
  }
  return { code: 200, data: response };
}, wrappedPredictionResponseSchema);

export type PredictionResponse = z.output<typeof predictionResponseSchema>;

export const uploadResponseSchema = z
  .object({
    code: z.union([z.string(), z.number()]),
    message: z.string(),
    data: z
      .object({
        type: z.string(),
        download_url: z.string().url(),
        filename: z.string(),
        size: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();

export const balanceResponseSchema = z
  .object({
    object: z.string(),
    scope: z.string(),
    account: z
      .object({ id: z.string(), name: z.string(), type: z.string() })
      .optional(),
    available: moneyValueSchema.optional(),
    cash: moneyValueSchema.optional(),
    bonus: moneyValueSchema.optional(),
    subscription_bonus: moneyValueSchema.optional(),
    frozen: moneyValueSchema.optional(),
    credit_grant: z
      .object({
        status: z.string().optional(),
        granted: moneyValueSchema.optional(),
        used: moneyValueSchema.optional(),
        remaining_overdraft: moneyValueSchema.optional(),
        overdrawn: moneyValueSchema.optional(),
      })
      .optional(),
    request_id: z.string().optional(),
  })
  .passthrough();

export const usageListResponseSchema = z
  .object({
    object: z.string(),
    scope: z.string(),
    data: z.array(
      z
        .object({
          object: z.string(),
          date: z.string(),
          start_at: z.string().optional(),
          end_at: z.string().optional(),
          partial: z.boolean().optional(),
          results: z.array(z.record(z.unknown())).optional(),
        })
        .passthrough()
    ),
    has_more: z.boolean().optional(),
    next_page: z.string().nullable().optional(),
    request_id: z.string().optional(),
  })
  .passthrough();

export const chatCompletionResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.string(),
    created: z.number(),
    model: z.string(),
    choices: z.array(
      z.object({
        index: z.number().int(),
        message: z.object({ role: z.string(), content: z.string() }),
        finish_reason: z.string(),
      })
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .passthrough();

// /model/history（kubedl console backend）。code 是字符串 "200"，createdAt 是秒级
// 时间戳字符串，requestBody 在库里存的是 JSON 字符串——都按 2026-09-28 生产实测的
// 形状写，别照 prediction 那套去猜。
const historyItemSchema = z
  .object({
    ID: z.string().min(1),
    model: z.string().default(""),
    status: z
      .string()
      .nullable()
      .optional()
      .transform((value) => value ?? ""),
    createdAt: z.union([z.string(), z.number()]).nullable().optional(),
    requestBody: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

export type HistoryItem = z.output<typeof historyItemSchema>;

export const historyResponseSchema = z
  .object({
    code: z.union([z.string(), z.number()]),
    data: z
      .object({
        total: z.coerce.number().int().nonnegative().default(0),
        pageNo: z.coerce.number().int().optional(),
        pageSize: z.coerce.number().int().optional(),
        items: z
          .array(historyItemSchema)
          .nullable()
          .optional()
          .transform((value) => value ?? []),
      })
      .passthrough(),
  })
  .passthrough();

export type HistoryResponse = z.output<typeof historyResponseSchema>;
