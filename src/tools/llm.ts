import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { llmApi, api } from "../services/api-client.js";
import { findModelByExactId } from "../services/doc-fetcher.js";
import {
  formatGenerationPricing,
  issueGenerationConfirmation,
  verifyGenerationConfirmation,
} from "../services/generation-confirmation.js";
import { executeIdempotently } from "../services/idempotency.js";
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
        description: `Two-step chat completion through the Atlas Cloud OpenAI-compatible API. The exact model ID is verified against the live Text catalog before any billable request.

Billing confirmation is mandatory. The first call MUST omit confirmation_token and returns only the exact model and current input/output token rates; it does not submit or spend credits. Show those rates and stop. Only after a new user message explicitly confirms may you repeat the call with the same idempotency_key, unchanged arguments, and confirmation_token. Rates are per million tokens, not a guaranteed total; max_tokens bounds output length but not the final billed total.

Args:
  - model (string, required): An exact current LLM model ID returned by atlas_list_models.
  - messages (array, required): Array of message objects with "role" and "content" fields.
    Roles: "system", "user", "assistant"
  - temperature (number, optional): Sampling temperature, 0-2. Default: 1
  - max_tokens (number, optional): Maximum tokens in the response
  - top_p (number, optional): Nucleus sampling parameter, 0-1. Default: 1

Returns:
  The LLM response including the generated message, token usage, and finish reason.

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
          if (!confirmation_token) {
            const confirmation = issueGenerationConfirmation(
              "atlas_chat",
              idempotency_key,
              confirmedRequest,
              found.price
            );
            return {
              structuredContent: {
                status: "confirmation_required" as const,
                model: found.model,
                confirmation_token: confirmation.confirmationToken,
                confirmation_expires_at: confirmation.expiresAt,
                pricing: confirmation.pricing,
              },
              content: [{
                type: "text",
                text:
                  "Confirmation required — no chat request was submitted and no credits were spent.\n\n" +
                  `- **Model**: ${found.displayName} (\`${found.model}\`)\n` +
                  `- **Current token rates**: ${formatGenerationPricing(confirmation.pricing)}\n` +
                  `- **Confirmation expires**: ${confirmation.expiresAt}\n\n` +
                  "These are unit rates, not a guaranteed total. Show them to the user and stop. After explicit confirmation in a new message, reuse the same idempotency_key and unchanged arguments with confirmation_token.",
              }],
            };
          }
          verifyGenerationConfirmation(
            confirmation_token,
            "atlas_chat",
            idempotency_key,
            confirmedRequest,
            found.price
          );

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

          if (response.usage) {
            lines.push(`\n## Token Usage\n`);
            lines.push(`- Prompt: ${response.usage.prompt_tokens}`);
            lines.push(`- Completion: ${response.usage.completion_tokens}`);
            lines.push(`- Total: ${response.usage.total_tokens}`);
          }

          return {
            structuredContent: {
              status: "completed" as const,
              id: response.id,
              model: response.model || found.model,
              message: choice.message.content,
              finish_reason: choice.finish_reason,
              ...(response.usage ? { usage: response.usage } : {}),
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

When the result is ready (status is "completed" or "succeeded"), the output URLs will be returned. You should then:
1. Show the output URLs to the user
2. Ask the user if they want to download the file to their local machine (you can use curl or wget to download it)

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
        const result = await api<PredictionResponse>(
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

        if (outputUrls.length > 0) {
          lines.push("## Output\n");
          outputUrls.forEach((url, i) => {
            lines.push(`${i + 1}. ${url}`);
          });
          lines.push(
            `\nYou can ask me to download these files to your local machine, or open the URLs directly in your browser.`
          );
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
