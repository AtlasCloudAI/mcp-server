import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { llmApi } from "../services/api-client.js";
import { findModel } from "../services/doc-fetcher.js";
import { handleError } from "../utils/error-handler.js";
import { truncate } from "../utils/formatter.js";
import {
  MODEL_PROTOCOLS,
  buildChatPath,
  buildChatRequestBody,
  extractFinishReason,
  extractResponseText,
  extractUsage,
  isMediaSupportedByProtocol,
  isProtocolImplemented,
  resolveChatProtocol,
  resolveDeclaredProtocol,
} from "../services/protocols.js";
import type { ChatTurn, MediaInput, Model } from "../types.js";

// Media a caller attached to one message, in the order we advertise them
const MEDIA_KEYS = [
  ["images", "image"],
  ["videos", "video"],
  ["audios", "audio"],
] as const;

interface RawMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
  videos?: string[];
  audios?: string[];
}

/** Collect the media attached to a message into protocol-neutral inputs. */
function mediaOf(message: RawMessage): MediaInput[] {
  const media: MediaInput[] = [];
  for (const [key, kind] of MEDIA_KEYS) {
    for (const url of message[key] ?? []) {
      if (typeof url === "string" && url.trim()) {
        media.push({ kind, url: url.trim() });
      }
    }
  }
  return media;
}

/**
 * Warn about media that will not reach the model.
 * Two independent reasons: the model may not accept that modality at all
 * (`input_modalities`), or the protocol may have no way to express it.
 */
function mediaWarnings(
  turns: ChatTurn[],
  protocol: (typeof MODEL_PROTOCOLS)[keyof typeof MODEL_PROTOCOLS],
  model?: Model | null
): string[] {
  const attached = new Set(turns.flatMap((t) => (t.media ?? []).map((m) => m.kind)));
  if (attached.size === 0) return [];

  const warnings: string[] = [];
  const modalities = model?.input_modalities;

  for (const kind of attached) {
    if (Array.isArray(modalities) && modalities.length > 0 && !modalities.includes(kind)) {
      warnings.push(
        `The model does not accept ${kind} input (input modalities: ${modalities.join(", ")}). The ${kind} attachments were sent anyway and may be rejected.`
      );
      continue;
    }
    if (!isMediaSupportedByProtocol(protocol, kind)) {
      warnings.push(
        `The \`${protocol}\` protocol has no ${kind} content part, so the ${kind} attachments were dropped.`
      );
    }
  }

  if (
    attached.has("audio") &&
    (protocol === MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS ||
      protocol === MODEL_PROTOCOLS.OPENAI_RESPONSES)
  ) {
    warnings.push(
      "On OpenAI-style protocols audio must be inlined as a `data:audio/...;base64,` URI — plain http(s) audio URLs cannot be expressed and were dropped."
    );
  }

  return warnings;
}

export function registerLLMTools(server: McpServer): void {
  // Chat completions, dispatched to whichever protocol the model speaks
  server.registerTool(
    "atlas_chat",
    {
      title: "Chat with LLM",
      description: `Send a chat request to an LLM on Atlas Cloud.

The endpoint and request format are chosen automatically from the model's declared protocol — OpenAI chat completions, OpenAI Responses, Anthropic Messages, or native Gemini generateContent. You do not need to know which one a model uses.

Multimodal input is supported for models that accept it: attach image/video/audio URLs (or data: URIs) to a message and they are converted to the right shape for that model's protocol. Use atlas_get_model_info to see a model's input modalities.

Args:
  - model (string, required): The LLM model ID (e.g. "deepseek-ai/deepseek-v3.2", "google/gemini-3.1-flash-lite")
  - messages (array, required): Message objects with "role" ("system" | "user" | "assistant") and "content" (text).
    Optional per message: "images", "videos", "audios" — arrays of URLs or data: URIs.
  - temperature (number, optional): Sampling temperature, 0-2.
  - max_tokens (number, optional): Maximum tokens in the response.
  - top_p (number, optional): Nucleus sampling, 0-1.
  - extra_params (object, optional): Additional sampling parameters passed through unchanged
    (e.g. {"top_k": 40, "seed": 7, "stop": ["\\n\\n"], "frequency_penalty": 0.2}).
    Check atlas_get_model_info for the parameters a model supports. Ignored on the Gemini protocol.

Returns:
  The generated message, finish reason and token usage.

Examples:
  - model="deepseek-ai/deepseek-v3.2", messages=[{"role": "user", "content": "Hello"}]
  - model="qwen/qwen3.7-plus", messages=[{"role": "system", "content": "You are a helpful assistant"}, {"role": "user", "content": "Explain quantum computing"}], temperature=0.7
  - model="google/gemini-3.1-flash-lite", messages=[{"role": "user", "content": "What is in this picture?", "images": ["https://example.com/photo.jpg"]}]`,
      inputSchema: {
        model: z.string().min(1).describe("LLM model ID"),
        messages: z
          .array(
            z.object({
              role: z
                .enum(["system", "user", "assistant"])
                .describe("Message role"),
              content: z.string().describe("Message text"),
              images: z
                .array(z.string())
                .optional()
                .describe("Image URLs or data: URIs to attach to this message"),
              videos: z
                .array(z.string())
                .optional()
                .describe("Video URLs or data: URIs to attach to this message"),
              audios: z
                .array(z.string())
                .optional()
                .describe(
                  "Audio URLs or data: URIs. OpenAI-style protocols require a base64 data: URI"
                ),
            })
          )
          .min(1)
          .describe("Array of chat messages"),
        temperature: z
          .number()
          .min(0)
          .max(2)
          .optional()
          .describe("Sampling temperature, 0-2"),
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
          .describe("Nucleus sampling parameter, 0-1"),
        extra_params: z
          .record(z.unknown())
          .optional()
          .describe(
            "Additional sampling parameters passed through unchanged (top_k, seed, stop, penalties, ...)"
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, messages, temperature, max_tokens, top_p, extra_params }) => {
      try {
        // Catalogue lookup is advisory: an unlisted model still gets called,
        // it just falls back to the default protocol.
        let found: Model | null = null;
        try {
          found = (await findModel(model)) ?? null;
        } catch {
          found = null;
        }

        const declared = resolveDeclaredProtocol(found?.supported_protocols);
        const protocol = resolveChatProtocol(found?.supported_protocols);

        if (!isProtocolImplemented(declared)) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `Model \`${model}\` speaks the \`${declared}\` protocol, which atlas_chat cannot call.\n\n` +
                  (declared === MODEL_PROTOCOLS.OPENAI_IMAGES
                    ? "This is an image-generation endpoint, not a chat model. Use `atlas_generate_image` or call `POST /v1/images/generations` directly."
                    : "Call the endpoint directly, or pick a different model with `atlas_list_models`."),
              },
            ],
          };
        }

        const turns: ChatTurn[] = (messages as RawMessage[]).map((m) => ({
          role: m.role,
          text: m.content,
          media: mediaOf(m),
        }));

        const warnings = mediaWarnings(turns, protocol, found);

        const body = buildChatRequestBody(protocol, {
          model: found?.model || model,
          turns,
          maxTokens: max_tokens,
          temperature,
          topP: top_p,
          // Gemini's generationConfig has its own field names; passing OpenAI
          // sampling keys through would produce a body it rejects.
          extra:
            protocol === MODEL_PROTOCOLS.GEMINI_GENERATE
              ? undefined
              : extra_params,
        });

        const path = buildChatPath(protocol, found?.model || model);
        const response = await llmApi<Record<string, unknown>>(path, {
          method: "POST",
          body,
          timeout: 120000, // LLM responses can be slow
        });

        const text = extractResponseText(protocol, response);
        if (text === undefined) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `No response text found for \`${model}\` (protocol \`${protocol}\`).\n\n` +
                  `Raw response: ${JSON.stringify(response).slice(0, 2000)}`,
              },
            ],
          };
        }

        const lines = [`# Chat Response\n`];
        lines.push(`**Model**: \`${(response.model as string) || model}\``);
        lines.push(`**Protocol**: \`${protocol}\``);
        const finish = extractFinishReason(protocol, response);
        if (finish) lines.push(`**Finish Reason**: ${finish}`);
        lines.push("");

        if (warnings.length > 0) {
          warnings.forEach((w) => lines.push(`> ${w}`));
          lines.push("");
        }

        lines.push("## Response\n");
        lines.push(text);

        const usage = extractUsage(protocol, response);
        if (usage && (usage.prompt || usage.completion || usage.total)) {
          lines.push(`\n## Token Usage\n`);
          if (usage.prompt !== undefined) lines.push(`- Prompt: ${usage.prompt}`);
          if (usage.completion !== undefined) {
            lines.push(`- Completion: ${usage.completion}`);
          }
          if (usage.total !== undefined) lines.push(`- Total: ${usage.total}`);
        }

        return {
          content: [{ type: "text", text: truncate(lines.join("\n")) }],
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
