import { readFile } from "fs/promises";
import { basename, extname } from "path";
import { ProxyAgent, type Dispatcher } from "undici";
import {
  API_BASE,
  LLM_API_BASE,
  PUBLIC_API_BASE,
  REQUEST_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
} from "../constants.js";
import type { UploadResponse } from "../types.js";

// Auto-detect proxy env vars for Node.js fetch
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

// Custom error class that preserves HTTP status code and the parsed body.
// The body matters because the backend reports *task* failures as HTTP 5xx
// while still describing the terminal state in the payload.
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public responseBody?: unknown
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

// Task states that will never change again. Seeing one of these means the
// request is answered, however the HTTP layer chose to label it.
const TERMINAL_TASK_STATUSES = new Set([
  "failed",
  "canceled",
  "cancelled",
  "error",
  "timeout",
]);

/**
 * A prediction that failed comes back as HTTP 5xx with the real verdict in the
 * body: { code: 500, message: "...", data: { status: "failed", error: "..." } }.
 * Treating that as a transient server fault means retrying a decision the
 * backend already made — several seconds of backoff before showing an error it
 * returned on the first call. Detect it and stop.
 */
export function readTerminalTaskStatus(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const outer = body as Record<string, unknown>;
  const task = (
    outer.data && typeof outer.data === "object" ? outer.data : outer
  ) as Record<string, unknown>;
  const status = typeof task.status === "string" ? task.status : "";
  return TERMINAL_TASK_STATUSES.has(status.toLowerCase()) ? status : null;
}

// Check if an error is retryable
function isRetryable(error: unknown): boolean {
  if (error instanceof ApiRequestError) {
    const code = error.statusCode;
    // A body that reports a terminal task state is a decision, not a fault
    if (readTerminalTaskStatus(error.responseBody)) return false;
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
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(errorText);
          const errorData = parsedBody as Record<string, any>;
          errorMsg =
            errorData.msg || errorData.message || errorData.error || errorMsg;
        } catch {
          // Use default error message
        }

        const apiError = new ApiRequestError(
          errorMsg,
          response.status,
          parsedBody
        );

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
      if (isRetryable(error) && attempt < effectiveMaxRetries) {
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

// Unified API (api.atlascloud.ai/api/v1)
export function api<T>(
  endpoint: string,
  options?: Parameters<typeof request>[2]
): Promise<T> {
  return request<T>(API_BASE, endpoint, options);
}

// LLM API (api.atlascloud.ai/v1)
export function llmApi<T>(
  endpoint: string,
  options?: Parameters<typeof request>[2]
): Promise<T> {
  return request<T>(LLM_API_BASE, endpoint, options);
}

// Public billing/usage API (api.atlascloud.ai/public/v1): balance, usage, costs
export function publicApi<T>(
  endpoint: string,
  options?: Parameters<typeof request>[2]
): Promise<T> {
  return request<T>(PUBLIC_API_BASE, endpoint, options);
}

/**
 * Content types by extension for uploads.
 *
 * The upload endpoint classifies a file by its name, and downstream models
 * check the URL extension, so the extension must be preserved. Sending an
 * explicit type as well keeps the multipart part from defaulting to
 * application/octet-stream. Note this trusts the extension: a file whose name
 * lies about its contents (a `.png` that is really AVIF) is not detected here
 * and will be rejected further upstream.
 */
const UPLOAD_MIME_TYPES: Record<string, string> = {
  // images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  // video
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  // audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".opus": "audio/opus",
  // documents
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function guessUploadMimeType(fileName: string): string {
  return UPLOAD_MIME_TYPES[extname(fileName).toLowerCase()] || "application/octet-stream";
}

// Upload a local file to Atlas Cloud, returns a download URL
export async function uploadMedia(filePath: string): Promise<UploadResponse> {
  const apiKey = getApiKey();
  const fileBuffer = await readFile(filePath);
  const fileName = basename(filePath);

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileBuffer], { type: guessUploadMimeType(fileName) }),
    fileName
  );

  const url = `${API_BASE}/model/uploadMedia`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: controller.signal,
      ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    } as any);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      let errorMsg = `Upload failed: ${response.status} ${response.statusText}`;
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(errorText);
        const errorData = parsedBody as Record<string, any>;
        errorMsg = errorData.msg || errorData.message || errorMsg;
      } catch {
        // Use default error message
      }
      throw new ApiRequestError(errorMsg, response.status, parsedBody);
    }

    return (await response.json()) as UploadResponse;
  } finally {
    clearTimeout(timer);
  }
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
