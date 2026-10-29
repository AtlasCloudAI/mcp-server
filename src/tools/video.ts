import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { quoteBalanceNotice } from "../services/quote-balance.js";
import { z } from "zod";
import {
  prepareGeneration,
  submitPreparedGeneration,
} from "../services/generation.js";
import {
  formatGenerationPricing,
  issueGenerationConfirmation,
  resolveConfirmedIdempotencyKey,
} from "../services/generation-confirmation.js";
import { executeIdempotently } from "../services/idempotency.js";
import { defaultRouteGuidance } from "../services/default-models.js";
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
  confirmationReuseNotice,
  confirmationValidityNotice,
} from "../services/spend-policy.js";
import {
  generationOutputSchema,
  generationConfirmationStructuredContent,
  generationConfirmationTokenSchema,
  generationConfirmedSchema,
  generationStructuredContent,
  idempotencyKeySchema,
} from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";
import {
  generationToolCardMeta,
  withGenerationCard,
} from "../apps/generation-quote.js";

export function registerVideoTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_video",
    {
      title: "Generate Video",
      description: `Generate a video using Atlas Cloud API.

This tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

Pricing: a call without confirmed: true only prices the request. It returns the model, an estimated cost, the current balance when it can be read, and a confirmation_token, and it starts nothing, so nothing is billed. The job starts on a later call with confirmed: true, the same arguments and idempotency_key, and that confirmation_token; if the token was lost, the server matches the quote from the unchanged arguments. A job that ends in status "failed" is not billed. A deployment may set an auto-submit limit; calls under it start right away and report the estimate.

Parameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.

IMPORTANT: The "model" parameter requires an exact current model ID. If you don't know it, first call atlas_list_models with type="Video". Do NOT guess model IDs.

${defaultRouteGuidance("Video")}

You should also use atlas_get_model_info to see the full parameter list and schema for your chosen video model before calling this tool.

Input files: image, video and audio inputs are public URLs. A file on the user's machine is uploaded first with atlas_get_upload_url on a hosted connection or atlas_upload_media on a local one, and the returned url goes into params. Base64 and data: URIs are not accepted. This connection already carries the user's Atlas credentials, so no API key is involved.

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
        confirmed: generationConfirmedSchema,
        model: z.string().min(1).describe("Video model ID"),
        params: z
          .record(z.unknown())
          .describe(
            "Model-specific parameters as JSON object. Use atlas_get_model_info to see available parameters for your chosen model."
          ),
      },
      outputSchema: generationOutputSchema,
      annotations: toolAnnotations("atlas_generate_video"),
      ...generationToolCardMeta(),
    },
    withGenerationCard(server, "atlas_generate_video", async ({ idempotency_key, confirmation_token, confirmed, model, params }) => {
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
        // 报价只在第一次调用时取：带着 confirmation_token 进来的那次已经
        // 问过价了，再问一遍等于每次生成多一个来回。
        let spend: SpendDecision | null = null;
        if (!confirmation_token && !confirmed) {
          spend = await evaluateSpend(prepared.body);
        }
        if (spend && !spend.autoSubmit) {
          // 余额和报价记录并行取：读余额最多 1.5 秒，失败就不显示这一行。
          const balanceLinePromise = quoteBalanceNotice(costEstimate(spend).usd);
          const confirmation = await issueGenerationConfirmation(
            "atlas_generate_video",
            idempotency_key,
            confirmedRequest,
            prepared.model.price
          );
          const balanceLine = await balanceLinePromise;
          return {
            structuredContent: generationConfirmationStructuredContent(
              prepared.model,
              "video",
              confirmation,
              costEstimate(spend),
              prepared.body
            ),
            content: [{
              type: "text",
              text:
                `Confirmation required — no billable request was submitted and no credits were spent.\n\n` +
                `- **Model**: ${prepared.model.displayName} (\`${prepared.model.model}\`)\n` +
                `${confirmationCostNotice(spend)}\n` +
                  `${balanceLine ? `${balanceLine}\n` : ""}` +
                `- **Catalog unit price**: ${formatGenerationPricing(confirmation.pricing)}\n` +
                `${confirmationReuseNotice(confirmation.idempotencyKey)}\n` +
                `${confirmationValidityNotice(confirmation.expiresAt)}\n\n` +
                `Show the user this model and the estimated cost above, then stop. Do not call this or any generation tool again until the user explicitly confirms in a new message. After confirmation, call again with unchanged arguments, confirmed: true, the idempotency_key above and the confirmation_token.`,
            }],
          };
        }
        // 走到这里没有 token，说明是低于阈值直接提交的那条路——本来就没有
        // 报价可校验。有 token 才校验：它证明用户确认的正是这次的模型与价格。
        // 带了令牌或标明已确认：解析这一单该用的幂等键（令牌抄错、幂等键丢了时按报价记录找回）。
        const confirmedKey =
          confirmation_token || confirmed
            ? await resolveConfirmedIdempotencyKey(confirmation_token, "atlas_generate_video", idempotency_key, confirmedRequest, prepared.model.price)
            : { idempotencyKey: idempotency_key };
        const submitKey = confirmedKey.idempotencyKey;
        const result = await executeIdempotently(
          "atlas_generate_video",
          { idempotency_key: submitKey, ...confirmedRequest },
          submitKey,
          () => submitPreparedGeneration(prepared, submitKey)
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
            "video"
            ),
            ...(finished ? { status: "completed" as const, outputs: result.outputs } : {}),
          },
          content: [
            {
              type: "text",
              text: finished
                ? `Video generation completed.\n\n` +
                  `- **Model**: ${result.model.displayName} (\`${result.model.model}\`)\n` +
                  (spend ? `${autoSubmitNotice(spend)}\n` : "") +
                  `\n` + finished.text
                :
                `Video generation submitted successfully.\n\n` +
                `- **Model**: ${result.model.displayName} (\`${result.model.model}\`)\n` +
                `- **Prediction ID**: \`${result.predictionId}\`\n` +
                (spend ? `${autoSubmitNotice(spend)}\n` : "") +
                `\n` +
                `The video is being generated. Use \`atlas_get_prediction\` with this ID to check the result.\n` +
                `Video generation typically takes 1-5 minutes.`
            },
            ...(finished ? finished.blocks : []),
            ...(confirmedKey.notice ? [{ type: "text" as const, text: confirmedKey.notice }] : []),
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    })
  );
}
