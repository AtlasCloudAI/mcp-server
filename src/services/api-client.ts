import { ProxyAgent, type Dispatcher } from "undici";
import {
  CONSOLE_API_BASE,
  CHAT_API_BASE,
  LLM_API_BASE,
  REQUEST_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
} from "../constants.js";

// 自动读取代理环境变量，让 Node.js fetch 支持代理
function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;
  if (proxyUrl) {
    return new ProxyAgent(proxyUrl);
  }
  return undefined;
}

const proxyDispatcher = getProxyDispatcher();

// Custom error class that preserves HTTP status code
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function getApiKey(): string {
  const key = process.env.ATLASCLOUD_API_KEY;
  if (!key) {
    throw new ApiRequestError(
      "ATLASCLOUD_API_KEY is not set. Please add it to your MCP configuration:\n\n" +
      '{\n  "mcpServers": {\n    "atlascloud": {\n      "command": "npx",\n      "args": ["-y", "atlascloud-mcp"],\n      "env": {\n        "ATLASCLOUD_API_KEY": "your-api-key-here"\n      }\n    }\n  }\n}\n\n' +
      "Get your API key at: https://www.atlascloud.ai"
    );
  }
  return key;
}

// Check if an error is retryable
function isRetryable(error: unknown): boolean {
  if (error instanceof ApiRequestError) {
    const code = error.statusCode;
    // Retry on network errors (no status), 429 (rate limit), 5xx (server errors)
    if (!code) return true;
    if (code === 429) return true;
    if (code >= 500) return true;
    return false;
  }
  // Retry on timeout / network errors
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    if (error.message.includes("fetch")) return true;
  }
  return false;
}

// Sleep with exponential backoff
function backoff(attempt: number): Promise<void> {
  const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

// Generic HTTP request method with retry
async function request<T>(
  baseUrl: string,
  endpoint: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    params?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
    timeout?: number;
    requireAuth?: boolean;
    maxRetries?: number;
  } = {}
): Promise<T> {
  const {
    method = "GET",
    body,
    params,
    headers = {},
    timeout = REQUEST_TIMEOUT_MS,
    requireAuth = true,
    maxRetries = MAX_RETRIES,
  } = options;

  let url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  const finalHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...headers,
  };

  if (requireAuth) {
    finalHeaders["Authorization"] = `Bearer ${getApiKey()}`;
  }

  // POST requests should not retry - they may create billable tasks (image/video generation)
  const effectiveMaxRetries = method === "POST" ? 0 : maxRetries;

  let lastError: unknown;

  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    if (attempt > 0) {
      await backoff(attempt - 1);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: finalHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      } as any);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        let errorMsg = `API request failed: ${response.status} ${response.statusText}`;
        try {
          const errorData = JSON.parse(errorText);
          errorMsg =
            errorData.msg || errorData.message || errorData.error || errorMsg;
        } catch {
          // Use default error message
        }

        const apiError = new ApiRequestError(errorMsg, response.status);

        // Don't retry non-retryable errors
        if (!isRetryable(apiError)) {
          throw apiError;
        }

        lastError = apiError;
        continue;
      }

      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return (await response.json()) as T;
      }
      return (await response.text()) as unknown as T;
    } catch (error) {
      clearTimeout(timer);

      // Non-retryable errors throw immediately
      if (error instanceof ApiRequestError && !isRetryable(error)) {
        throw error;
      }

      lastError = error;

      // If it's retryable and we have retries left, continue
      if (isRetryable(error) && attempt < maxRetries) {
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

// Console API (model list, etc.)
export function consoleApi<T>(
  endpoint: string,
  options?: Parameters<typeof request>[2]
): Promise<T> {
  return request<T>(CONSOLE_API_BASE, endpoint, {
    ...options,
    requireAuth: false,
  });
}

// Chat API (image/video generation)
export function chatApi<T>(
  endpoint: string,
  options?: Parameters<typeof request>[2]
): Promise<T> {
  return request<T>(CHAT_API_BASE, endpoint, options);
}

// LLM API (chat completions)
export function llmApi<T>(
  endpoint: string,
  options?: Parameters<typeof request>[2]
): Promise<T> {
  return request<T>(LLM_API_BASE, endpoint, options);
}

// Fetch external resources (schema, readme, etc.) with retry
export async function fetchExternal(url: string): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await backoff(attempt - 1);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      } as any);
      if (!response.ok) {
        const error = new ApiRequestError(
          `Failed to fetch resource: ${response.status} ${url}`,
          response.status
        );
        if (!isRetryable(error)) throw error;
        lastError = error;
        continue;
      }
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return await response.json();
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt >= MAX_RETRIES) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}
