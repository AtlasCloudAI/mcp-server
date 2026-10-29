import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { quoteBalanceNotice } from "../services/quote-balance.js";
import { z } from "zod";
import { searchModels, getModels, getModelSchema } from "../services/doc-fetcher.js";
import { api } from "../services/api-client.js";
import { executeIdempotently } from "../services/idempotency.js";
import { resolveDefaultModel, routeDefaultParams } from "../services/default-models.js";
import {
  formatGenerationPricing,
  issueGenerationConfirmation,
  resolveConfirmedIdempotencyKey,
} from "../services/generation-confirmation.js";
import { handleError } from "../utils/error-handler.js";
import {
  completedOutputContent,
} from "../services/media-preview.js";
import { currentClientProfile } from "../services/client-profile.js";
import {
  autoSubmitNotice,
  confirmationCostNotice,
  costEstimate,
  evaluateSpend,
  type SpendDecision,
  confirmationReuseNotice,
  confirmationValidityNotice,
} from "../services/spend-policy.js";
import {
  fillPreferredDefaults,
  validateModelParams,
  formatValidationError,
} from "../utils/schema-validator.js";
import type { Model } from "../types.js";
import type { PredictionResponse } from "../response-schemas.js";
import {
  generationOutputSchema,
  generationConfirmationStructuredContent,
  generationConfirmationTokenSchema,
  generationConfirmedSchema,
  generationStructuredContent,
  idempotencyKeySchema,
} from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";
import { predictionResponseSchema } from "../response-schemas.js";
import {
  generationToolCardMeta,
  withGenerationCard,
} from "../apps/generation-quote.js";

type GenType = "Image" | "Video" | "Audio";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function schemaDescriptionIncludes(
  property: Record<string, unknown> | undefined,
  phrase: string
): boolean {
  return (
    typeof property?.description === "string" &&
    property.description.toLowerCase().includes(phrase)
  );
}

// Map a generation type to its submit endpoint
const ENDPOINTS: Record<GenType, string> = {
  Image: "/model/generateImage",
  Video: "/model/generateVideo",
  Audio: "/model/generateAudio",
};

// Resolve model from fuzzy keyword
async function resolveModel(
  keyword: string,
  type: GenType
): Promise<{ model: Model } | { error: string; candidates?: Model[] }> {
  // Try exact match first
  const models = await getModels();
  const exact = models.find(
    (model) => model.model === keyword || model.model.toLowerCase() === keyword.toLowerCase()
  );
  if (exact && exact.type === type) {
    return { model: exact };
  }

  // Fuzzy search
  const results = await searchModels(keyword);
  const filtered = results.filter((m) => m.type === type);

  if (filtered.length === 0) {
    return {
      error: `No ${type} model found for "${keyword}". Try atlas_list_models with type="${type}" to see available models.`,
    };
  }

  if (filtered.length === 1) {
    return { model: filtered[0] };
  }

  const candidates = filtered.slice(0, 10);
  return {
    error:
      `"${keyword}" matches multiple ${type} models. No billable request was submitted. ` +
      "Call atlas_get_model_info and retry with one exact model ID:\n" +
      candidates.map((model) => `- ${model.displayName} (\`${model.model}\`)`).join("\n"),
    candidates,
  };
}

// Build request params from schema, filling in user prompt and extra params
export function buildQuickGenerateParams(
  schema: Record<string, unknown>,
  modelId: string,
  prompt: string,
  imageUrl?: string,
  audioUrl?: string,
  extraParams?: Record<string, unknown>
): Record<string, unknown> {
  const components = asRecord(schema.components);
  const schemas = asRecord(components?.schemas);
  const inputSchema = asRecord(schemas?.Input);
  const properties = asRecord(inputSchema?.properties) ?? {};
  const required = Array.isArray(inputSchema?.required)
    ? inputSchema.required.filter(
        (value): value is string => typeof value === "string"
      )
    : [];

  const params: Record<string, unknown> = { model: modelId };

  // Set prompt - find the prompt field
  const promptField = Object.keys(properties).find((key) => {
    const property = asRecord(properties[key]);
    return (
      key === "prompt" ||
      key === "text" ||
      key === "text_prompt" ||
      schemaDescriptionIncludes(property, "prompt")
    );
  });
  if (promptField) {
    params[promptField] = prompt;
  }

  // Set image URL if provided
  if (imageUrl) {
    const imageField = Object.keys(properties).find((key) => {
      const property = asRecord(properties[key]);
      return (
        key === "image_url" ||
        key === "image" ||
        key === "input_image" ||
        key === "init_image" ||
        key === "source_image" ||
        schemaDescriptionIncludes(property, "image url") ||
        schemaDescriptionIncludes(property, "input image")
      );
    });
    if (imageField) {
      params[imageField] = imageUrl;
    }
  }

  // Set audio URL if provided (lipsync / talking-avatar / speech-to-text models)
  if (audioUrl) {
    const audioField = Object.keys(properties).find((key) => {
      const property = asRecord(properties[key]);
      return (
        key === "audio_url" ||
        key === "audio" ||
        key === "input_audio" ||
        key === "reference_audio" ||
        key === "voice_url" ||
        schemaDescriptionIncludes(property, "audio url") ||
        schemaDescriptionIncludes(property, "input audio")
      );
    });
    if (audioField) {
      params[audioField] = audioUrl;
    }
  }

  // Fill required fields with defaults if not already set
  for (const key of required) {
    if (params[key] !== undefined) continue;
    const prop = asRecord(properties[key]);
    if (prop?.default !== undefined) {
      params[key] = prop.default;
    }
  }

  // Apply extra params (user overrides)
  if (extraParams) {
    Object.assign(params, extraParams);
  }
  params.model = modelId;

  return params;
}

export function registerQuickGenerateTools(server: McpServer): void {
  server.registerTool(
    "atlas_quick_generate",
    {
      title: "Quick Generate Image/Video/Audio",
      description: `Two-step image, video, or audio generation - automatically finds exactly one model by keyword, fetches its schema, builds and validates parameters, then returns a quote before any billable submission.

Covers all generation tasks: text-to-image, image editing, 3D (image/text-to-3D), text/image-to-video, lipsync & talking-avatar (video + audio_url), TTS, and music generation.

Parameters are validated against the model's schema BEFORE submitting. If extra_params contains fields the model does not accept (or wrong values), the tool returns a precise error and does NOT spend credits.

Pricing: a call without confirmed: true only prices the request. It returns the model, an estimated cost, the current balance when it can be read, and a confirmation_token, and it starts nothing, so nothing is billed. The job starts on a later call with confirmed: true, the same arguments and idempotency_key, and that confirmation_token; if the token was lost, the server matches the quote from the unchanged arguments. A job that ends in status "failed" is not billed. A deployment may set an auto-submit limit; calls under it start right away and report the estimate.

IMPORTANT: If this tool fails to find a model, call atlas_list_models first to get the exact model list, then use atlas_generate_image / atlas_generate_video / atlas_generate_audio with the exact model ID instead. Do NOT invent extra_params - only pass parameters you know the model accepts (check atlas_get_model_info).

The tool searches for models by keyword matching against model ID, display name, and tags. After getting the prediction ID, use atlas_get_prediction to check the result.

Input files: image, video and audio inputs are public URLs. A file on the user's machine is uploaded first with atlas_get_upload_url on a hosted connection or atlas_upload_media on a local one, and the returned url goes into params. Base64 and data: URIs are not accepted. This connection already carries the user's Atlas credentials, so no API key is involved.

Args:
  - model_keyword (string, optional): Prefer an exact current model ID returned by atlas_list_models; otherwise use a distinctive display-name keyword. When it is omitted for an image or video, the server applies the default route (described in atlas_generate_video / atlas_generate_image), with the image-to-video or edit variant when image_url is given.
  - type (string, required): Generation type: "Image", "Video", or "Audio"
  - prompt (string, required): Text description of what to generate (for TTS, the text to synthesize; for music, the song description)
  - image_url (string, optional): Source image URL for image-to-video, image editing, image-to-3D, or talking-avatar models
  - audio_url (string, optional): Source audio URL for lipsync / talking-avatar video models (the speech the character should say) or speech-to-text models
  - extra_params (object, optional): Additional model-specific parameters to override defaults (e.g., {"duration": 10, "aspect_ratio": "16:9"}). Only include parameters the model's schema accepts.

Returns:
  A prediction ID to check the result with atlas_get_prediction.`,
      inputSchema: {
        idempotency_key: idempotencyKeySchema,
        confirmation_token: generationConfirmationTokenSchema,
        confirmed: generationConfirmedSchema,
        model_keyword: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Exact current model ID or a distinctive display-name keyword. When omitted for an image or video, the default route applies."
          ),
        type: z
          .enum(["Image", "Video", "Audio"])
          .describe("Generation type: Image, Video, or Audio"),
        prompt: z
          .string()
          .min(1)
          .describe("Text description of what to generate"),
        image_url: z
          .string()
          .url()
          .refine((value) => new URL(value).protocol === "https:", "image_url must use HTTPS")
          .optional()
          .describe("Source image URL for image-to-video, image editing, image-to-3D, or talking-avatar models"),
        audio_url: z
          .string()
          .url()
          .refine((value) => new URL(value).protocol === "https:", "audio_url must use HTTPS")
          .optional()
          .describe("Source audio URL for lipsync / talking-avatar video models or speech-to-text models"),
        extra_params: z
          .record(z.unknown())
          .optional()
          .describe(
            "Additional model-specific parameters to override defaults. Only include parameters the model's schema accepts."
          ),
      },
      outputSchema: generationOutputSchema,
      annotations: toolAnnotations("atlas_quick_generate"),
      ...generationToolCardMeta(),
    },
    withGenerationCard(server, "atlas_quick_generate", async ({
      idempotency_key,
      confirmation_token,
      confirmed,
      model_keyword,
      type,
      prompt,
      image_url,
      audio_url,
      extra_params,
    }) => {
      try {
        // Step 1: Resolve model
        const resolved = model_keyword
          ? await resolveModel(model_keyword, type)
          : await resolveDefaultModel(type, { hasImage: Boolean(image_url) });

        if ("error" in resolved) {
          return {
            isError: true,
            content: [{ type: "text", text: resolved.error }],
          };
        }

        const { model: foundModel } = resolved;

        // Step 2: Fetch schema
        const schema = await getModelSchema(foundModel);
        if (!schema) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `The live input schema for model "${foundModel.model}" is unavailable. ` +
                  "No billable request was submitted.",
              },
            ],
          };
        }

        // Step 3: Build params
        // 默认路由模型的默认参数在 extra_params 之后补：用户要的值优先。
        const requestBody = fillPreferredDefaults(
          schema,
          buildQuickGenerateParams(
            schema,
            foundModel.model,
            prompt,
            image_url,
            audio_url,
            extra_params
          ),
          routeDefaultParams(foundModel.model)
        );

        // Step 3b: Validate the built params against the schema before submitting,
        // so invented/invalid extra_params fail fast without spending credits.
        const { model: _model, ...paramsToValidate } = requestBody;
        const validation = validateModelParams(
          schema,
          foundModel.model,
          paramsToValidate
        );
        if (!validation.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: formatValidationError(foundModel.model, validation),
              },
            ],
          };
        }

        const kind =
          type === "Image"
            ? "image"
            : type === "Video"
              ? "video"
              : "audio";
        const confirmedRequest = {
          type,
          resolved_model: foundModel.model,
          request_body: requestBody,
        };

        // Step 4: Quote without submitting, or verify the prior quote.
        // 报价只在第一次调用时取：带着 confirmation_token 进来的那次已经
        // 问过价了，再问一遍等于每次生成多一个来回。
        let spend: SpendDecision | null = null;
        if (!confirmation_token && !confirmed) {
          spend = await evaluateSpend(requestBody);
        }
        if (spend && !spend.autoSubmit) {
          // 余额和报价记录并行取：读余额最多 1.5 秒，失败就不显示这一行。
          const balanceLinePromise = quoteBalanceNotice(costEstimate(spend).usd);
          const confirmation = await issueGenerationConfirmation(
            "atlas_quick_generate",
            idempotency_key,
            confirmedRequest,
            foundModel.price
          );
          const balanceLine = await balanceLinePromise;
          return {
            structuredContent: generationConfirmationStructuredContent(
              foundModel,
              kind,
              confirmation,
              costEstimate(spend),
              requestBody
            ),
            content: [{
              type: "text",
              text:
                `Confirmation required — exactly one model was resolved, but no billable request was submitted and no credits were spent.\n\n` +
                `- **Resolved model**: ${foundModel.displayName} (\`${foundModel.model}\`)\n` +
                `${confirmationCostNotice(spend)}\n` +
                  `${balanceLine ? `${balanceLine}\n` : ""}` +
                `- **Catalog unit price**: ${formatGenerationPricing(confirmation.pricing)}\n` +
                `${confirmationReuseNotice(confirmation.idempotencyKey)}\n` +
                `${confirmationValidityNotice(confirmation.expiresAt)}\n\n` +
                `Show the user this resolved model and the estimated cost above, then stop. Do not call this or any generation tool again until the user explicitly confirms in a new message. After confirmation, call again with unchanged arguments, confirmed: true, the idempotency_key above and the confirmation_token.`,
            }],
          };
        }
        // 走到这里没有 token，说明是低于阈值直接提交的那条路——本来就没有
        // 报价可校验。有 token 才校验：它证明用户确认的正是这次的模型与价格。
        // 带了令牌或标明已确认：解析这一单该用的幂等键（令牌抄错、幂等键丢了时按报价记录找回）。
        const confirmedKey =
          confirmation_token || confirmed
            ? await resolveConfirmedIdempotencyKey(confirmation_token, "atlas_quick_generate", idempotency_key, confirmedRequest, foundModel.price)
            : { idempotencyKey: idempotency_key };
        const submitKey = confirmedKey.idempotencyKey;

        // Step 5: Submit generation exactly once after confirmation.
        const endpoint = ENDPOINTS[type];
        const response = await executeIdempotently(
          "atlas_quick_generate",
          {
            idempotency_key: submitKey,
            ...confirmedRequest,
          },
          submitKey,
          () =>
            api<PredictionResponse>(endpoint, {
              method: "POST",
              body: requestBody,
              responseSchema: predictionResponseSchema,
            })
        );

        const predictionId = response.data?.id;
        if (!predictionId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "The Atlas Cloud API accepted the generation request but did not return a prediction ID. No automatic retry was attempted.",
              },
            ],
          };
        }

        // Build response
        const lines: string[] = [];
        const waitTime =
          type === "Image"
            ? "10-30 seconds"
            : type === "Audio"
              ? "10-60 seconds"
              : "1-5 minutes";
        // 同步完成的模型结果就在提交响应里，别再让模型去轮询一个已经结束的任务。
        const settled = response.data?.outputs ?? response.data?.output;
        const outputs = Array.isArray(settled) ? settled : settled ? [settled] : [];
        const finished =
          outputs.length > 0 ? await completedOutputContent(outputs, { profile: currentClientProfile() }) : null;

        lines.push(
          `${type} generation ${finished ? "completed" : "submitted successfully"}.\n`
        );
        if (spend) {
          const notice = autoSubmitNotice(spend);
          if (notice) lines.push(notice);
        }
        lines.push(
          `- **Model**: ${foundModel.displayName} (\`${foundModel.model}\`)`
        );
        if (finished) {
          lines.push("");
          lines.push(finished.text);
        } else {
          lines.push(`- **Prediction ID**: \`${predictionId}\`\n`);
          lines.push(
            `The ${type.toLowerCase()} is being generated. Use \`atlas_get_prediction\` with this ID to check the result.`
          );
          lines.push(`${type} generation typically takes ${waitTime}.`);
        }

        return {
          structuredContent: {
            ...generationStructuredContent(predictionId, foundModel, kind),
            ...(finished ? { status: "completed" as const, outputs } : {}),
          },
          content: [
            { type: "text", text: lines.join("\n") },
            ...(finished ? finished.blocks : []),
            ...(confirmedKey.notice ? [{ type: "text" as const, text: confirmedKey.notice }] : []),
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    })
  );
}
