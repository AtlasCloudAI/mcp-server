import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchModels, getModels, getModelSchema } from "../services/doc-fetcher.js";
import { api } from "../services/api-client.js";
import { executeIdempotently } from "../services/idempotency.js";
import {
  formatGenerationPricing,
  issueGenerationConfirmation,
  verifyGenerationConfirmation,
} from "../services/generation-confirmation.js";
import { handleError } from "../utils/error-handler.js";
import {
  validateModelParams,
  formatValidationError,
} from "../utils/schema-validator.js";
import type { Model } from "../types.js";
import type { PredictionResponse } from "../response-schemas.js";
import {
  generationOutputSchema,
  generationConfirmationStructuredContent,
  generationConfirmationTokenSchema,
  generationStructuredContent,
  idempotencyKeySchema,
} from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";
import { predictionResponseSchema } from "../response-schemas.js";

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

Billing confirmation is mandatory. The first call MUST omit confirmation_token and only returns the resolved model, current pricing metadata, validated request, and an opaque confirmation token; it does not submit or spend credits. Show that exact quote to the user and stop. Only after a new user message explicitly confirms may you repeat the call with the same idempotency_key, unchanged arguments, and confirmation_token.

IMPORTANT: If this tool fails to find a model, call atlas_list_models first to get the exact model list, then use atlas_generate_image / atlas_generate_video / atlas_generate_audio with the exact model ID instead. Do NOT invent extra_params - only pass parameters you know the model accepts (check atlas_get_model_info).

The tool searches for models by keyword matching against model ID, display name, and tags. After getting the prediction ID, use atlas_get_prediction to check the result.

Args:
  - model_keyword (string, required): Prefer an exact current model ID returned by atlas_list_models; otherwise use a distinctive display-name keyword.
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
        model_keyword: z
          .string()
          .min(1)
          .describe("Exact current model ID or a distinctive display-name keyword"),
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
    },
    async ({
      idempotency_key,
      confirmation_token,
      model_keyword,
      type,
      prompt,
      image_url,
      audio_url,
      extra_params,
    }) => {
      try {
        // Step 1: Resolve model
        const resolved = await resolveModel(model_keyword, type);

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
        const requestBody = buildQuickGenerateParams(
          schema,
          foundModel.model,
          prompt,
          image_url,
          audio_url,
          extra_params
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
        if (!confirmation_token) {
          const confirmation = issueGenerationConfirmation(
            "atlas_quick_generate",
            idempotency_key,
            confirmedRequest,
            foundModel.price
          );
          return {
            structuredContent: generationConfirmationStructuredContent(
              foundModel,
              kind,
              confirmation
            ),
            content: [{
              type: "text",
              text:
                `Confirmation required — exactly one model was resolved, but no billable request was submitted and no credits were spent.\n\n` +
                `- **Resolved model**: ${foundModel.displayName} (\`${foundModel.model}\`)\n` +
                `- **Current pricing**: ${formatGenerationPricing(confirmation.pricing)}\n` +
                `- **Confirmation expires**: ${confirmation.expiresAt}\n\n` +
                `Show this exact resolved model and pricing to the user, then stop. Do not call this or any generation tool again until the user explicitly confirms in a new message. After confirmation, reuse the same idempotency_key and unchanged arguments with confirmation_token.`,
            }],
          };
        }
        verifyGenerationConfirmation(
          confirmation_token,
          "atlas_quick_generate",
          idempotency_key,
          confirmedRequest,
          foundModel.price
        );

        // Step 5: Submit generation exactly once after confirmation.
        const endpoint = ENDPOINTS[type];
        const response = await executeIdempotently(
          "atlas_quick_generate",
          {
            idempotency_key,
            ...confirmedRequest,
          },
          idempotency_key,
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
        lines.push(`${type} generation submitted successfully.\n`);
        lines.push(
          `- **Model**: ${foundModel.displayName} (\`${foundModel.model}\`)`
        );
        lines.push(`- **Prediction ID**: \`${predictionId}\`\n`);
        lines.push(
          `The ${type.toLowerCase()} is being generated. Use \`atlas_get_prediction\` with this ID to check the result.`
        );
        lines.push(`${type} generation typically takes ${waitTime}.`);

        return {
          structuredContent: generationStructuredContent(
            predictionId,
            foundModel,
            kind
          ),
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );
}
