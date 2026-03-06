import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findModel } from "../services/doc-fetcher.js";
import { chatApi } from "../services/api-client.js";
import { handleError } from "../utils/error-handler.js";
import type { PredictionResponse } from "../types.js";

export function registerVideoTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_video",
    {
      title: "Generate Video",
      description: `Generate a video using Atlas Cloud API.

This tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

IMPORTANT: The "model" parameter requires an exact model ID (e.g., "kling-video/kling-v3.0-standard-text-to-video"). If you don't know the exact model ID, you MUST first call atlas_list_models with type="Video" to find it. Do NOT guess model IDs.

You should also use atlas_get_model_info to see the full parameter list and schema for your chosen video model before calling this tool.

Args:
  - model (string, required): The exact video model ID. Use atlas_list_models to find valid IDs.
  - params (object, required): Model-specific parameters as a JSON object. Parameters vary by model - use atlas_get_model_info to see available params. Common ones include:
    - "prompt" (string): Text description of the video
    - "image_url" (string): Source image for image-to-video models
    - "duration" (number): Video duration in seconds
    - "aspect_ratio" (string): e.g., "16:9", "9:16"

Returns:
  A prediction ID to check the result with atlas_get_prediction. Video generation typically takes 1-5 minutes.

Examples:
  - model="kling-video/kling-v3.0-standard-text-to-video", params={"prompt": "a rocket launching into space", "duration": 5}
  - model="bytedance/seedance-v1.5-pro-image-to-video", params={"prompt": "camera panning right", "image_url": "https://example.com/photo.jpg"}`,
      inputSchema: {
        model: z.string().min(1).describe("Video model ID"),
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
        // Verify model exists and is a Video type
        const found = await findModel(model);
        if (!found) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Model "${model}" not found. Use atlas_list_models with type="Video" to see available video models.`,
              },
            ],
          };
        }
        if (found.type !== "Video") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Model "${model}" is a ${found.type} model, not a Video model. Use atlas_list_models with type="Video" to find video models.`,
              },
            ],
          };
        }

        // Submit generation request
        const body = { model: found.model, ...params };
        const response = await chatApi<PredictionResponse>(
          "/model/generateVideo",
          { method: "POST", body }
        );

        const predictionId = response.data?.id;
        if (!predictionId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to start video generation. Response: ${JSON.stringify(response)}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text:
                `Video generation submitted successfully.\n\n` +
                `- **Model**: ${found.displayName} (\`${found.model}\`)\n` +
                `- **Prediction ID**: \`${predictionId}\`\n\n` +
                `The video is being generated. Use \`atlas_get_prediction\` with this ID to check the result.\n` +
                `Video generation typically takes 1-5 minutes.`,
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
