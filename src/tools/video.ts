import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { submitGeneration } from "../services/generation.js";
import { handleError } from "../utils/error-handler.js";
import { formatDryRun } from "../utils/dry-run.js";

export function registerVideoTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_video",
    {
      title: "Generate Video",
      description: `Generate a video using Atlas Cloud API. This covers text-to-video, image-to-video, video-to-video / video editing, and lipsync / talking-avatar models.

This tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

What the result looks like: one video file URL (some models also report the output duration).

Parameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.

IMPORTANT: The "model" parameter requires an exact model ID (e.g., "kwaivgi/kling-v3.0-std/text-to-video"). If you don't know the exact model ID, you MUST first call atlas_list_models with type="Video" to find it. Do NOT guess model IDs.

You should also use atlas_get_model_info to see the full parameter list and schema for your chosen video model before calling this tool.

Args:
  - model (string, required): The exact video model ID. Use atlas_list_models to find valid IDs.
  - params (object, required): Model-specific parameters as a JSON object. Parameters vary by model - use atlas_get_model_info to see available params. Common ones include:
    - "prompt" (string): Text description of the video. A few multi-shot models take an array of prompts instead.
    - "image" / "image_url" / "images" / "first_frame_image": Source image(s) for image-to-video models — the field name and whether it is a string or an array vary by model
    - "video" / "video_url" / "video_clips": Source footage for video-to-video, editing and extension models
    - "audio_url" (string): Speech track for lipsync / talking-avatar models
    - "duration" (number): Video duration in seconds
    - "aspect_ratio" / "ratio" (string): e.g., "16:9", "9:16"
  Use atlas_upload_media to turn a local file into a URL first.
  - dry_run (boolean, optional): Build and validate the request, show the exact body that would be sent, and stop. Nothing is submitted and no credits are spent. Use this to check what a call will do before paying for it.

Returns:
  A prediction ID to check the result with atlas_get_prediction. Video generation typically takes 1-5 minutes.

Examples:
  - model="kwaivgi/kling-v3.0-std/text-to-video", params={"prompt": "a rocket launching into space", "duration": 5}
  - model="bytedance/seedance-2.5/image-to-video", params={"prompt": "camera panning right", "image_url": "https://example.com/photo.jpg"}
  - model="alibaba/wan-2.6/video-to-video", params={"prompt": "restyle as winter", "video": "https://example.com/clip.mp4"}`,
      inputSchema: {
        model: z.string().min(1).describe("Video model ID"),
        params: z
          .record(z.unknown())
          .describe(
            "Model-specific parameters as JSON object. Use atlas_get_model_info to see available parameters for your chosen model."
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Build and validate the request and show it, without submitting it or spending credits"
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, params, dry_run }) => {
      try {
        const result = await submitGeneration(model, params, {
          expectedType: "Video",
          endpoint: "/model/generateVideo",
          typeLabel: "video",
          dryRun: dry_run,
        });

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.message }],
          };
        }

        if (result.predictionId === null) {
          return {
            content: [
              {
                type: "text",
                text: formatDryRun(
                  result.model,
                  "/model/generateVideo",
                  result.body
                ),
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
                `- **Model**: ${result.model.displayName} (\`${result.model.model}\`)\n` +
                `- **Prediction ID**: \`${result.predictionId}\`\n\n` +
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
