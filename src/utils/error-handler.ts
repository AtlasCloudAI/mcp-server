import { BILLING_URL } from "../constants.js";
import { ApiRequestError } from "../services/api-client.js";

// Unified error handling with user-friendly messages
export function handleError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const code = error.statusCode;

    // Insufficient balance / payment required
    if (code === 402 || error.message.toLowerCase().includes("insufficient") || error.message.toLowerCase().includes("balance")) {
      return `Error: Insufficient balance. Please top up your account at: ${BILLING_URL}`;
    }

    if (code === 401) {
      return "Error: Invalid or expired API key. Please check your ATLASCLOUD_API_KEY environment variable.";
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

    return `Error: ${error.message}`;
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Error: Request timed out after retries. Please check your network connection and try again.";
    }
    if (error.message.includes("ATLASCLOUD_API_KEY")) {
      return error.message;
    }

    // Check for balance-related messages in generic errors too
    if (error.message.toLowerCase().includes("insufficient") || error.message.toLowerCase().includes("balance") || error.message.includes("402")) {
      return `Error: Insufficient balance. Please top up your account at: ${BILLING_URL}`;
    }

    return `Error: ${error.message}`;
  }

  return `Error: An unexpected error occurred - ${String(error)}`;
}
