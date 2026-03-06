import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getModels, findModel, getModelSchema } from "../services/doc-fetcher.js";
import { formatModelList, formatModelInfo, truncate } from "../utils/formatter.js";
import { generateLLMPrompt } from "../utils/prompt-gen.js";
import { handleError } from "../utils/error-handler.js";

export function registerModelTools(server: McpServer): void {
  // List all available models
  server.registerTool(
    "atlas_list_models",
    {
      title: "List Atlas Cloud Models",
      description: `List all available models on Atlas Cloud, optionally filtered by type.

Args:
  - type (string, optional): Filter by model type. Options: "Text", "Image", "Video"

Returns:
  Markdown-formatted list of models grouped by type, including model ID, description, provider, and pricing.

Examples:
  - No params -> list all models
  - type="Image" -> list only image generation models
  - type="Video" -> list only video generation models
  - type="Text" -> list only LLM/text models`,
      inputSchema: {
        type: z
          .enum(["Text", "Image", "Video"])
          .optional()
          .describe("Filter by model type: Text, Image, or Video"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ type }) => {
      try {
        const models = await getModels();
        const text = formatModelList(models, type);
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
      description: `Get detailed information about a specific Atlas Cloud model, including API documentation, input/output schema, pricing, and usage examples.

This tool fetches the model's OpenAPI schema and generates comprehensive API documentation with cURL examples.

Args:
  - model (string): The model ID (e.g., "openai/gpt-5.2", "kling-video/kling-v3.0-standard-text-to-video")

Returns:
  Markdown-formatted model details including:
  - Model metadata (type, provider, context length, etc.)
  - Pricing information
  - Full API input/output schema with parameter descriptions
  - Required and optional parameters with defaults
  - cURL usage examples
  - Playground link

Examples:
  - model="openai/gpt-5.2" -> GPT-5.2 model details and API docs
  - model="kling-video/kling-v3.0-standard-text-to-video" -> Kling video model API docs`,
      inputSchema: {
        model: z
          .string()
          .min(1)
          .describe('Model ID, e.g., "openai/gpt-5.2" or "kling-video/kling-v3.0-standard-text-to-video"'),
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

        // Fetch and append API documentation from schema
        const schema = await getModelSchema(found);
        if (schema) {
          detail +=
            "\n\n---\n\n" +
            generateLLMPrompt(schema, found.model, found.profile, found.type);
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
