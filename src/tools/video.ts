import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  prepareGeneration,
  submitPreparedGeneration,
} from "../services/generation.js";
import {
  formatGenerationPricing,
  issueGenerationConfirmation,
  verifyGenerationConfirmation,
} from "../services/generation-confirmation.js";
import { executeIdempotently } from "../services/idempotency.js";
import { handleError } from "../utils/error-handler.js";
import {
  generationOutputSchema,
  generationConfirmationStructuredContent,
  generationConfirmationTokenSchema,
  generationStructuredContent,
  idempotencyKeySchema,
} from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";

export function registerVideoTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_video",
    {
      title: "Generate Video",
      description: `Generate a video using Atlas Cloud API.

This tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

Billing confirmation is mandatory and happens in two calls. The first call MUST omit confirmation_token: it validates the live schema and returns the exact resolved model, current pricing metadata, and an opaque confirmation token without submitting or spending credits. Show that quote to the user and stop. Only after a new user message explicitly confirms that exact quote may you call again with the same idempotency_key, unchanged arguments, and confirmation_token.

Parameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.

IMPORTANT: The "model" parameter requires an exact current model ID. If you don't know it, first call atlas_list_models with type="Video". Do NOT guess model IDs.

You should also use atlas_get_model_info to see the full parameter list and schema for your chosen video model before calling this tool.

Args:
  - model (string, required): The exact video model ID. Use atlas_list_models to find valid IDs.
  - params (object, required): Model-specific parameters as a JSON object. Parameters vary by model - use atlas_get_model_info to see available params. Common ones include:
    - "prompt" (string): Text description of the video
    - "image_url" (string): Source image for image-to-video models
    - "duration" (number): Video duration in seconds
    - "aspect_ratio" (string): e.g., "16:9", "9:16"

Returns:
  A prediction ID to check the result with atlas_get_prediction. Video generation typically takes 1-5 minutes.`,
      inputSchema: {
        idempotency_key: idempotencyKeySchema,
        confirmation_token: generationConfirmationTokenSchema,
        model: z.string().min(1).describe("Video model ID"),
        params: z
          .record(z.unknown())
          .describe(
            "Model-specific parameters as JSON object. Use atlas_get_model_info to see available parameters for your chosen model."
          ),
      },
      outputSchema: generationOutputSchema,
      annotations: toolAnnotations("atlas_generate_video"),
    },
    async ({ idempotency_key, confirmation_token, model, params }) => {
      try {
        const preparation = await prepareGeneration(model, params, {
          expectedType: "Video",
          endpoint: "/model/generateVideo",
          typeLabel: "video",
        });
        if (!preparation.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: preparation.message }],
          };
        }
        const { prepared } = preparation;
        const confirmedRequest = {
          resolved_model: prepared.model.model,
          request_body: prepared.body,
        };
        if (!confirmation_token) {
          const confirmation = issueGenerationConfirmation(
            "atlas_generate_video",
            idempotency_key,
            confirmedRequest,
            prepared.model.price
          );
          return {
            structuredContent: generationConfirmationStructuredContent(
              prepared.model,
              "video",
              confirmation
            ),
            content: [{
              type: "text",
              text:
                `Confirmation required — no billable request was submitted and no credits were spent.\n\n` +
                `- **Model**: ${prepared.model.displayName} (\`${prepared.model.model}\`)\n` +
                `- **Current pricing**: ${formatGenerationPricing(confirmation.pricing)}\n` +
                `- **Confirmation expires**: ${confirmation.expiresAt}\n\n` +
                `Show this exact model and pricing to the user, then stop. Do not call this or any generation tool again until the user explicitly confirms in a new message. After confirmation, reuse the same idempotency_key and unchanged arguments with the returned confirmation_token.`,
            }],
          };
        }
        verifyGenerationConfirmation(
          confirmation_token,
          "atlas_generate_video",
          idempotency_key,
          confirmedRequest,
          prepared.model.price
        );
        const result = await executeIdempotently(
          "atlas_generate_video",
          { idempotency_key, ...confirmedRequest },
          idempotency_key,
          () => submitPreparedGeneration(prepared)
        );

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.message }],
          };
        }

        return {
          structuredContent: generationStructuredContent(
            result.predictionId,
            result.model,
            "video"
          ),
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
