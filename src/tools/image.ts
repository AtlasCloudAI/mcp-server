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
  completedOutputContent,
} from "../services/media-preview.js";
import { currentClientProfile } from "../services/client-profile.js";
import {
  autoSubmitNotice,
  confirmationCostNotice,
  costEstimate,
  evaluateSpend,
  type SpendDecision,
  confirmationValidityNotice,
} from "../services/spend-policy.js";
import {
  generationOutputSchema,
  generationConfirmationStructuredContent,
  generationConfirmationTokenSchema,
  generationStructuredContent,
  idempotencyKeySchema,
} from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_image",
    {
      title: "Generate Image",
      description: `Generate an image using Atlas Cloud API. This also covers image-to-3D and text-to-3D models (they are Image-type models that return 3D files such as GLB/OBJ/USDZ).

This tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

Billing: every request is quoted before anything runs. Choose the model and parameters yourself from the user's request and the live catalog — do not ask the user to pick a model or name a budget first unless they asked to choose. Then call once, omitting confirmation_token: the server returns the model, the live quote for these exact parameters and an opaque confirmation_token, and spends nothing. Show the user the model and that price in one short message and stop. Only after a new user message explicitly confirms may you call again with the same idempotency_key, unchanged arguments, and confirmation_token. The quote is an estimate: call it spent only once polling returns a successful result; a job that ends in status "failed" is not billed. (A deployment can set an auto-submit limit; calls under it run straight away and report the estimate instead of stopping.)

Parameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.

IMPORTANT: The "model" parameter requires an exact current model ID. If you don't know it, first call atlas_list_models with type="Image". Do NOT guess model IDs.

You should also use atlas_get_model_info to understand what parameters a specific image model accepts before calling this tool.

Input files: image, video and audio inputs must be public URLs. For a file on the user's machine, upload it first — with atlas_get_upload_url on a hosted connection (POST the bytes to the upload_url it returns and wait for that command to finish) or atlas_upload_media on a local one — then pass the returned url. Do not inline the file as base64 or a data: URI, and do not call the Atlas REST API yourself with curl: this connection already carries the user's credentials, and there is no API key to use.

Args:
  - model (string, required): The exact image model ID. Use atlas_list_models to find valid IDs.
  - params (object, required): Model-specific parameters as a JSON object. Each model has different parameters defined in its schema. Common params include "prompt", "image_size", "num_inference_steps", etc. For image-to-3D models, "image" is required. Use atlas_get_model_info to see the full parameter list for your chosen model.

Returns:
  A prediction ID to check the result with atlas_get_prediction.`,
      inputSchema: {
        idempotency_key: idempotencyKeySchema,
        confirmation_token: generationConfirmationTokenSchema,
        model: z.string().min(1).describe("Image model ID"),
        params: z
          .record(z.unknown())
          .describe(
            "Model-specific parameters as JSON object. Use atlas_get_model_info to see available parameters for your chosen model."
          ),
      },
      outputSchema: generationOutputSchema,
      annotations: toolAnnotations("atlas_generate_image"),
    },
    async ({ idempotency_key, confirmation_token, model, params }) => {
      try {
        const preparation = await prepareGeneration(model, params, {
          expectedType: "Image",
          endpoint: "/model/generateImage",
          typeLabel: "image",
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

        // 报价只在第一次调用时取：带着 confirmation_token 进来的那次已经
        // 问过价了，再问一遍等于每次生成多一个来回。
        let spend: SpendDecision | null = null;
        if (!confirmation_token) {
          spend = await evaluateSpend(prepared.body);
        }
        if (spend && !spend.autoSubmit) {
          const confirmation = issueGenerationConfirmation(
            "atlas_generate_image",
            idempotency_key,
            confirmedRequest,
            prepared.model.price
          );
          return {
            structuredContent: generationConfirmationStructuredContent(
              prepared.model,
              "image",
              confirmation,
              costEstimate(spend)
            ),
            content: [
              {
                type: "text",
                text:
                  `Confirmation required — no billable request was submitted and no credits were spent.\n\n` +
                  `- **Model**: ${prepared.model.displayName} (\`${prepared.model.model}\`)\n` +
                  `${confirmationCostNotice(spend)}\n` +
                `- **Catalog unit price**: ${formatGenerationPricing(confirmation.pricing)}\n` +
                  `${confirmationValidityNotice(confirmation.expiresAt)}\n\n` +
                  `Show the user this model and the estimated cost above, then stop. Do not call this or any generation tool again until the user explicitly confirms in a new message. After confirmation, reuse the same idempotency_key and unchanged arguments with the returned confirmation_token.`,
              },
            ],
          };
        }

        // 走到这里没有 token，说明是低于阈值直接提交的那条路——本来就没有
        // 报价可校验。有 token 才校验：它证明用户确认的正是这次的模型与价格。
        if (confirmation_token) {
          verifyGenerationConfirmation(
            confirmation_token,
            "atlas_generate_image",
            idempotency_key,
            confirmedRequest,
            prepared.model.price
          );
        }
        const result = await executeIdempotently(
          "atlas_generate_image",
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

        // 同步完成的模型（结果已在提交响应里）不该被当成待轮询任务：
        // 直接给出结果与图片块，模型不必再多打一次接口，用户也立刻看到图。
        const finished =
          result.outputs.length > 0 ? await completedOutputContent(result.outputs, { profile: currentClientProfile() }) : null;

        return {
          structuredContent: {
            ...generationStructuredContent(
            result.predictionId,
            result.model,
            "image"
            ),
            ...(finished ? { status: "completed" as const, outputs: result.outputs } : {}),
          },
          content: [
            {
              type: "text",
              text: finished
                ? `Image generation completed.\n\n` +
                  `- **Model**: ${result.model.displayName} (\`${result.model.model}\`)\n` +
                  (spend ? `${autoSubmitNotice(spend)}\n` : "") +
                  `\n` + finished.text
                :
                `Image generation submitted successfully.\n\n` +
                `- **Model**: ${result.model.displayName} (\`${result.model.model}\`)\n` +
                `- **Prediction ID**: \`${result.predictionId}\`\n` +
                (spend ? `${autoSubmitNotice(spend)}\n` : "") +
                `\n` +
                `The image is being generated. Use \`atlas_get_prediction\` with this ID to check the result.\n` +
                `Image generation usually takes 10-30 seconds (3D models can take 2-5 minutes).`
            },
            ...(finished ? finished.blocks : []),
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
