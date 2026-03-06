import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findModel } from "../services/doc-fetcher.js";
import { chatApi } from "../services/api-client.js";
import { handleError } from "../utils/error-handler.js";
import type { PredictionResponse } from "../types.js";

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_image",
    {
      title: "Generate Image",
      description: `Generate an image using Atlas Cloud API.

This tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

IMPORTANT: The "model" parameter requires an exact model ID (e.g., "seedream/seedream-v5.0-lite-text-to-image"). If you don't know the exact model ID, you MUST first call atlas_list_models with type="Image" to find it. Do NOT guess model IDs.

You should also use atlas_get_model_info to understand what parameters a specific image model accepts before calling this tool.

Args:
  - model (string, required): The exact image model ID. Use atlas_list_models to find valid IDs.
  - params (object, required): Model-specific parameters as a JSON object. Each model has different parameters defined in its schema. Common params include "prompt", "image_size", "num_inference_steps", etc. Use atlas_get_model_info to see the full parameter list for your chosen model.

Returns:
  A prediction ID to check the result with atlas_get_prediction.

Examples:
  - model="seedream/seedream-v5.0-lite-text-to-image", params={"prompt": "a cat in space"}
  - model="qwen-image/qwen-image-text-to-image-plus", params={"prompt": "sunset over mountains", "image_size": "1024x1024"}`,
      inputSchema: {
        model: z.string().min(1).describe("Image model ID"),
        params: z
          .record(z.unknown())
          .describe(
            "Model-specific parameters as JSON object. Use atlas_get_model_info to see available parameters for your chosen model."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, params }) => {
      try {
        // Verify model exists and is an Image type
        const found = await findModel(model);
        if (!found) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Model "${model}" not found. Use atlas_list_models with type="Image" to see available image models.`,
              },
            ],
          };
        }
        if (found.type !== "Image") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Model "${model}" is a ${found.type} model, not an Image model. Use atlas_list_models with type="Image" to find image models.`,
              },
            ],
          };
        }

        // Submit generation request
        const body = { model: found.model, ...params };
        const response = await chatApi<PredictionResponse>(
          "/model/generateImage",
          { method: "POST", body }
        );

        const predictionId = response.data?.id;
        if (!predictionId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to start image generation. Response: ${JSON.stringify(response)}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text:
                `Image generation submitted successfully.\n\n` +
                `- **Model**: ${found.displayName} (\`${found.model}\`)\n` +
                `- **Prediction ID**: \`${predictionId}\`\n\n` +
                `The image is being generated. Use \`atlas_get_prediction\` with this ID to check the result.\n` +
                `Image generation usually takes 10-30 seconds.`,
            },
          ],
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
