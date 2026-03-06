import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findModel, getModelSchema } from "../services/doc-fetcher.js";
import { chatApi } from "../services/api-client.js";
import { handleError } from "../utils/error-handler.js";
import { POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS } from "../constants.js";
import type { PredictionResponse } from "../types.js";

// Poll for prediction result
async function pollPrediction(predictionId: string): Promise<PredictionResponse> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const result = await chatApi<PredictionResponse>(
      `/model/prediction/${predictionId}`
    );
    const status = result.data?.status;
    if (status === "completed" || status === "succeeded" || status === "failed") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("Generation timed out. Use atlas_get_prediction to check status later.");
}

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_image",
    {
      title: "Generate Image",
      description: `Generate an image using Atlas Cloud API.

This tool dynamically fetches the model's schema to determine available parameters. You should first use atlas_get_model_info to understand what parameters a specific image model accepts.

The tool submits the generation request and polls for the result automatically.

Args:
  - model (string, required): The image model ID (e.g., "seedream/seedream-v5.0-lite-text-to-image")
  - params (object, required): Model-specific parameters as a JSON object. Each model has different parameters defined in its schema. Common params include "prompt", "image_size", "num_inference_steps", etc. Use atlas_get_model_info to see the full parameter list for your chosen model.
  - wait_for_result (boolean, optional): Whether to poll and wait for the result. Default: true

Returns:
  The generation result including output image URL(s) and metadata.

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
        wait_for_result: z
          .boolean()
          .default(true)
          .describe("Whether to poll and wait for the result. Default: true"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, params, wait_for_result }) => {
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
        const response = await chatApi<PredictionResponse>("/model/generateImage", {
          method: "POST",
          body,
        });

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

        if (!wait_for_result) {
          return {
            content: [
              {
                type: "text",
                text: `Image generation started.\n\n- **Prediction ID**: \`${predictionId}\`\n- Use \`atlas_get_prediction\` with this ID to check the result.`,
              },
            ],
          };
        }

        // Poll for result
        const result = await pollPrediction(predictionId);
        const status = result.data?.status;

        if (status === "failed") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Image generation failed: ${result.data?.error || "Unknown error"}`,
              },
            ],
          };
        }

        const outputs = result.data?.outputs || result.data?.output;
        const outputUrls = Array.isArray(outputs) ? outputs : outputs ? [outputs] : [];

        const lines = [`# Image Generation Complete\n`];
        lines.push(`- **Model**: ${found.displayName} (\`${found.model}\`)`);
        lines.push(`- **Prediction ID**: \`${predictionId}\``);
        lines.push(`- **Status**: ${status}\n`);

        if (outputUrls.length > 0) {
          lines.push("## Output\n");
          outputUrls.forEach((url, i) => {
            lines.push(`${i + 1}. ${url}`);
          });
        }

        if (result.data?.metrics) {
          lines.push(`\n## Metrics\n`);
          lines.push("```json");
          lines.push(JSON.stringify(result.data.metrics, null, 2));
          lines.push("```");
        }

        return {
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
