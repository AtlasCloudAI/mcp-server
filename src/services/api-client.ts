import { CONSOLE_API_BASE, CHAT_API_BASE, LLM_API_BASE, REQUEST_TIMEOUT_MS } from "../constants.js";

function getApiKey(): string {
  const key = process.env.ATLASCLOUD_API_KEY;
  if (!key) {
    throw new Error("ATLASCLOUD_API_KEY environment variable is not set. Please configure it in your MCP settings.");
  }
  return key;
}

// Generic HTTP request method
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
  } = {}
): Promise<T> {
  const {
    method = "GET",
    body,
    params,
    headers = {},
    timeout = REQUEST_TIMEOUT_MS,
    requireAuth = true,
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: finalHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      let errorMsg = `API request failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = JSON.parse(errorText);
        errorMsg = errorData.msg || errorData.message || errorData.error || errorMsg;
      } catch {
        // Use default error message
      }
      throw new Error(errorMsg);
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return (await response.json()) as T;
    }
    return (await response.text()) as unknown as T;
  } finally {
    clearTimeout(timer);
  }
}

// Console API (model list, etc.)
export function consoleApi<T>(
  endpoint: string,
  options?: Parameters<typeof request>[2]
): Promise<T> {
  return request<T>(CONSOLE_API_BASE, endpoint, { ...options, requireAuth: false });
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

// Fetch external resources (schema, readme, etc.)
export async function fetchExternal(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch resource: ${response.status} ${url}`);
    }
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return await response.json();
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
