import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { submitGeneration } from "../services/generation.js";
import { handleError } from "../utils/error-handler.js";

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_image",
    {
      title: "Generate Image",
      description: `Generate an image using Atlas Cloud API. This also covers image-to-3D and text-to-3D models (they are Image-type models that return 3D files such as GLB/OBJ/USDZ).

This tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

Parameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.

IMPORTANT: The "model" parameter requires an exact model ID (e.g., "seedream/seedream-v5.0-lite-text-to-image"). If you don't know the exact model ID, you MUST first call atlas_list_models with type="Image" to find it. Do NOT guess model IDs.

You should also use atlas_get_model_info to understand what parameters a specific image model accepts before calling this tool.

Args:
  - model (string, required): The exact image model ID. Use atlas_list_models to find valid IDs.
  - params (object, required): Model-specific parameters as a JSON object. Each model has different parameters defined in its schema. Common params include "prompt", "image_size", "num_inference_steps", etc. For image-to-3D models, "image" is required. Use atlas_get_model_info to see the full parameter list for your chosen model.

Returns:
  A prediction ID to check the result with atlas_get_prediction.

Examples:
  - model="seedream/seedream-v5.0-lite-text-to-image", params={"prompt": "a cat in space"}
  - model="qwen-image/qwen-image-text-to-image-plus", params={"prompt": "sunset over mountains", "image_size": "1024x1024"}
  - model="tencent/hunyuan3d-rapid/image-to-3d", params={"image": "https://example.com/photo.jpg", "format": "GLB"}`,
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
        const result = await submitGeneration(model, params, {
          expectedType: "Image",
          endpoint: "/model/generateImage",
          typeLabel: "image",
        });

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.message }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text:
                `Image generation submitted successfully.\n\n` +
                `- **Model**: ${result.model.displayName} (\`${result.model.model}\`)\n` +
                `- **Prediction ID**: \`${result.predictionId}\`\n\n` +
                `The image is being generated. Use \`atlas_get_prediction\` with this ID to check the result.\n` +
                `Image generation usually takes 10-30 seconds (3D models can take 2-5 minutes).`,
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
