import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getModels, findModel, getModelSchema } from "../services/doc-fetcher.js";
import { formatModelList, formatModelInfo, truncate } from "../utils/formatter.js";
import { generateLLMPrompt } from "../utils/prompt-gen.js";
import { handleError } from "../utils/error-handler.js";
import {
  modelInfoOutputSchema,
  modelPageLimitSchema,
  modelPageOffsetSchema,
  modelSearchOutputSchema,
  toModelSummary,
} from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";

export function registerModelTools(server: McpServer): void {
  // List all available models
  server.registerTool(
    "atlas_list_models",
    {
      title: "List Atlas Cloud Models",
      description: `List available models on Atlas Cloud, optionally filtered by type, in bounded pages.

Args:
  - type (string, optional): Filter by model type. Options: "Text", "Image", "Video", "Audio"
  - limit (integer, optional): Models per page, 1-100 (default 50)
  - offset (integer, optional): Zero-based result offset (default 0)

Returns:
  Markdown-formatted list of models grouped by type, including model ID, description, provider, and pricing.

Note: image-to-3D and text-to-3D models are Image-type models (filter with type="Image"). Audio-type models (filter with type="Audio") include text-to-speech / TTS, music generation (e.g., Suno, MiniMax Music), and speech-to-text / ASR (e.g., Seed ASR). Lipsync / talking-avatar models are Video-type models.

Examples:
  - No params -> list all models
  - type="Image" -> list only image generation models (includes 3D)
  - type="Video" -> list only video generation models (includes lipsync / talking-avatar)
  - type="Text" -> list only LLM/text models
  - type="Audio" -> list only audio models (TTS, music generation, speech-to-text/ASR)`,
      inputSchema: {
        type: z
          .enum(["Text", "Image", "Video", "Audio"])
          .optional()
          .describe("Filter by model type: Text, Image, Video, or Audio"),
        limit: modelPageLimitSchema,
        offset: modelPageOffsetSchema,
      },
      outputSchema: modelSearchOutputSchema,
      annotations: toolAnnotations("atlas_list_models"),
    },
    async ({ type, limit, offset }) => {
      try {
        const models = await getModels();
        const filtered = type
          ? models.filter((model) => model.type === type)
          : models;
        const page = filtered.slice(offset, offset + limit);
        const hasMore = offset + page.length < filtered.length;
        const text = page.length > 0
          ? formatModelList(page, type)
          : `No models found at offset ${offset}. The filtered catalog contains ${filtered.length} models.`;
        return {
          structuredContent: {
            ...(type ? { filter_type: type } : {}),
            count: page.length,
            total_count: filtered.length,
            offset,
            has_more: hasMore,
            models: page.map(toModelSummary),
          },
          content: [{ type: "text", text }],
        };
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
      description: `Get detailed information about a specific Atlas Cloud model, including API documentation, input/output schema, pricing, and usage examples.

This tool fetches the model's OpenAPI schema and generates comprehensive API documentation with cURL examples.

Args:
  - model (string): An exact current model ID returned by atlas_list_models.

Returns:
  Markdown-formatted model details including:
  - Model metadata (type, provider, context length, etc.)
  - Pricing information
  - Full API input/output schema with parameter descriptions
  - Required and optional parameters with defaults
  - cURL usage examples
  - Playground link`,
      inputSchema: {
        model: z
          .string()
          .min(1)
          .describe("Exact model ID returned by atlas_list_models"),
      },
      outputSchema: modelInfoOutputSchema,
      annotations: toolAnnotations("atlas_get_model_info"),
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

        // Fetch and append API documentation from schema
        const schema = await getModelSchema(found);
        if (schema) {
          detail +=
            "\n\n---\n\n" +
            generateLLMPrompt(schema, found.model, found.profile, found.type);
        }

        return {
          structuredContent: {
            model: toModelSummary(found),
            ...(found.price ? { pricing: found.price } : {}),
            schema_available: Boolean(schema),
            documentation_available: Boolean(found.readme),
          },
          content: [{ type: "text", text: truncate(detail) }],
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
