import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findModel } from "../services/doc-fetcher.js";
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

export function registerVideoTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_video",
    {
      title: "Generate Video",
      description: `Generate a video using Atlas Cloud API.

This tool dynamically accepts model-specific parameters. Each video model has its own unique set of parameters defined in its schema (e.g., prompt, image_url, duration, aspect_ratio, motion parameters, etc.).

IMPORTANT: Use atlas_get_model_info first to see the full parameter list and schema for your chosen video model before calling this tool.

The tool submits the generation request and polls for the result automatically.

Args:
  - model (string, required): The video model ID (e.g., "kling-video/kling-v3.0-standard-text-to-video")
  - params (object, required): Model-specific parameters as a JSON object. Parameters vary by model - use atlas_get_model_info to see available params. Common ones include:
    - "prompt" (string): Text description of the video
    - "image_url" (string): Source image for image-to-video models
    - "duration" (number): Video duration in seconds
    - "aspect_ratio" (string): e.g., "16:9", "9:16"
  - wait_for_result (boolean, optional): Whether to poll and wait for the result. Default: true. Video generation can take several minutes.

Returns:
  The generation result including output video URL(s) and metadata.

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
        wait_for_result: z
          .boolean()
          .default(true)
          .describe(
            "Whether to poll and wait for the result. Default: true. Video generation can take several minutes."
          ),
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
        const response = await chatApi<PredictionResponse>("/model/generateVideo", {
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
                text: `Failed to start video generation. Response: ${JSON.stringify(response)}`,
              },
            ],
          };
        }

        if (!wait_for_result) {
          return {
            content: [
              {
                type: "text",
                text: `Video generation started.\n\n- **Prediction ID**: \`${predictionId}\`\n- Video generation typically takes 1-5 minutes.\n- Use \`atlas_get_prediction\` with this ID to check the result.`,
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
                text: `Video generation failed: ${result.data?.error || "Unknown error"}`,
              },
            ],
          };
        }

        const outputs = result.data?.outputs || result.data?.output;
        const outputUrls = Array.isArray(outputs) ? outputs : outputs ? [outputs] : [];

        const lines = [`# Video Generation Complete\n`];
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
