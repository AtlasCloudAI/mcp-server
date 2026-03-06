import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { llmApi, chatApi } from "../services/api-client.js";
import { handleError } from "../utils/error-handler.js";
import type { ChatCompletionResponse, PredictionResponse } from "../types.js";

export function registerLLMTools(server: McpServer): void {
  // Chat completions (OpenAI-compatible)
  server.registerTool(
    "atlas_chat",
    {
      title: "Chat with LLM",
      description: `Send a chat completion request to an LLM model via Atlas Cloud API (OpenAI-compatible format).

Args:
  - model (string, required): The LLM model ID (e.g., "openai/gpt-5.2", "deepseek/deepseek-v3.2")
  - messages (array, required): Array of message objects with "role" and "content" fields.
    Roles: "system", "user", "assistant"
  - temperature (number, optional): Sampling temperature, 0-2. Default: 1
  - max_tokens (number, optional): Maximum tokens in the response
  - top_p (number, optional): Nucleus sampling parameter, 0-1. Default: 1

Returns:
  The LLM response including the generated message, token usage, and finish reason.

Examples:
  - model="openai/gpt-5.2", messages=[{"role": "user", "content": "Hello"}]
  - model="deepseek/deepseek-v3.2", messages=[{"role": "system", "content": "You are a helpful assistant"}, {"role": "user", "content": "Explain quantum computing"}], temperature=0.7`,
      inputSchema: {
        model: z.string().min(1).describe("LLM model ID"),
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, messages, temperature, max_tokens, top_p }) => {
      try {
        const body: Record<string, unknown> = {
          model,
          messages,
        };
        if (temperature !== undefined) body.temperature = temperature;
        if (max_tokens !== undefined) body.max_tokens = max_tokens;
        if (top_p !== undefined) body.top_p = top_p;

        const response = await llmApi<ChatCompletionResponse>("/chat/completions", {
          method: "POST",
          body,
          timeout: 120000, // LLM responses can be slow
        });

        const choice = response.choices?.[0];
        if (!choice) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `No response from model. Raw response: ${JSON.stringify(response)}`,
              },
            ],
          };
        }

        const lines = [`# Chat Response\n`];
        lines.push(`**Model**: \`${response.model || model}\``);
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

  // Get prediction result
  server.registerTool(
    "atlas_get_prediction",
    {
      title: "Get Prediction Result",
      description: `Check the status and result of an image/video generation task.

Use this after starting a generation with wait_for_result=false, or to re-check a previous generation.

Args:
  - prediction_id (string, required): The prediction ID returned from a generation request

Returns:
  The current status and output of the generation task.

Examples:
  - prediction_id="pred_abc123" -> check generation status`,
      inputSchema: {
        prediction_id: z
          .string()
          .min(1)
          .describe("Prediction ID from a generation request"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ prediction_id }) => {
      try {
        const result = await chatApi<PredictionResponse>(
          `/model/prediction/${prediction_id}`
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
