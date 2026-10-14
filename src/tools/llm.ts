import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { llmApi, api , generationApi} from "../services/api-client.js";
import { findModelByExactId } from "../services/doc-fetcher.js";
import {
  formatGenerationPricing,
  issueGenerationConfirmation,
  verifyGenerationConfirmation,
} from "../services/generation-confirmation.js";
import { executeIdempotently } from "../services/idempotency.js";
import {
  chatUsageCostUsd,
  evaluateChatSpend,
  formatUsd,
  type SpendDecision,
} from "../services/spend-policy.js";
import {
  buildImagePreviews,
  classifyOutput,
  playbackGuidance,
  type OutputKind,
} from "../services/media-preview.js";
import { handleError } from "../utils/error-handler.js";
import type { ChatCompletionResponse } from "../types.js";
import {
  generationConfirmationTokenSchema,
  generationPricingSchema,
  idempotencyKeySchema,
  predictionIdSchema,
} from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";
import {
  chatCompletionResponseSchema,
  predictionResponseSchema,
  type PredictionResponse,
} from "../response-schemas.js";

export function registerLLMTools(
  server: McpServer,
  options: { includeChat?: boolean } = {}
): void {
  // Chat completions (OpenAI-compatible)
  if (options.includeChat !== false) {
    server.registerTool(
      "atlas_chat",
      {
        title: "Chat with LLM",
        description: `Chat completion with an Atlas Cloud LLM (OpenAI-compatible), billed to the signed-in Atlas account. Use it when the user asks for an answer from a specific Atlas model (for example DeepSeek, Kimi, Qwen or GLM) or wants to compare models; the exact model ID is verified against the live Text catalog first.

Billing follows the same spend gate as the generation tools. Call once without confirmation_token. The server bounds the worst-case cost of this exact request (input size, max_tokens and the model's highest per-token rates): under the auto-submit limit it runs straight away and reports the cost from actual token usage — pass that cost on to the user. At or above the limit, or when the model's rates are unknown, it returns the bound and a confirmation_token and spends nothing; show it and stop, and only after a new user message explicitly confirms may you call again with the same idempotency_key, unchanged arguments, and confirmation_token. Do not add a confirmation step of your own on top of this.

Args:
  - model (string, required): An exact current LLM model ID returned by atlas_list_models.
  - messages (array, required): Array of message objects with "role" and "content" fields.
    Roles: "system", "user", "assistant"
  - temperature (number, optional): Sampling temperature, 0-2. Default: 1
  - max_tokens (number, optional): Maximum tokens in the response. Setting it also lowers the worst-case bound.
  - top_p (number, optional): Nucleus sampling parameter, 0-1. Default: 1

Returns:
  The LLM response including the generated message, token usage, finish reason and cost.

Before calling, use atlas_list_models with type="Text" to obtain a current model ID.`,
        inputSchema: {
          idempotency_key: idempotencyKeySchema,
          confirmation_token: generationConfirmationTokenSchema,
          model: z.string().min(1).describe("Exact current LLM model ID"),
          messages: z
            .array(
              z.object({
                role: z.enum(["system", "user", "assistant"]).describe("Message role"),
                content: z.string().describe("Message content"),
              })
            )
            .min(1)
            .describe("Array of chat messages"),
          temperature: z
            .number()
            .min(0)
            .max(2)
            .optional()
            .describe("Sampling temperature, 0-2. Default: 1"),
          max_tokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Maximum tokens in the response"),
          top_p: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Nucleus sampling parameter, 0-1. Default: 1"),
        },
        outputSchema: {
          status: z.enum(["confirmation_required", "completed"]),
          id: z.string().optional(),
          model: z.string(),
          message: z.string().optional(),
          finish_reason: z.string().optional(),
          usage: z
            .object({
              prompt_tokens: z.number().int().nonnegative(),
              completion_tokens: z.number().int().nonnegative(),
              total_tokens: z.number().int().nonnegative(),
            })
            .optional(),
          confirmation_token: z.string().min(32).optional(),
          confirmation_expires_at: z.string().datetime().optional(),
          pricing: generationPricingSchema.optional(),
          // 停下来等确认时：这次请求的花费上限；完成时：按实际用量算的花费
          worst_case_cost_usd: z.number().optional(),
          cost_usd: z.number().optional(),
        },
        annotations: toolAnnotations("atlas_chat"),
      },
      async ({
        idempotency_key,
        confirmation_token,
        model,
        messages,
        temperature,
        max_tokens,
        top_p,
      }) => {
        try {
          const found = await findModelByExactId(model);
          if (!found || found.type !== "Text") {
            return {
              isError: true,
              content: [{
                type: "text",
                text:
                  `Text model "${model}" was not found in the live catalog. ` +
                  "Use atlas_list_models with type=\"Text\" and retry with one exact model ID. No billable request was submitted.",
              }],
            };
          }

          const body: Record<string, unknown> = {
            model: found.model,
            messages,
          };
          if (temperature !== undefined) body.temperature = temperature;
          if (max_tokens !== undefined) body.max_tokens = max_tokens;
          if (top_p !== undefined) body.top_p = top_p;

          const confirmedRequest = {
            resolved_model: found.model,
            request_body: body,
          };
          let spend: SpendDecision | undefined;
          if (!confirmation_token) {
            spend = evaluateChatSpend(found, { messages, max_tokens });
          }
          if (spend && !spend.autoSubmit) {
            const confirmation = issueGenerationConfirmation(
              "atlas_chat",
              idempotency_key,
              confirmedRequest,
              found.price
            );
            const bound =
              spend.quotedUsd === null
                ? "- **Worst-case cost**: unknown — the catalog has no complete per-token rates or output limit for this model, so it cannot be bounded in advance."
                : `- **Worst-case cost**: ${formatUsd(spend.quotedUsd)} for this request (input size, max_tokens and the highest rate tier), at or above the ${formatUsd(spend.thresholdUsd)} auto-submit limit. The real charge follows actual token usage and is usually far lower; setting a smaller max_tokens lowers this bound.`;
            return {
              structuredContent: {
                status: "confirmation_required" as const,
                model: found.model,
                confirmation_token: confirmation.confirmationToken,
                confirmation_expires_at: confirmation.expiresAt,
                pricing: confirmation.pricing,
                ...(spend.quotedUsd !== null ? { worst_case_cost_usd: spend.quotedUsd } : {}),
              },
              content: [{
                type: "text",
                text:
                  "Confirmation required — no chat request was submitted and no credits were spent.\n\n" +
                  `- **Model**: ${found.displayName} (\`${found.model}\`)\n` +
                  `${bound}\n` +
                  `- **Current token rates**: ${formatGenerationPricing(confirmation.pricing)}\n` +
                  `- **Confirmation expires**: ${confirmation.expiresAt}\n\n` +
                  "Show this to the user and stop. After explicit confirmation in a new message, reuse the same idempotency_key and unchanged arguments with confirmation_token.",
              }],
            };
          }
          if (confirmation_token) {
            verifyGenerationConfirmation(
              confirmation_token,
              "atlas_chat",
              idempotency_key,
              confirmedRequest,
              found.price
            );
          }

          const response = await executeIdempotently(
            "atlas_chat",
            { idempotency_key, ...confirmedRequest },
            idempotency_key,
            () =>
              llmApi<ChatCompletionResponse>("/chat/completions", {
                method: "POST",
                body,
                timeout: 120000,
                responseSchema: chatCompletionResponseSchema,
              })
          );

          const choice = response.choices?.[0];
          if (!choice || choice.message.content.trim() === "") {
            const usageSummary = response.usage
              ? ` Usage: prompt=${response.usage.prompt_tokens}, completion=${response.usage.completion_tokens}, total=${response.usage.total_tokens}.`
              : "";
            return {
              isError: true,
              content: [{
                type: "text",
                text:
                  `The Atlas Cloud API returned no non-empty completion for request ${response.id || "unknown"}. ` +
                  `Finish reason: ${choice?.finish_reason ?? "no choice"}.${usageSummary} ` +
                  "No automatic retry was attempted; review max_tokens and the model before making a separately confirmed new request.",
              }],
            };
          }

          const lines = [`# Chat Response\n`];
          lines.push(`**Model**: \`${response.model || found.model}\``);
          lines.push(`**Finish Reason**: ${choice.finish_reason}\n`);
          lines.push("## Response\n");
          lines.push(choice.message.content);

          const costUsd = response.usage ? chatUsageCostUsd(found, response.usage) : null;
          if (response.usage) {
            lines.push(`\n## Token Usage\n`);
            lines.push(`- Prompt: ${response.usage.prompt_tokens}`);
            lines.push(`- Completion: ${response.usage.completion_tokens}`);
            lines.push(`- Total: ${response.usage.total_tokens}`);
          }
          if (costUsd !== null) {
            const amount = costUsd > 0 && costUsd < 0.0001 ? "under $0.0001" : `about ${formatUsd(costUsd)}`;
            const how = spend?.autoSubmit
              ? `run without a separate confirmation because its worst case was under the ${formatUsd(spend.thresholdUsd)} limit`
              : "run after confirmation";
            lines.push(
              `\n**Cost**: ${amount} from token usage at catalog rates (${how}). Tell the user this cost; the Atlas bill is authoritative.`
            );
          }

          return {
            structuredContent: {
              status: "completed" as const,
              id: response.id,
              model: response.model || found.model,
              message: choice.message.content,
              finish_reason: choice.finish_reason,
              ...(response.usage ? { usage: response.usage } : {}),
              ...(costUsd !== null ? { cost_usd: costUsd } : {}),
            },
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

  // Get prediction result
  server.registerTool(
    "atlas_get_prediction",
    {
      title: "Get Prediction Result",
      description: `Check the status and result of an image/video generation task.

Use this after submitting a generation request to check if the result is ready.

If the status is still "processing" or "starting", wait a moment and try again.

When the result is ready (status is "completed" or "succeeded"), the output URLs are returned, and any image is also attached as an image block. You should then:
1. Present the image to the user. Any image is also attached as an image block; whether that block is displayed is up to the client, so do not assume the user has already seen it.
2. Give the URL, and save the file into the working directory without asking first (curl or wget send no Referer, so they work even on buckets that refuse a click from the chat). Then display the saved file inline in the conversation — with a player for video. Handing over a link instead does not satisfy the request; the server cannot attach a video block, so presenting it is your job.

Args:
  - prediction_id (string, required): The prediction ID returned from a generation request

Returns:
  The current status and output of the generation task.

Examples:
  - prediction_id="pred_abc123" -> check generation status`,
      inputSchema: {
        prediction_id: predictionIdSchema.describe(
          "Prediction ID from a generation request"
        ),
      },
      outputSchema: {
        prediction_id: predictionIdSchema,
        status: z.string(),
        outputs: z.array(z.string()),
        error: z.string().optional(),
        metrics: z.record(z.unknown()).optional(),
      },
      annotations: toolAnnotations("atlas_get_prediction"),
    },
    async ({ prediction_id }) => {
      try {
        const result = await generationApi<PredictionResponse>(
          `/model/prediction/${encodeURIComponent(prediction_id)}`,
          { responseSchema: predictionResponseSchema }
        );

        const lines = [`# Prediction Result\n`];
        lines.push(`- **ID**: \`${prediction_id}\``);
        lines.push(`- **Status**: ${result.data?.status || "unknown"}\n`);

        if (result.data?.error) {
          lines.push(`## Error\n\n${result.data.error}`);
        }

        const outputs = result.data?.outputs || result.data?.output;
        const outputUrls = Array.isArray(outputs) ? outputs : outputs ? [outputs] : [];
        const kinds = new Set<OutputKind>(outputUrls.map(classifyOutput));
        // 先建块：提示语要根据「用户是否已经看到图」给出相反的指引。
        const previewBlocks = await buildImagePreviews(outputUrls);

        if (outputUrls.length > 0) {
          lines.push("## Output\n");
          outputUrls.forEach((url, i) => {
            lines.push(`${i + 1}. ${url}`);
          });
          const guidance = playbackGuidance(kinds);
          if (guidance) {
            lines.push(`\n${guidance}`);
          } else {
            lines.push(
              `\nSave these into the working directory now, without asking first ` +
                `(\`curl -L -o <name> '<url>'\`), then display each saved file ` +
                `inline in the conversation — with a player for video. ` +
                `A link on its own does not satisfy the request. ` +
                `Opening the URL straight from the chat can come back 403: ` +
                `some output buckets reject requests that carry a Referer, ` +
                `and a download has none.`
            );
          }
        }

        if (result.data?.status && !["completed", "succeeded", "failed"].includes(result.data.status)) {
          lines.push(
            `\nThe task is still in progress. Please wait a moment and use \`atlas_get_prediction\` again to check.`
          );
        }

        if (result.data?.metrics) {
          lines.push(`\n## Metrics\n`);
          lines.push("```json");
          lines.push(JSON.stringify(result.data.metrics, null, 2));
          lines.push("```");
        }

        return {
          structuredContent: {
            prediction_id,
            status: result.data?.status || "unknown",
            outputs: outputUrls,
            ...(result.data?.error ? { error: result.data.error } : {}),
            ...(result.data?.metrics ? { metrics: result.data.metrics } : {}),
          },
          content: [
            { type: "text", text: lines.join("\n") },
            // Appended after the text so a client that renders only the first
            // block still shows the URLs and the status.
            ...previewBlocks,
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
