import { BILLING_URL } from "../constants.js";
import { ApiRequestError } from "../services/api-client.js";

function safeMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak|api)[-_]?[A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

// Unified error handling with user-friendly messages
export function handleError(error: unknown): string {
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
