// Unified error handling with user-friendly messages
export function handleError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Error: Request timed out. Please check your network connection and try again.";
    }
    if (error.message.includes("ATLASCLOUD_API_KEY")) {
      return error.message;
    }
    if (error.message.includes("401") || error.message.includes("Unauthorized")) {
      return "Error: Invalid or expired API key. Please check your ATLASCLOUD_API_KEY environment variable.";
    }
    if (error.message.includes("403")) {
      return "Error: Permission denied. You do not have access to this resource.";
    }
    if (error.message.includes("429")) {
      return "Error: Rate limit exceeded. Please wait and try again later.";
    }
    if (error.message.includes("404")) {
      return "Error: Resource not found. Please check your parameters.";
    }
    return `Error: ${error.message}`;
  }
  return `Error: An unexpected error occurred - ${String(error)}`;
}
