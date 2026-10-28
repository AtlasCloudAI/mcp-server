import { BILLING_URL } from "../constants.js";
import { ApiRequestError } from "../services/api-client.js";
import { GenerationConfirmationError } from "../services/generation-confirmation.js";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyUncertainError,
} from "../services/idempotency.js";
import {
  errorCodeForHttpStatus,
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
  if (error instanceof IdempotencyInProgressError) return { code: "idempotency_in_progress" };
  // 上一次提交没拿到确定答复，可能已经到了平台：和 CLI 的 submission_unknown 同义。
  if (error instanceof IdempotencyUncertainError) return { code: "submission_unknown" };
  if (error instanceof ApiRequestError) {
    const status = error.statusCode;
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
      return { code: "network_error", cause: "deadline_exceeded" };
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
