import { BILLING_URL } from "../constants.js";
import { ApiRequestError } from "../services/api-client.js";
import { UnconfirmedRequestError } from "../services/idempotency.js";

function safeMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak|api)[-_]?[A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

// Unified error handling with user-friendly messages
export function handleError(error: unknown): string {
  // 写请求没拿到确定的回答：可能已经开跑（并扣费）。不能照下面那几句说「请重试」。
  // 卡片认 "without a confirmed response" 这几个词，改措辞要同步 ui/generation-card/quote.ts。
  if (error instanceof UnconfirmedRequestError) {
    return (
      `Error: ${unconfirmedReason(error.reason)}. The request ended without a confirmed response, ` +
      "so it may already have gone through. Check recent predictions or billing before sending it again."
    );
  }

  if (error instanceof ApiRequestError) {
    const code = error.statusCode;

    // Insufficient balance / payment required
    if (code === 402 || error.message.toLowerCase().includes("insufficient") || error.message.toLowerCase().includes("balance")) {
      return `Error: Insufficient balance. Please top up your account at: ${BILLING_URL}`;
    }

    if (code === 401) {
      return "Error: The Atlas Cloud credential for this authenticated account is invalid or expired. Reauthenticate or contact the plugin administrator.";
    }
    if (code === 403) {
      return "Error: Permission denied. You do not have access to this resource.";
    }
    if (code === 429) {
      return "Error: Rate limit exceeded. Please wait and try again later.";
    }
    if (code === 404) {
      return "Error: Resource not found. Please check your parameters.";
    }

    return `Error: ${safeMessage(error.message)}`;
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Error: Request timed out after retries. Please check your network connection and try again.";
    }
    if (error.message.includes("ATLASCLOUD_API_KEY")) {
      return safeMessage(error.message);
    }

    // Check for balance-related messages in generic errors too
    if (error.message.toLowerCase().includes("insufficient") || error.message.toLowerCase().includes("balance") || error.message.includes("402")) {
      return `Error: Insufficient balance. Please top up your account at: ${BILLING_URL}`;
    }

    return `Error: ${safeMessage(error.message)}`;
  }

  return "Error: An unexpected error occurred.";
}

/** 「没拿到确定回答」的那一句原因：只说发生了什么，不带原来那句「请重试」。 */
function unconfirmedReason(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Atlas Cloud didn't answer in time";
  if (error instanceof ApiRequestError && error.statusCode) {
    return `Atlas Cloud answered with an error (${error.statusCode})`;
  }
  // 截短：卡片只读报错的前 240 个字，后面那句 "without a confirmed response" 得在里面。
  if (error instanceof Error && error.message) return safeMessage(error.message).slice(0, 120).replace(/[.\s]+$/, "");
  return "The connection to Atlas Cloud failed";
}
