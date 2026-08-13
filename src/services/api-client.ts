import { lstat, readFile, realpath } from "fs/promises";
import { basename, isAbsolute, relative, resolve } from "path";
import { fetch, FormData, ProxyAgent, type Dispatcher } from "undici";
import type { ZodTypeAny } from "zod";
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
import { getRequestContext } from "./request-context.js";

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

function sanitizeUpstreamMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak|api)[-_]?[A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function upstreamErrorMessage(body: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return sanitizeUpstreamMessage(
        record.msg ?? record.message ?? record.error,
        fallback
      );
    }
  } catch {
    // The upstream body is not JSON. Do not echo it to the MCP client.
  }
  return fallback;
}

function safeResponseShape(value: unknown): string {
  const typeOf = (candidate: unknown): string =>
    candidate === null ? "null" : Array.isArray(candidate) ? "array" : typeof candidate;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return typeOf(value);
  }
  const record = value as Record<string, unknown>;
  const safeKeys = Object.keys(record)
    .filter((key) => /^[A-Za-z0-9_.-]{1,64}$/.test(key))
    .sort()
    .slice(0, 32);
  const shape: Record<string, unknown> = Object.fromEntries(
    safeKeys.map((key) => [key, typeOf(record[key])])
  );
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    const data = record.data as Record<string, unknown>;
    shape.data_keys = Object.keys(data)
      .filter((key) => /^[A-Za-z0-9_.-]{1,64}$/.test(key))
      .sort()
      .slice(0, 32)
      .map((key) => `${key}:${typeOf(data[key])}`);
  }
  return JSON.stringify(shape).slice(0, 1000);
}

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

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  timeout?: number;
  requireAuth?: boolean;
  maxRetries?: number;
  responseSchema?: ZodTypeAny;
  fetcher?: typeof fetch;
}

function getApiKey(): string {
  const key =
    getRequestContext()?.atlasApiKey ?? process.env.ATLASCLOUD_API_KEY;
  if (!key) {
    throw new ApiRequestError(
      "No Atlas Cloud credential is available for this authenticated request"
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
export async function request<T>(
  baseUrl: string,
  endpoint: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const {
    method = "GET",
    body,
    params,
    headers = {},
    timeout = REQUEST_TIMEOUT_MS,
    requireAuth = true,
    maxRetries = MAX_RETRIES,
    responseSchema,
    fetcher = fetch,
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
      const response = await fetcher(url, {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const errorMsg = upstreamErrorMessage(
          errorText,
          `API request failed: ${response.status} ${response.statusText}`
        );

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
        const value: unknown = await response.json();
        if (responseSchema) {
          const parsed = responseSchema.safeParse(value);
          if (!parsed.success) {
            const issuePaths = parsed.error.issues
              .slice(0, 16)
              .map((issue) => issue.path.join("."))
              .join(",");
            console.error(
              `[atlascloud] response schema mismatch status=${response.status} ` +
                `shape=${safeResponseShape(value)} issue_paths=${issuePaths}`
            );
            throw new ApiRequestError(
              "Atlas Cloud returned a malformed API response",
              502
            );
          }
          return parsed.data as T;
        }
        return value as T;
      }
      const value = await response.text();
      if (responseSchema) {
        throw new ApiRequestError(
          "Atlas Cloud returned a non-JSON response where JSON was required",
          502
        );
      }
      return value as unknown as T;
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
  options?: ApiRequestOptions
): Promise<T> {
  return request<T>(API_BASE, endpoint, options);
}

// LLM API (api.atlascloud.ai/v1)
export function llmApi<T>(
  endpoint: string,
  options?: ApiRequestOptions
): Promise<T> {
  return request<T>(LLM_API_BASE, endpoint, options);
}

// Public billing/usage API (api.atlascloud.ai/public/v1): balance, usage, costs
export function publicApi<T>(
  endpoint: string,
  options?: ApiRequestOptions
): Promise<T> {
  return request<T>(PUBLIC_API_BASE, endpoint, options);
}

// Upload a local file to Atlas Cloud, returns a download URL
export async function uploadMedia(filePath: string): Promise<UploadResponse> {
  if (!isAbsolute(filePath)) {
    throw new ApiRequestError("Upload path must be absolute");
  }
  const fileInfo = await lstat(filePath);
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new ApiRequestError("Upload path must be a regular file, not a link or directory");
  }
  const maxUploadBytes = Number(process.env.ATLASCLOUD_MAX_UPLOAD_BYTES ?? 209715200);
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new ApiRequestError("ATLASCLOUD_MAX_UPLOAD_BYTES is invalid");
  }
  if (fileInfo.size > maxUploadBytes) {
    throw new ApiRequestError(`Upload exceeds the ${maxUploadBytes}-byte limit`);
  }
  const resolvedFile = await realpath(filePath);
  const configuredRoots = (process.env.ATLASCLOUD_UPLOAD_ROOTS ?? process.cwd())
    .split(",")
    .map((root) => root.trim())
    .filter((root) => root !== "")
    .map((root) => resolve(root));
  if (configuredRoots.length === 0) {
    throw new ApiRequestError("ATLASCLOUD_UPLOAD_ROOTS has no usable paths");
  }
  const allowed = configuredRoots.some((root) => {
    const rel = relative(root, resolvedFile);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!allowed) {
    throw new ApiRequestError("Upload path is outside ATLASCLOUD_UPLOAD_ROOTS");
  }
  const apiKey = getApiKey();
  const fileBuffer = await readFile(resolvedFile);
  const fileName = basename(resolvedFile);

  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer]), fileName);

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
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const errorMsg = upstreamErrorMessage(
        errorText,
        `Upload failed: ${response.status} ${response.statusText}`
      );
      throw new ApiRequestError(errorMsg, response.status);
    }

    const value: unknown = await response.json();
    const { uploadResponseSchema } = await import("../response-schemas.js");
    const parsed = uploadResponseSchema.safeParse(value);
    if (!parsed.success) {
      throw new ApiRequestError("Atlas Cloud returned a malformed upload response", 502);
    }
    return parsed.data as UploadResponse;
  } finally {
    clearTimeout(timer);
  }
}

// Fetch external resources (schema, readme, etc.) with retry
export async function fetchExternal(
  url: string,
  options: { fetcher?: typeof fetch; dispatcher?: Dispatcher } = {}
): Promise<unknown> {
  const parsedUrl = new URL(url);
  const configuredHosts = (process.env.ATLASCLOUD_EXTERNAL_RESOURCE_HOSTS ??
    "static.atlascloud.ai")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    (parsedUrl.port !== "" && parsedUrl.port !== "443") ||
    !configuredHosts.includes(parsedUrl.hostname.toLowerCase())
  ) {
    throw new ApiRequestError(
      `External resource host is not allowed: ${parsedUrl.hostname}`
    );
  }

  let lastError: unknown;
  const fetcher = options.fetcher ?? fetch;
  const dispatcher = options.dispatcher ?? proxyDispatcher;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await backoff(attempt - 1);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetcher(url, {
        signal: controller.signal,
        redirect: "error",
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (!response.ok) {
        const error = new ApiRequestError(
          `Failed to fetch external resource from ${parsedUrl.hostname}: ${response.status}`,
          response.status
        );
        if (!isRetryable(error)) throw error;
        lastError = error;
        continue;
      }
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > 2 * 1024 * 1024) {
        throw new ApiRequestError("External resource exceeds the 2 MiB limit", 413);
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 2 * 1024 * 1024) {
        throw new ApiRequestError("External resource exceeds the 2 MiB limit", 413);
      }
      const text = new TextDecoder().decode(bytes);
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return JSON.parse(text) as unknown;
      }
      return text;
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
