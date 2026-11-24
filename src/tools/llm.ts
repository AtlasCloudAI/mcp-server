import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRecordedCharge } from "../services/recorded-charge.js";
import { z } from "zod";
import { llmApi, api , generationApi} from "../services/api-client.js";
import { findModelByExactId } from "../services/doc-fetcher.js";
import {
  formatGenerationPricing,
  issueGenerationConfirmation,
  resolveConfirmedIdempotencyKey,
} from "../services/generation-confirmation.js";
import { executeIdempotently } from "../services/idempotency.js";
import {
  chatUsageCostUsd,
  applyDailyAutoSubmitBudget,
  evaluateChatSpend,
  settleAutoSpend,
  formatUsd,
  type SpendDecision,
  type AutoSpendReservation,
  confirmationValidSeconds,
  confirmationReuseNotice,
  confirmationValidityNotice,
} from "../services/spend-policy.js";
import {
  buildImagePreviews,
  classifyOutput,
  playbackGuidance,
  type OutputKind,
} from "../services/media-preview.js";
import { handleError } from "../utils/error-handler.js";
import type { ChatCompletionResponse, ChatTurn, MediaInput, Model } from "../types.js";
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
import {
  annotateToolCall as annotateLocalToolCall,
  sanitizeEnum,
  telemetryNumber,
} from "../telemetry/tool-call.js";
import {
  generationConfirmationTokenSchema,
  generationConfirmedSchema,
  generationPricingSchema,
  idempotencyKeySchema,
  predictionIdSchema,
} from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";
import { currentClientProfile } from "../services/client-profile.js";
import {
  CARD_META_KEY,
  clientRendersCards,
  generationCardEnabled,
  generationCardToolMeta,
  predictionCardData,
  CARD_PREDICTION_PARAMS,
  chargeStatusOf,
  priceOf,
  type ChargeStatus,
} from "../apps/generation-card.js";
import {
  annotateToolCall,
  chargeTelemetry,
  normalizeGenerationStatus,
  recordToolCallError,
  sanitizeModel,
  taskHash,
} from "../services/tool-call-telemetry.js";
import {
  completedAtOf,
  createdAtOf,
  hasUntransferredMedia,
  isActive,
  isFinished,
  secondsSince,
  predictionOutputUrls,
  predictionWaitSeconds,
  probeSizes,
  waitForPrediction,
} from "../services/prediction-wait.js";
import {
  chatCompletionResponseSchema,
  predictionResponseSchema,
  type PredictionResponse,
} from "../response-schemas.js";

/** 和卡片同一种写法：不足 1 美元时保留到 4 位小数（$0.015），至少 2 位。 */
function chargeUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  const trimmed = value.toFixed(4).replace(/0+$/, "");
  return `$${(trimmed.split(".")[1]?.length ?? 0) < 2 ? value.toFixed(2) : trimmed}`;
}

/**
 * 卡片已经显示出结果时，提醒模型别另画、另生成、另搜一张图（11-16 ChatGPT 回归 S12）。ChatGPT 用自己的
 * 图片搜索组件放了一张不相干的纸飞机，而且它只读结构化结果，所以这句也放进 structuredContent.card_note。
 */
export const RESULT_CARD_NOTE =
  "The user already sees this result in the Atlas card above, with the real media and a Download button. " +
  "Do not show any other picture of it: no image search results, no generated, illustrative or placeholder image. " +
  "Answer in a sentence or two with the status and what was actually charged.";

/** 查结果里没有扣费信息时：别说「没报」，去列表里看实扣。 */
export const CHARGE_NOT_IN_RECORD =
  "this record does not include the charge. atlas_list_predictions shows the amount actually charged " +
  "(charged_usd) for this prediction_id; check it there before telling the user what it cost.";

/** 对话回答停在 max_tokens 时给模型的下一步（11-18 ChatGPT 回归 O04）。 */
export const CHAT_TRUNCATED_NEXT_STEP =
  "This answer stopped at max_tokens (finish_reason: length) and is incomplete. Reasoning models spend part of " +
  "max_tokens on hidden reasoning. Tell the user the answer was cut off; to get the full answer, ask again with a " +
  "larger max_tokens (at least 1024).";

/**
 * 查结果里给模型看的一行扣费（需求文档 6.3：结算完才写实际费用，没结算完写待结算，
 * 不把未知费用说成 $0）。老网关没有 charge_status 时只在有价格时写价格。
 */
export function chargeLine(status: ChargeStatus | undefined, priceUsd: number | undefined): string | null {
  const usd = priceUsd !== undefined ? chargeUsd(priceUsd) : null;
  switch (status) {
    case "charged":
      return `- **Charge**: ${usd ?? "charged (amount not available yet)"}`;
    case "partially_charged":
      return `- **Charge**: ${usd ? `${usd}, ` : ""}a partial charge for the part of the job that ran`;
    case "pending":
      return "- **Charge**: pending settlement — the final amount is not known yet; do not report it as $0";
    case "not_charged":
      return "- **Charge**: not charged";
    case "refunded":
      return "- **Charge**: refunded";
    default:
      return usd ? `- **Charge**: ${usd}` : null;
  }
}


/** 结果已出、还在转存到 Atlas 存储时，结构化结果里给模型的下一步。 */
export const TRANSFER_NEXT_STEP =
  "The file is finished but still being copied to Atlas storage, so outputs is empty for now. " +
  "Call atlas_get_prediction again with this prediction_id in about 15 seconds and use the Atlas link it returns. " +
  "temporary_outputs are provider links that are slow from many networks and expire within 24 hours; " +
  "use them only if no Atlas link has appeared after about 5 minutes.";

// --- local (npm) server: protocol-aware chat, kept from npm 1.x ------------------
// The hosted atlas_chat calls /chat/completions with text messages. The local
// server keeps what 1.x did: call the protocol the model declares first
// (Gemini's native generateContent, Responses, Messages), attach images /
// video / audio to a message, and pass extra sampling parameters through.

const MEDIA_KEYS = [
  ["images", "image"],
  ["videos", "video"],
  ["audios", "audio"],
] as const;

interface LegacyChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
  videos?: string[];
  audios?: string[];
}

function mediaOf(message: LegacyChatMessage): MediaInput[] {
  const media: MediaInput[] = [];
  for (const [key, kind] of MEDIA_KEYS) {
    for (const url of message[key] ?? []) {
      if (typeof url === "string" && url.trim()) media.push({ kind, url: url.trim() });
    }
  }
  return media;
}

/** Media that will not reach the model: the model does not take that modality, or the protocol cannot carry it. */
function mediaWarnings(
  turns: ChatTurn[],
  protocol: (typeof MODEL_PROTOCOLS)[keyof typeof MODEL_PROTOCOLS],
  model: Model
): string[] {
  const attached = new Set(turns.flatMap((t) => (t.media ?? []).map((m) => m.kind)));
  if (attached.size === 0) return [];
  const warnings: string[] = [];
  const modalities = model.input_modalities;
  for (const kind of attached) {
    if (Array.isArray(modalities) && modalities.length > 0 && !modalities.includes(kind)) {
      warnings.push(
        `The model does not accept ${kind} input (input modalities: ${modalities.join(", ")}). The ${kind} attachments were sent anyway and may be rejected.`
      );
      continue;
    }
    if (!isMediaSupportedByProtocol(protocol, kind)) {
      warnings.push(`The \`${protocol}\` protocol has no ${kind} content part, so the ${kind} attachments were dropped.`);
    }
  }
  if (
    attached.has("audio") &&
    (protocol === MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS || protocol === MODEL_PROTOCOLS.OPENAI_RESPONSES)
  ) {
    warnings.push(
      "On OpenAI-style protocols audio must be inlined as a `data:audio/...;base64,` URI — plain http(s) audio URLs cannot be expressed and were dropped."
    );
  }
  return warnings;
}

// extra_params may not widen the cost bound (output length, choice count) or change the transport.
const EXTRA_PARAMS_RESERVED = new Set([
  "model",
  "messages",
  "stream",
  "n",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
]);

function chatExtraParams(extra: Record<string, unknown> | undefined): {
  extra?: Record<string, unknown>;
  dropped: string[];
} {
  if (!extra) return { dropped: [] };
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(extra)) {
    if (EXTRA_PARAMS_RESERVED.has(key)) dropped.push(key);
    else kept[key] = value;
  }
  return { ...(Object.keys(kept).length > 0 ? { extra: kept } : {}), dropped };
}

/** A non-chat-completions reply in the chat-completions shape the rest of the tool reads. */
function protocolChatResponse(
  protocol: (typeof MODEL_PROTOCOLS)[keyof typeof MODEL_PROTOCOLS],
  raw: Record<string, unknown>,
  model: string
): ChatCompletionResponse {
  const text = extractResponseText(protocol, raw) ?? "";
  const usage = extractUsage(protocol, raw);
  const prompt = usage?.prompt ?? 0;
  const completion = usage?.completion ?? 0;
  const id = typeof raw.id === "string" ? raw.id : typeof raw.responseId === "string" ? raw.responseId : "";
  const replyModel =
    typeof raw.model === "string" ? raw.model : typeof raw.modelVersion === "string" ? raw.modelVersion : model;
  return {
    id,
    object: "chat.completion",
    created: 0,
    model: replyModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: extractFinishReason(protocol, raw) ?? "stop",
      },
    ],
    ...(usage ? { usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: usage.total ?? prompt + completion } } : {}),
  };
}

const legacyMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]).describe("Message role"),
  content: z.string().describe("Message text"),
  images: z.array(z.string()).optional().describe("Image URLs or data: URIs to attach to this message"),
  videos: z.array(z.string()).optional().describe("Video URLs or data: URIs to attach to this message"),
  audios: z
    .array(z.string())
    .optional()
    .describe("Audio URLs or data: URIs. OpenAI-style protocols require a base64 data: URI"),
});

const LEGACY_CHAT_ARGS = `
  - messages[].images / videos / audios (string arrays, optional): Media to attach to a message (URLs or data: URIs). The request goes to the protocol the model declares first (OpenAI chat completions, OpenAI Responses, Anthropic Messages or Gemini generateContent). A request with attachments always stops for confirmation first: attachments add input tokens that cannot be counted in advance.
  - extra_params (object, optional): Additional sampling parameters passed through unchanged (top_k, seed, stop, penalties, ...). Output-length and stream keys are ignored; use max_tokens.`;

export function registerLLMTools(
  server: McpServer,
  options: { includeChat?: boolean; legacyParams?: boolean } = {}
): void {
  const legacy = options.legacyParams === true;
  // Chat completions (OpenAI-compatible)
  if (options.includeChat !== false) {
    server.registerTool(
      "atlas_chat",
      {
        title: "Chat with LLM",
        description: `Chat completion with an Atlas Cloud LLM (OpenAI-compatible), billed to the signed-in Atlas account. Use it when the user asks for an answer from a specific Atlas model (for example DeepSeek, Kimi, Qwen or GLM) or wants to compare models; the exact model ID is verified against the live Text catalog first.

Pricing: the server bounds the worst-case cost of this exact request (input size, max_tokens and the model's highest per-token rates). Under the auto-submit limit the request runs right away and the result reports the cost from actual token usage. At or above the limit, or when the model's rates are unknown, the call returns that bound and a confirmation_token and spends nothing; the request then runs on a later call with confirmed: true, the same arguments and idempotency_key, and that confirmation_token (if the token was lost, the server matches the quote from the unchanged arguments).

Args:
  - model (string, required): An exact current LLM model ID returned by atlas_list_models.
  - messages (array, required): Array of message objects with "role" and "content" fields.
    Roles: "system", "user", "assistant"
  - temperature (number, optional): Sampling temperature, 0-2. Default: 1
  - max_tokens (number, optional): Maximum tokens in the response. Setting it also lowers the worst-case bound. Reasoning models spend part of it on hidden reasoning, so do not set it below about 1024 for them, or the answer is cut off.
  - top_p (number, optional): Nucleus sampling parameter, 0-1. Default: 1${legacy ? LEGACY_CHAT_ARGS : ""}

Returns:
  The LLM response including the generated message, token usage, finish reason and cost.

Before calling, use atlas_list_models with type="Text" to obtain a current model ID.`,
        inputSchema: {
          // 本地版：npm 1.x 的 atlas_chat 没有这个参数，不给就由服务端生成（报价里会返回，确认时带回）。
          idempotency_key: legacy ? idempotencyKeySchema.optional() : idempotencyKeySchema,
          confirmation_token: generationConfirmationTokenSchema,
        confirmed: generationConfirmedSchema,
          model: z.string().min(1).describe("Exact current LLM model ID"),
          messages: legacy
            ? z.array(legacyMessageSchema).min(1).describe("Array of chat messages")
            : z
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
          ...(legacy
            ? {
                extra_params: z
                  .record(z.unknown())
                  .optional()
                  .describe("Additional sampling parameters passed through unchanged (top_k, seed, stop, penalties, ...)"),
              }
            : {}),
        },
        outputSchema: {
          status: z.enum(["confirmation_required", "completed"]),
          id: z.string().optional(),
          model: z.string(),
          message: z.string().optional(),
          finish_reason: z.string().optional(),
          truncated: z.boolean().optional(),
          next_step: z.string().optional(),
          usage: z
            .object({
              prompt_tokens: z.number().int().nonnegative(),
              completion_tokens: z.number().int().nonnegative(),
              total_tokens: z.number().int().nonnegative(),
            })
            .optional(),
          confirmation_token: z.string().min(32).optional(),
          confirmation_valid_seconds: z.number().int().nonnegative().optional(),
          idempotency_key: z.string().optional(),
          pricing: generationPricingSchema.optional(),
          // 停下来等确认时：这次请求的花费上限；完成时：按实际用量算的花费
          worst_case_cost_usd: z.number().optional(),
          cost_usd: z.number().optional(),
        },
        annotations: toolAnnotations("atlas_chat"),
      },
      async (args) => {
        const { confirmation_token, confirmed, model, temperature, max_tokens, top_p } = args;
        const idempotency_key = args.idempotency_key ?? randomUUID();
        const messages = args.messages as LegacyChatMessage[];
        const { extra_params } = args as { extra_params?: Record<string, unknown> };
        try {
          annotateToolCall({ stage: "prepare" });
          const found = await findModelByExactId(model);
          if (!found || found.type !== "Text") {
            recordToolCallError({ code: found ? "invalid_param" : "model_not_found" });
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

          annotateToolCall({ model: found.model });
          // 托管版固定走 /chat/completions；本地版按模型声明的协议（npm 1.x 的行为）。
          const declared = legacy ? resolveDeclaredProtocol(found.supported_protocols) : MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS;
          const protocol = legacy ? resolveChatProtocol(found.supported_protocols) : MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS;
          annotateLocalToolCall({ execution_mode: "chat", model_type: "llm", llm_protocol: sanitizeEnum(declared), stream: false });
          if (!isProtocolImplemented(declared)) {
            recordToolCallError({ code: "invalid_param", cause: "unsupported_protocol" });
            return {
              isError: true,
              content: [{
                type: "text",
                text:
                  `Model \`${found.model}\` speaks the \`${declared}\` protocol, which atlas_chat cannot call. ` +
                  (declared === MODEL_PROTOCOLS.OPENAI_IMAGES
                    ? "It is an image-generation endpoint, not a chat model: use atlas_generate_image."
                    : "Pick a different model with atlas_list_models.") +
                  " No billable request was submitted.",
              }],
            };
          }
          const turns: ChatTurn[] = messages.map((m) => ({ role: m.role, text: m.content, media: legacy ? mediaOf(m) : [] }));
          const hasMedia = turns.some((turn) => (turn.media?.length ?? 0) > 0);
          const extras = legacy ? chatExtraParams(extra_params) : { dropped: [] as string[] };
          const warnings = legacy ? mediaWarnings(turns, protocol, found) : [];
          if (extras.dropped.length > 0) {
            warnings.push(
              `extra_params ${extras.dropped.join(", ")} ignored: the output length is set with max_tokens, and streaming and multiple choices are not supported.`
            );
          }
          // 纯文字、协议就是 chat completions、没有额外参数时，请求体和托管版一模一样。
          const protocolRequest =
            protocol !== MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS || hasMedia || extras.extra !== undefined;
          let body: Record<string, unknown>;
          if (protocolRequest) {
            body = buildChatRequestBody(protocol, {
              model: found.model,
              turns,
              maxTokens: max_tokens,
              temperature,
              topP: top_p,
              // Gemini's generationConfig has its own field names; OpenAI sampling keys would be rejected.
              extra: protocol === MODEL_PROTOCOLS.GEMINI_GENERATE ? undefined : extras.extra,
            });
          } else {
            body = {
              model: found.model,
              messages: messages.map((m) => ({ role: m.role, content: m.content })),
            };
            if (temperature !== undefined) body.temperature = temperature;
            if (max_tokens !== undefined) body.max_tokens = max_tokens;
            if (top_p !== undefined) body.top_p = top_p;
          }
          const chatPath = protocolRequest ? buildChatPath(protocol, found.model) : "/chat/completions";

          const confirmedRequest = {
            resolved_model: found.model,
            request_body: body,
          };
          let spend: (SpendDecision & { reservation?: AutoSpendReservation }) | undefined;
          if (!confirmation_token && !confirmed) {
            const decision = evaluateChatSpend(found, {
              messages: messages.map((m) => ({ role: m.role, content: m.content })),
              max_tokens,
            });
            // 附件的输入 token 事先算不出来，最坏花费没有上限：一律先确认（宁可多问一次）。
            spend = await applyDailyAutoSubmitBudget(
              hasMedia ? { ...decision, autoSubmit: false, reason: "media attached" } : decision
            );
          }
          if (spend && !spend.autoSubmit) {
            const confirmation = await issueGenerationConfirmation(
              "atlas_chat",
              idempotency_key,
              confirmedRequest,
              found.price
            );
            const bound = hasMedia
              ? "- **Worst-case cost**: not bounded in advance — the attached images, video or audio add input tokens that cannot be counted before the request runs. The real charge follows actual token usage."
              : spend.quotedUsd === null
                ? "- **Worst-case cost**: unknown — the catalog has no complete per-token rates or output limit for this model, so it cannot be bounded in advance."
                : spend.dailyBudget
                  ? `- **Worst-case cost**: ${formatUsd(spend.quotedUsd)} for this request. It is under the per-request limit, but chat requests that ran without confirmation today already add up to ${formatUsd(spend.dailyBudget.usedUsd === Number.POSITIVE_INFINITY ? spend.dailyBudget.budgetUsd : spend.dailyBudget.usedUsd)} of the ${formatUsd(spend.dailyBudget.budgetUsd)} daily allowance, so this one needs the user's confirmation.`
                  : `- **Worst-case cost**: ${formatUsd(spend.quotedUsd)} for this request (input size, max_tokens and the highest rate tier), at or above the ${formatUsd(spend.thresholdUsd)} auto-submit limit. The real charge follows actual token usage and is usually far lower; setting a smaller max_tokens lowers this bound.`;
            return {
              structuredContent: {
                status: "confirmation_required" as const,
                model: found.model,
                confirmation_token: confirmation.confirmationToken,
                confirmation_valid_seconds: confirmationValidSeconds(confirmation.expiresAt),
                idempotency_key: confirmation.idempotencyKey,
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
                  `${confirmationReuseNotice(confirmation.idempotencyKey, confirmation.confirmationToken)}\n` +
                `${confirmationValidityNotice(confirmation.expiresAt)}\n\n` +
                  "Show this to the user and stop. After explicit confirmation in a new message, call again with unchanged arguments, confirmed: true, the idempotency_key above and the confirmation_token.",
              }],
            };
          }
          // 带了令牌或标明已确认：解析这一单该用的幂等键（令牌抄错、幂等键丢了时按报价记录找回）。
          const confirmedKey =
            confirmation_token || confirmed
              ? await resolveConfirmedIdempotencyKey(confirmation_token, "atlas_chat", idempotency_key, confirmedRequest, found.price)
              : { idempotencyKey: idempotency_key };
          const submitKey = confirmedKey.idempotencyKey;

          const raw: unknown = await executeIdempotently<unknown>(
            "atlas_chat",
            { idempotency_key: submitKey, ...confirmedRequest },
            submitKey,
            () =>
              protocolRequest
                ? llmApi<Record<string, unknown>>(chatPath, { method: "POST", body, timeout: 120000 })
                : llmApi<ChatCompletionResponse>("/chat/completions", {
                    method: "POST",
                    body,
                    timeout: 120000,
                    responseSchema: chatCompletionResponseSchema,
                  })
          );
          const response = protocolRequest
            ? protocolChatResponse(protocol, raw as Record<string, unknown>, found.model)
            : (raw as ChatCompletionResponse);
          if (response.usage) {
            annotateLocalToolCall({
              prompt_tokens: telemetryNumber(response.usage.prompt_tokens),
              completion_tokens: telemetryNumber(response.usage.completion_tokens),
              total_tokens: telemetryNumber(response.usage.total_tokens),
            });
          }
          annotateLocalToolCall({ finish_reason: sanitizeEnum(response.choices?.[0]?.finish_reason) });

          if (spend?.reservation) {
            // 放行前已经按最坏情况预占了今天的额度：按实际用量退回差额（空回答也扣了钱）；
            // 算不出实际用量就保留预占。失败、超时走不到这里，预占同样保留。
            const used = response.usage ? chatUsageCostUsd(found, response.usage) : null;
            await settleAutoSpend(spend.reservation, used);
          }

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

          // 11-18 ChatGPT 回归 O04：ChatGPT 为了压低最坏花费自己传了 max_tokens=80，推理模型把它几乎全用在
          // 推理上，回答只剩半句。说清楚是被截断了、该怎么重来；ChatGPT 只读结构化结果，所以放进 next_step。
          const truncated = choice.finish_reason === "length";
          const lines = [`# Chat Response\n`];
          lines.push(`**Model**: \`${response.model || found.model}\``);
          if (protocolRequest) lines.push(`**Protocol**: \`${protocol}\``);
          lines.push(`**Finish Reason**: ${choice.finish_reason}\n`);
          if (warnings.length > 0) {
            warnings.forEach((warning) => lines.push(`> ${warning}`));
            lines.push("");
          }
          lines.push("## Response\n");
          lines.push(choice.message.content);
          if (truncated) lines.push(`\n${CHAT_TRUNCATED_NEXT_STEP}`);

          const costUsd = response.usage ? chatUsageCostUsd(found, response.usage) : null;
          if (response.usage) {
            lines.push(`\n## Token Usage\n`);
            lines.push(`- Prompt: ${response.usage.prompt_tokens}`);
            lines.push(`- Completion: ${response.usage.completion_tokens}`);
            lines.push(`- Total: ${response.usage.total_tokens}`);
          }
          if (costUsd !== null) {
            const amount = `about ${formatUsd(costUsd)}`;
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
              ...(truncated ? { truncated: true, next_step: CHAT_TRUNCATED_NEXT_STEP } : {}),
              ...(response.usage ? { usage: response.usage } : {}),
              ...(costUsd !== null ? { cost_usd: costUsd } : {}),
            },
            content: [
              { type: "text", text: lines.join("\n") },
              ...(confirmedKey.notice ? [{ type: "text" as const, text: confirmedKey.notice }] : []),
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

  // Get prediction result
  server.registerTool(
    "atlas_get_prediction",
    {
      title: "Get Prediction Result",
      description: `Check the status and result of an image/video generation task.

Use this after submitting a generation request to check if the result is ready.

The server waits up to about 20 seconds for an unfinished task before answering, so call it again right away while the status is still "processing" or "starting" — keep polling in the same turn until the task finishes.

When the result is ready (status is "completed" or "succeeded"), the output URLs are returned, and for most clients any image is also attached as an image block. You should then:
1. Present the image to the user. An image block, when attached, may or may not be displayed by the client, so do not assume the user has already seen it.
2. Follow the presentation notes in the result — they depend on the client. For a result the user is waiting for in this conversation (a generation they just asked for, or a file they asked to get), where you have a shell, save the file into the working directory without asking first, wait for the download to finish, and show the saved file with Markdown image syntax and its absolute path (\`![title](/abs/path.mp4)\`), which renders a player for video. When you are only looking a task up (its status, its cost, or an older task from atlas_list_predictions), do not download anything: give the URL as a link.

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
        transfer_pending: z.boolean().optional(),
        temporary_outputs: z.array(z.string()).optional(),
        next_step: z.string().optional(),
        error: z.string().optional(),
        metrics: z.record(z.unknown()).optional(),
        price_usd: z.number().optional(),
        price_to_tell_user: z.string().optional(),
        charge_status: z.string().optional(),
        charge_note: z.string().optional(),
        card_note: z.string().optional(),
      },
      annotations: toolAnnotations("atlas_get_prediction"),
      ...(generationCardEnabled() ? { _meta: generationCardToolMeta() } : {}),
    },
    async ({ prediction_id }) => {
      // 与 CLI 的 get / wait 对应：服务端会不会替调用方等一会儿，看部署配置。
      const waits = predictionWaitSeconds() > 0;
      annotateToolCall({
        execution_mode: waits ? "wait" : "get",
        stage: waits ? "wait" : "fetch",
        task_hash: taskHash(prediction_id),
      });
      try {
        const fetchOnce = (budget: { timeoutMs: number; maxRetries: number }) =>
          generationApi<PredictionResponse>(
            `/model/prediction/${encodeURIComponent(prediction_id)}`,
            {
              // 卡片打开时多要一份原始请求，结果卡才能显示主要参数。
              ...(generationCardEnabled() ? { params: CARD_PREDICTION_PARAMS } : {}),
              responseSchema: predictionResponseSchema,
              timeout: budget.timeoutMs,
              maxRetries: budget.maxRetries,
            }
          );
        const waited = await waitForPrediction(fetchOnce);
        // 工作流单查结果接口不给扣费：到历史账单里补（11-18 WorkBuddy H10、ChatGPT「Actual charge: Not reported」）。
        const result = await withRecordedCharge(prediction_id, waited.result);
        const { waitedSeconds } = waited;
        const status = result.data?.status || "unknown";
        annotateToolCall({
          model: sanitizeModel((result.data as Record<string, unknown> | undefined)?.model),
          generation_status: normalizeGenerationStatus(result.data?.status),
          // 等满预算还在跑就是 timed_out：服务端任务没停，调用方该接着查。
          ...(waits ? { wait_outcome: isActive(status) ? "timed_out" : "completed" } : {}),
        });

        const lines = [`# Prediction Result\n`];
        lines.push(`- **ID**: \`${prediction_id}\``);
        lines.push(`- **Status**: ${status}\n`);

        if (result.data?.error) {
          lines.push(`## Error\n\n${result.data.error}`);
        }

        const data = result.data as Record<string, unknown> | undefined;
        const priceUsd = priceOf(data?.price);
        const chargeStatus = chargeStatusOf(data?.charge_status);
        // 实扣金额进埋点（同一任务查几次就报几次，看板按 task_hash 去重）。
        annotateToolCall(chargeTelemetry(chargeStatus, priceUsd));
        const charge = chargeLine(chargeStatus, priceUsd);
        if (charge) lines.push(`${charge}\n`);
        // 11-18 ChatGPT 回归：模板单按 ID 查，回答写「实扣：没有报告」，列表里其实记着 $0.1408。
        const chargeMissing = isFinished(status) && !charge;
        if (chargeMissing) lines.push(`- **Charge**: ${CHARGE_NOT_IN_RECORD}\n`);

        const outputUrls = predictionOutputUrls(result);
        const transferPending =
          isFinished(status) && hasUntransferredMedia(outputUrls, completedAtOf(result));
        const kinds = new Set<OutputKind>(outputUrls.map(classifyOutput));
        const profile = currentClientProfile();
        // 先建块：提示语要根据「用户是否已经看到图」给出相反的指引。
        const previewBlocks = transferPending ? [] : await buildImagePreviews(outputUrls);

        if (transferPending) {
          lines.push("## Output (temporary provider link)\n");
          outputUrls.forEach((url, i) => lines.push(`${i + 1}. ${url}`));
          lines.push(
            `\nThe file is finished but is still being copied to Atlas storage. Call ` +
              `\`atlas_get_prediction\` again with this same ID in about 15 seconds and use the ` +
              `permanent Atlas link it returns instead: that link downloads in seconds and stays available ` +
              `for about 15 days, while the provider link above is slow from many networks and ` +
              `expires within 24 hours. Use the provider link only if the Atlas link has still not ` +
              `appeared after about 5 minutes. Keep going in this turn; do not stop here.`
          );
        } else if (outputUrls.length > 0) {
          lines.push("## Output\n");
          outputUrls.forEach((url, i) => {
            lines.push(`${i + 1}. ${url}`);
          });
          const sizes = profile === "chat" ? new Map<string, number>() : await probeSizes(outputUrls);
          const guidance = playbackGuidance(kinds, { profile, sizes, urls: outputUrls });
          if (guidance) {
            lines.push(`\n${guidance}`);
          }
        }

        const resultOnCard = isFinished(status) && !transferPending && outputUrls.length > 0 && clientRendersCards(server);
        // 宿主会渲染卡片时，卡片自己刷新到出结果；模型再查一次只会在对话里多一张卡。
        const cardTracksTask = isActive(status) && clientRendersCards(server);
        if (cardTracksTask) {
          lines.push(
            `\nThe task is still running. The user sees a live Atlas card for it that refreshes ` +
              `itself and shows the result as soon as it is ready, so do not call ` +
              `\`atlas_get_prediction\` again for this task in this turn. Tell the user in one short ` +
              `sentence that the card will update when it finishes. If they later ask about the ` +
              `result, call \`atlas_get_prediction\` with this same ID. Do not submit the job ` +
              `again — that would start and bill a second one.`
          );
        } else if (isActive(status)) {
          const runningFor = secondsSince(createdAtOf(result));
          lines.push(
            `\nThe task is still running` +
              (runningFor !== null ? ` (submitted ${Math.round(runningFor / 6) / 10} min ago)` : "") +
              (waitedSeconds > 0 ? `; the server already waited ${waitedSeconds} s on this call` : "") +
              `. Video jobs commonly take 1–6 minutes and longer is normal under load — that is not ` +
              `a failure. Call \`atlas_get_prediction\` again with this same ID right away and keep ` +
              `polling in this turn until it reaches completed or failed. Do not end your turn ` +
              `with a "still running, I will keep checking" message: once your turn ends nothing ` +
              `checks again and the user is left waiting. If you nonetheless have to stop, say ` +
              `plainly that the job is still running on Atlas and that replying "continue" (继续) ` +
              `will pick it up with the same ID — never imply it is finished or stuck. Do not submit ` +
              `the job again — that would start and bill a second one.`
          );
        } else if (resultOnCard) {
          // 11-16 ChatGPT 回归 S12：卡片已经显示了结果，ChatGPT 还自己画了一张「Illustrative preview, not the
          // actual generated image」的示意图放在下面，看着像生成结果。
          lines.push(`\n${RESULT_CARD_NOTE}`);
        }

        if (!isActive(status) && !isFinished(status) && status !== "failed" && status !== "unknown") {
          lines.push(
            `\nStatus "${status}" is not a running state. Treat it as final: stop polling, tell the ` +
              `user what it says, and do not resubmit unless they ask. For what it cost, go by the charge line above ` +
              `(charge_status) or charged_usd in atlas_list_predictions: a failed job is usually not billed, but can be partly billed.`
          );
        }

        if (result.data?.metrics) {
          lines.push(`\n## Metrics\n`);
          lines.push("```json");
          lines.push(JSON.stringify(result.data.metrics, null, 2));
          lines.push("```");
        }

        const cardMeta = generationCardEnabled()
          ? { [CARD_META_KEY]: await predictionCardData(prediction_id, result) }
          : undefined;

        return {
          ...(cardMeta ? { _meta: cardMeta } : {}),
          structuredContent: {
            // 排在最前面，只读结构化结果的 ChatGPT 先看到。
            ...(resultOnCard ? { card_note: RESULT_CARD_NOTE } : {}),
            prediction_id,
            status,
            // 转存还没完成时，上游的临时链接不放进 outputs，另放 temporary_outputs，并在 next_step 里写明
            // 过一会儿再查：只读结构化结果的客户端（Claude Code）看不到文字里那段，会直接拿上游链接
            // 去下载（11-04 第 13 轮问题 47）。
            outputs: transferPending ? [] : outputUrls,
            ...(transferPending
              ? { transfer_pending: true, temporary_outputs: outputUrls, next_step: TRANSFER_NEXT_STEP }
              : {}),
            ...(result.data?.error ? { error: result.data.error } : {}),
            ...(result.data?.metrics ? { metrics: result.data.metrics } : {}),
            ...(priceUsd !== undefined && chargeStatus !== "pending"
              ? // 原始金额有 8 位小数，模型会照抄（「$0.59746528 USD」）；另给一个和卡片一样写法的金额让它照着说。
                { price_usd: priceUsd, price_to_tell_user: chargeUsd(priceUsd) }
              : {}),
            ...(chargeStatus ? { charge_status: chargeStatus } : {}),
            ...(chargeMissing ? { charge_note: CHARGE_NOT_IN_RECORD } : {}),
          },
          content: [
            { type: "text", text: lines.join("\n") },
            // Appended after the text so a client that renders only the first
            // block still shows the URLs and the status.
            ...previewBlocks,
          ],
        };
      } catch (error) {
        if (waits) annotateToolCall({ wait_outcome: "error" });
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );
}
