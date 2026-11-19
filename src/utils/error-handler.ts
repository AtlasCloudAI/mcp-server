import { BILLING_URL } from "../constants.js";
import { ApiRequestError } from "../services/api-client.js";
import { UnconfirmedRequestError } from "../services/idempotency.js";
import { GenerationConfirmationError } from "../services/generation-confirmation.js";
import {
  IdempotencyCanceledError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyUncertainError,
} from "../services/idempotency.js";
import {
  errorCodeForHttpStatus,
  errorCodeForMessage,
  recordToolCallError,
  type ToolCallError,
} from "../services/tool-call-telemetry.js";

function safeMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak|api)[-_]?[A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function mentionsBalance(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("insufficient") || lower.includes("balance");
}

/**
 * 工具出错时的埋点错误码，码沿用 CLI（见 services/tool-call-telemetry.ts）。
 * 判据与下面 handleError 给用户的文案保持一致，两边不会说成两件事。
 */
export function classifyToolError(error: unknown): ToolCallError {
  if (error instanceof GenerationConfirmationError) return { code: "confirmation_required" };
  if (error instanceof IdempotencyConflictError) return { code: "idempotency_conflict" };
  if (error instanceof IdempotencyCanceledError) return { code: "confirmation_required" };
  if (error instanceof IdempotencyInProgressError) return { code: "idempotency_in_progress" };
  // 上一次提交没拿到确定答复，可能已经到了平台：和 CLI 的 submission_unknown 同义。
  if (error instanceof IdempotencyUncertainError) return { code: "submission_unknown" };
  if (error instanceof ApiRequestError) {
    const status = error.statusCode;
    // 上游厂商那一侧的失败按文案先分（CLI 同序，先于下面按余额和状态码的兜底）。
    const byMessage = errorCodeForMessage(error.message);
    if (byMessage) return { code: byMessage, ...(status ? { httpStatus: status } : {}) };
    if (status === 402 || mentionsBalance(error.message)) {
      return { code: "quota_exceeded", ...(status ? { httpStatus: status } : {}) };
    }
    if (status === undefined) {
      // 没状态码的只有本地拦下的：拿不到凭据，或者外部资源不合规。
      return { code: error.message.includes("credential") ? "auth_required" : "invalid_param" };
    }
    return { code: errorCodeForHttpStatus(status), httpStatus: status };
  }
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      // CLI 11-05 起所有超时的原因都写 timeout。
      return { code: "network_error", cause: "timeout" };
    }
    if (error instanceof TypeError && error.message.includes("fetch failed")) {
      return { code: "network_error" };
    }
  }
  return { code: "upstream_failure" };
}

// Unified error handling with user-friendly messages
export function handleError(error: unknown): string {
  recordToolCallError(classifyToolError(error));
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

    // 后端白名单还没放行这条接口时，401 的原文是 "does not accept scoped access tokens"。
    // 这不是凭据过期：让用户重新授权解决不了，只会让人反复登录（10-22 ChatGPT 实测）。
    if (code === 401 && /does not accept scoped access tokens/i.test(error.message)) {
      return "Error: This Atlas Cloud feature does not accept plugin sign-in yet. Your sign-in is fine and other tools keep working; signing in again will not change this. The same information is available on the Atlas Cloud website.";
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
