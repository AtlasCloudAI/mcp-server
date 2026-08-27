import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getModels,
  findModel,
  getModelSchema,
  searchModels,
} from "../services/doc-fetcher.js";
import { formatModelList, formatModelInfo, truncate } from "../utils/formatter.js";
import { generateLLMPrompt, generateTextModelPrompt } from "../utils/prompt-gen.js";
import { handleError } from "../utils/error-handler.js";
import {
  is3DModel,
  isLyricsModel,
  isMusicModel,
  isSTTModel,
  isTTSModel,
} from "../utils/model-kind.js";
import type { Model } from "../types.js";

// Sub-kinds that cut across model.type: 3D models are typed Image, and the
// Audio bucket mixes speech synthesis, transcription, music and lyrics.
const KIND_FILTERS: Record<string, (model: Model) => boolean> = {
  "3d": is3DModel,
  tts: (m) => m.type === "Audio" && isTTSModel(m) && !isMusicModel(m),
  stt: (m) => m.type === "Audio" && isSTTModel(m) && !isMusicModel(m),
  music: (m) => m.type === "Audio" && isMusicModel(m) && !isLyricsModel(m),
  lyrics: (m) => m.type === "Audio" && isLyricsModel(m),
};

export function registerModelTools(server: McpServer): void {
  // List all available models
  server.registerTool(
    "atlas_list_models",
    {
      title: "List Atlas Cloud Models",
      description: `List available models on Atlas Cloud, optionally filtered.

There are 400+ models, so a listing is capped: the response says how many matched and how many are shown. Narrow it with type / kind / query rather than raising limit, otherwise the tail is cut off.

Args:
  - type (string, optional): "Text", "Image", "Video" or "Audio"
  - kind (string, optional): Sub-kind that cuts across type: "3d", "tts", "stt", "music", "lyrics"
  - query (string, optional): Keyword matched against model ID, name, provider and tags
  - limit (number, optional): Max rows, 1-200. Default 60

Returns:
  Markdown list grouped by type, one line per model: model ID, display name, kind, provider.

Type notes:
  - image-to-3D and text-to-3D models are Image-type (use kind="3d" to isolate them)
  - Audio-type covers text-to-speech, music generation, lyrics generation and speech-to-text/ASR
  - lipsync / talking-avatar models are Video-type

Examples:
  - type="Image" -> image generation models (includes 3D)
  - kind="stt" -> speech-to-text models only
  - kind="music" -> music generation models (Suno, MiniMax Music)
  - query="kling", type="Video" -> Kling video models
  - No params -> the first 60 models across all types`,
      inputSchema: {
        type: z
          .enum(["Text", "Image", "Video", "Audio"])
          .optional()
          .describe("Filter by model type: Text, Image, Video, or Audio"),
        kind: z
          .enum(["3d", "tts", "stt", "music", "lyrics"])
          .optional()
          .describe(
            "Filter by sub-kind: 3d, tts, stt (speech-to-text), music, lyrics"
          ),
        query: z
          .string()
          .max(200)
          .optional()
          .describe("Keyword matched against model ID, name, provider and tags"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum rows to return, 1-200. Default 60"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ type, kind, query, limit }) => {
      try {
        let models = query ? await searchModels(query) : await getModels();
        if (kind) models = models.filter(KIND_FILTERS[kind]);

        if (models.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No models matched${query ? ` "${query}"` : ""}${
                  kind ? ` with kind="${kind}"` : ""
                }${type ? ` of type "${type}"` : ""}. Try a broader query or drop a filter.`,
              },
            ],
          };
        }

        const filterLabel = [
          kind ? `kind=${kind}` : "",
          query ? `query="${query}"` : "",
        ]
          .filter(Boolean)
          .join(", ");

        const text = formatModelList(models, {
          type,
          filterLabel: filterLabel || undefined,
          limit,
        });
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );

  // Get detailed model info with API documentation
  server.registerTool(
    "atlas_get_model_info",
    {
      title: "Get Model Info",
      description: `Get detailed information about a specific Atlas Cloud model: metadata, pricing in that model's own billing unit, full input/output schema, and usage examples.

For media models (image / video / audio / 3D) this renders the model's OpenAPI schema with every accepted parameter and a two-step cURL example. For LLM models it renders the endpoint and request body for the protocol that model actually speaks (OpenAI chat completions, OpenAI Responses, Anthropic Messages or native Gemini), plus where to read the reply from.

Args:
  - model (string): The model ID (e.g. "deepseek-ai/deepseek-v3.2", "kwaivgi/kling-v3.0-std/text-to-video")

Returns:
  Markdown-formatted model details including:
  - Model metadata (type, kind, provider, input/output modalities, context length)
  - Pricing with the correct unit (per image / second / 1K characters / minute of audio / generation)
  - Full API input/output schema with parameter descriptions, or the chat protocol contract for LLMs
  - Required and optional parameters with defaults
  - cURL usage examples and the playground link

Examples:
  - model="deepseek-ai/deepseek-v3.2" -> DeepSeek V3.2 details and chat API contract
  - model="suno/chirp-v5" -> Suno music model parameters and output shape
  - model="kwaivgi/kling-v3.0-std/text-to-video" -> Kling video model API docs`,
      inputSchema: {
        model: z
          .string()
          .min(1)
          .describe('Model ID, e.g., "deepseek-ai/deepseek-v3.2" or "kwaivgi/kling-v3.0-std/text-to-video"'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ model }) => {
      try {
        const found = await findModel(model);
        if (!found) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Model "${model}" not found. Use atlas_list_models to see all available models.`,
              },
            ],
          };
        }

        let detail = formatModelInfo(found);

        if (found.type === "Text") {
          // LLMs publish no OpenAPI schema; their contract comes from the
          // protocol they declare.
          detail += "\n\n---\n\n" + generateTextModelPrompt(found);
        } else {
          const schema = await getModelSchema(found);
          if (schema) {
            detail +=
              "\n\n---\n\n" +
              generateLLMPrompt(schema, found.model, found.profile, found.type);
          }
        }

        return { content: [{ type: "text", text: truncate(detail) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );
}
