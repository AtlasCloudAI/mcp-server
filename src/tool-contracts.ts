import { z } from "zod";
import type { Model, SubmitKind } from "./types.js";
import { confirmationValidSeconds, formatUsd } from "./services/spend-policy.js";
import { brandIconUrl } from "./services/brand-logo.js";

export const idempotencyKeySchema = z
  .string()
  .uuid()
  .describe(
    "A UUID that identifies this intentional write. Reuse it only when retrying the exact same request; use a new random UUID for every new generation, never a placeholder or example value such as a1b2c3d4-e5f6-7890-abcd-ef1234567890 (a key already used for another job makes the confirmation fail). On the call after a quote, send the idempotency_key shown in the quote. If crypto is unavailable (a JavaScript cell may have none), build a random UUID another way, for example from Math.random; never reuse one for a different generation."
  );

/**
 * 生成工具的幂等键：报价那次可以不传，服务端生成一个并在报价里返回；确认那次带报价里的那个。
 * 以前要模型自己造 UUID，Cursor 的 Agent 会去跑 `uuidgen`（验收问题 58）。
 */
export const generationIdempotencyKeySchema = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Optional on the first call: leave it out and the quote returns a fresh idempotency_key. On the confirming call, send the idempotency_key shown in the quote. Only set one yourself to retry the exact same request; never reuse a key for a different generation."
  );

export const generationConfirmationTokenSchema = z
  .string()
  // 不设下限：抄短了的令牌要能进到处理函数，按报价记录找回；在参数校验这一层报
  // "至少 32 个字符"只会让模型以为服务端发错了令牌（2026-10-20 生产实测）。
  .min(1)
  .max(4096)
  .optional()
  .describe(
    "Quote reference returned by this tool's quote-only first call. Sent together with confirmed: true, the same idempotency_key and unchanged arguments, it starts exactly the quoted job: the same model, parameters and price."
  );

export const generationWhyThisModelSchema = z
  .string()
  .max(300)
  .optional()
  .describe(
    "Optional, when you picked the model yourself: one short sentence (under 120 characters) telling the user why this model fits the request, e.g. \"Keeps product labels sharp and supports 9:16.\" It is shown on the quote card. Leave it out when the user named the model. It does not change the request, so the confirming call may repeat or drop it."
  );

export const generationConfirmedSchema = z
  .boolean()
  .optional()
  .describe(
    "true starts the quoted job; it belongs on the call after the user has agreed to the quoted price. The confirmation_token goes with it when available; if it was lost or mistyped, the server finds the quote from the unchanged arguments."
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

// atlas_search_docs：文档页在前，模型列表沿用 modelSearchOutputSchema 的字段，老客户端读到的不变。
export const docsSearchOutputSchema = {
  ...modelSearchOutputSchema,
  docs: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      description: z.string(),
      snippet: z.string(),
    })
  ),
  docs_error: z.string().optional(),
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
  // 默认参数下的实时报价（/model/calculate）；目录 pricing 只是计费单位起步价
  estimated_price_at_defaults_usd: z.number().optional(),
  schema_available: z.boolean(),
  documentation_available: z.boolean(),
};

const generationPriceFieldsSchema = z.object({
  input_price: z.string().optional(),
  output_price: z.string().optional(),
  base_price: z.string().optional(),
  cache_price: z.string().optional(),
  cache_creation_price: z.string().optional(),
  output_image_price: z.string().optional(),
  request_price: z.string().optional(),
  prompt_thresholds: z
    .array(
      z.object({
        threshold: z.number().optional(),
        input_price: z.string().optional(),
        output_price: z.string().optional(),
        cache_price: z.string().optional(),
        cache_creation_price: z.string().optional(),
      })
    )
    .optional(),
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
  // 模型目录里的厂商图标：卡片模型那一行放在名字前（设计稿 v3）
  model_avatar: z.string().optional(),
  kind: z.enum(["image", "video", "audio", "transcription"]),
  status: z.enum(["confirmation_required", "submitted"]),
  confirmation_token: z.string().min(32).optional(),
  confirmation_valid_seconds: z.number().int().nonnegative().optional(),
  idempotency_key: z.string().optional(),
  // 目录里的计费单价（按张、按秒、按 token），不是这一单的总价。原来叫 pricing，Claude Code 只看
  // 结构化结果，把其中的 base_price 当成报价告诉了用户（11-04 问题 50）。
  catalog_unit_pricing: generationPricingSchema.optional(),
  // 这一单按当前参数的实算报价（/model/calculate），只在需要确认时给出
  estimated_cost_usd: z.number().optional(),
  // 给用户报价时要说的那句话：总价、要不要按用量结算、单价不是总价
  price_to_tell_user: z.string().optional(),
  estimate_partial: z.boolean().optional(),
  // 预估的原因（settles_on_usage：按实际用量结算）和不完整预估漏掉的部分
  estimate_reason: z.string().optional(),
  estimate_missing: z.array(z.string()).optional(),
  // 实际要提交的参数（含服务端补的默认值）：报价上的「主要参数」按它显示
  params: z.record(z.unknown()).optional(),
  // 输入图片的宽高和横竖（视频报价读的）：出片形状跟着图走时，模型据此提醒用户
  input_images: z
    .array(
      z.object({
        field: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        orientation: z.enum(["landscape", "portrait", "square"]),
        ratio: z.string(),
      })
    )
    .optional(),
  // 客户端会渲染卡片时的一句话：卡片就是确认这一步，别自己再画报价卡（只走结构化结果的 ChatGPT 路径也能看到）
  card_note: z.string().optional(),
  // 扣费账户（需求文档 6.1）：查不到就不给
  billing_account: z
    .object({
      name: z.string(),
      type: z.string().optional(),
      user_name: z.string().optional(),
      user_email: z.string().optional(),
      available_usd: z.number().optional(),
    })
    .optional(),
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
        confirmation_valid_seconds: number;
        idempotency_key: string;
        catalog_unit_pricing: z.infer<typeof generationPricingSchema>;
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

/**
 * 模型行的厂商图标：先用官网模型卡那套品牌图标（services/brand-logo.ts），匹配不到再用目录里的 logo 字段
 * （只给 https 地址，卡片的 CSP 只放行几个 https 域名）。不用 avatar：那个地址 11-11 实测全是 404。
 */
function modelAvatar(model: Model): { model_avatar?: string } {
  const brand = brandIconUrl(model.model);
  if (brand) return { model_avatar: brand };
  return typeof model.logo === "string" && /^https:\/\//i.test(model.logo) ? { model_avatar: model.logo } : {};
}

export function generationStructuredContent(
  predictionId: string,
  model: Model,
  kind: SubmitKind,
  body?: Record<string, unknown>
): GenerationStructuredContent {
  const { model: _model, ...params } = body ?? {};
  return {
    prediction_id: predictionId,
    model_id: model.model,
    model_name: model.displayName,
    ...modelAvatar(model),
    kind,
    status: "submitted",
    ...(body ? { params } : {}),
  };
}

/**
 * 报价结果里的总价说法：模型照这句报，不会把单价当总价（问题 50）。金额和卡片同一种写法（$1.52、$0.0455），
 * 不给 6 位小数：模型会照抄成「US$1.524341」（11-04 设计走查 F3）。
 */
export function priceToTellUser(usd: number, settlesOnUsage: boolean): string {
  const amount = formatUsd(usd);
  return (
    `This job costs about ${amount} in total (estimated_cost_usd)` +
    (settlesOnUsage ? ", settled on actual usage" : "") +
    `. catalog_unit_pricing holds per-unit list prices, not this job's total.`
  );
}

export function generationConfirmationStructuredContent(
  model: Model,
  kind: SubmitKind,
  confirmation: {
    confirmationToken: string;
    expiresAt: string;
    idempotencyKey: string;
    pricing: z.infer<typeof generationPricingSchema>;
  },
  estimate?: { usd: number | null; partial: boolean; reason?: string; missing?: string[] },
  body?: Record<string, unknown>
): GenerationStructuredContent {
  const { model: _model, ...params } = body ?? {};
  return {
    model_id: model.model,
    model_name: model.displayName,
    ...modelAvatar(model),
    kind,
    status: "confirmation_required",
    confirmation_token: confirmation.confirmationToken,
    confirmation_valid_seconds: confirmationValidSeconds(confirmation.expiresAt),
    idempotency_key: confirmation.idempotencyKey,
    catalog_unit_pricing: confirmation.pricing,
    ...(estimate && estimate.usd !== null
      ? {
          estimated_cost_usd: estimate.usd,
          price_to_tell_user: priceToTellUser(estimate.usd, estimate.reason === "settles_on_usage"),
          ...(estimate.partial ? { estimate_partial: true } : {}),
          ...(estimate.reason ? { estimate_reason: estimate.reason } : {}),
          ...(estimate.missing ? { estimate_missing: estimate.missing } : {}),
        }
      : {}),
    ...(body ? { params } : {}),
  };
}
