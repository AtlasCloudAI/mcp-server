import { randomUUID } from "crypto";
import { lstat, readFile, realpath } from "fs/promises";
import { basename, isAbsolute, relative, resolve } from "path";
import { fetch, FormData, ProxyAgent, type Dispatcher } from "undici";
import type { ZodTypeAny } from "zod";
import {
  API_BASE,
  GENERATION_API_BASE,
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

        // 上游说这份凭据不认：交换来的令牌可能已被撤销。丢掉缓存，让下一个请求
        // 重新换一枚，而不是拿着废令牌一路 401 到它自然过期（最长十几分钟）。
        // 只认 401——403 是权限不足，凭据本身是好的，丢了只会白白多换一次。
        if (response.status === 401) {
          getRequestContext()?.onCredentialRejected?.();
        }

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

// 生成任务（提交 / 轮询 / 报价）：/api/v1 前缀，但走生成侧 origin。
export function generationApi<T>(
  endpoint: string,
  options?: ApiRequestOptions
): Promise<T> {
  return request<T>(GENERATION_API_BASE, endpoint, options);
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
  return uploadMediaBuffer(fileBuffer, fileName, apiKey);
}

export interface UploadBufferOptions {
  fetcher?: typeof fetch;
}

// 把一段已经在内存里的字节传给 Atlas。上面的路径版是 stdio 用的；远程的上传
// 中转端点直接走这里——它手上是客户端 POST 上来的字节和票据里解出的令牌，
// 没有本地路径可读。
export async function uploadMediaBuffer(
  fileBuffer: Uint8Array,
  fileName: string,
  apiKey: string,
  options: UploadBufferOptions = {}
): Promise<UploadResponse> {
  const { fetcher = fetch } = options;
  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer]), fileName);

  const url = `${API_BASE}/model/uploadMedia`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    const response = await fetcher(url, {
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

// ---- 上传存进资产库（资产库二期）----

/** 字节超过上限时中断转发。 */
export class UploadTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`The file exceeds the ${maxBytes}-byte limit for this type`);
    this.name = "UploadTooLargeError";
  }
}

export interface AssetLibraryUpload {
  assetId: string;
  mimeType?: string;
  mediaType?: string;
  sizeBytes?: number;
}

// 用户上行慢（2026-10-19 实测 250~300KB/s），整个上传可能要好几分钟，所以按「多久没收到字节」
// 断开，不按总时长；字节送完后再等 AssetD 存好、回结果。
const LIBRARY_UPLOAD_IDLE_TIMEOUT_MS = 90_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** AssetD 的错误：msg 里有原因，error.code 是 asset_library_not_activated、upload_quota_exceeded 这类代码。 */
function assetdError(body: string, status: number, fallback: string): ApiRequestError {
  let code = "";
  try {
    code = String(record(record(JSON.parse(body))?.error)?.code ?? "");
  } catch {
    // 不是 JSON：只用状态码
  }
  const message = upstreamErrorMessage(body, fallback);
  return new ApiRequestError(code && !message.includes(code) ? `${code}: ${message}` : message, status);
}

/**
 * 把字节边收边转给 AssetD 的 POST /api/assets/uploads（经 kubedl 的 /assetd 转发，kubedl 放行到
 * 101 MiB），不整个读进内存：100MB 的视频在 512Mi 的 pod 里经不起缓冲。超过 maxBytes 就中断。
 * AssetD 按内容认格式（JPG/PNG/WEBP/GIF、MP4/MOV/WEBM、MP3/WAV/M4A、GLB），按类型再查一次大小。
 */
export async function uploadStreamToAssetLibrary(
  body: AsyncIterable<Uint8Array>,
  input: { filename: string; contentType: string; maxBytes: number; apiKey: string },
  options: UploadBufferOptions = {}
): Promise<AssetLibraryUpload> {
  const { fetcher = fetch } = options;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };
  let tooLarge = false;
  // 包成 multipart 边收边发：AssetD 收原始字节时从 X-Hermes-Filename 头取文件名，但不做解码，
  // 中文名会存成乱码；multipart 里的文件名 Go 按 UTF-8 读。
  const boundary = `----atlas-mcp-${randomUUID()}`;
  const quoted = input.filename.replace(/["\\\r\n]/g, "_");
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quoted}"; filename*=UTF-8''${encodeURIComponent(input.filename)}\r\n` +
      `Content-Type: ${input.contentType}\r\n\r\n`
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  async function* multipart(): AsyncGenerator<Uint8Array> {
    let total = 0;
    arm(LIBRARY_UPLOAD_IDLE_TIMEOUT_MS);
    yield head;
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > input.maxBytes) {
        tooLarge = true;
        throw new UploadTooLargeError(input.maxBytes);
      }
      arm(LIBRARY_UPLOAD_IDLE_TIMEOUT_MS);
      yield chunk;
    }
    yield tail;
    arm(UPLOAD_TIMEOUT_MS);
  }
  try {
    const response = await fetcher(`${API_BASE}/assetd/api/assets/uploads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        Accept: "application/json",
      },
      body: multipart(),
      duplex: "half",
      signal: controller.signal,
      ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) throw assetdError(text, response.status, `Upload failed: ${response.status} ${response.statusText}`);
    const data = record(record(JSON.parse(text))?.data);
    if (!data || typeof data.asset_id !== "string" || data.asset_id === "") {
      throw new ApiRequestError("Atlas Cloud returned a malformed Asset Library upload response", 502);
    }
    return {
      assetId: data.asset_id,
      ...(typeof data.mime_type === "string" ? { mimeType: data.mime_type } : {}),
      ...(typeof data.media_type === "string" ? { mediaType: data.media_type } : {}),
      ...(typeof data.size_bytes === "number" ? { sizeBytes: data.size_bytes } : {}),
    };
  } catch (error) {
    if (tooLarge) throw new UploadTooLargeError(input.maxBytes);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 资产的临时原图地址（约 15 分钟），给生成当输入用；过期了模型用资产编号再换。 */
export async function assetSourceUrl(
  assetId: string,
  apiKey: string,
  options: UploadBufferOptions = {}
): Promise<{ url: string; expiresAt?: string; mimeType?: string }> {
  const result = await request<unknown>(API_BASE, "/assetd/api/assets/source-urls", {
    method: "POST",
    body: { asset_ids: [assetId] },
    requireAuth: false,
    headers: { Authorization: `Bearer ${apiKey}` },
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  const items = record(record(result)?.data)?.items;
  const item = Array.isArray(items) ? record(items.find((entry) => record(entry)?.asset_id === assetId)) : undefined;
  if (!item || typeof item.source_url !== "string") {
    throw new ApiRequestError("Atlas Cloud returned no file URL for the uploaded asset", 502);
  }
  return {
    url: item.source_url,
    ...(typeof item.expires_at === "string" ? { expiresAt: item.expires_at } : {}),
    ...(typeof item.mime_type === "string" ? { mimeType: item.mime_type } : {}),
  };
}

// The shared gate for every outbound fetch to a host we do not own. Kept in one
// place because both callers below are, in effect, "take a URL that arrived in a
// response body and go fetch it" — the exact shape an SSRF wants. Plain https on
// 443, no embedded credentials, no redirects (enforced at the call), and the host
// has to be on a list someone configured.
//
// `allowedHostsEnv` differs per caller: schema/readme fetches only ever go to our
// docs host, while media previews go to whichever bucket host the platform put in
// the prediction result, so they get their own list.
function assertFetchableExternalUrl(
  url: string,
  allowedHostsEnv: string,
  fallbackHosts: string
): URL {
  const parsedUrl = new URL(url);
  const configuredHosts = (process.env[allowedHostsEnv] ?? fallbackHosts)
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const hostname = parsedUrl.hostname.toLowerCase();
  // A leading dot means "this domain and anything under it". Media buckets are
  // named per environment (atlas-media-dev, atlas-img-dev, …) so pinning exact
  // hostnames would need a config change for every new bucket.
  const hostAllowed = configuredHosts.some((allowed) =>
    allowed.startsWith(".") ? hostname.endsWith(allowed) : hostname === allowed
  );
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    (parsedUrl.port !== "" && parsedUrl.port !== "443") ||
    !hostAllowed
  ) {
    throw new ApiRequestError(
      `External resource host is not allowed: ${parsedUrl.hostname}`
    );
  }
  return parsedUrl;
}

// Fetch external resources (schema, readme, etc.) with retry
export async function fetchExternal(
  url: string,
  options: { fetcher?: typeof fetch; dispatcher?: Dispatcher } = {}
): Promise<unknown> {
  const parsedUrl = assertFetchableExternalUrl(
    url,
    "ATLASCLOUD_EXTERNAL_RESOURCE_HOSTS",
    "static.atlascloud.ai"
  );

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

// Fetch a media object as bytes. Separate from fetchExternal because that one
// decodes to text: running an image through TextDecoder corrupts it.
//
// No retry loop here. A preview is decoration — if the first attempt does not
// land, the caller drops the picture and still returns the URL, and retrying
// would only make a slow tool call slower.
export async function fetchExternalBinary(
  url: string,
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    fetcher?: typeof fetch;
    dispatcher?: Dispatcher;
  } = {}
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  assertFetchableExternalUrl(
    url,
    "MCP_MEDIA_PREVIEW_HOSTS",
    // volces.com 是火山引擎 TOS：字节系模型（seedream、seedance）的产出直接落在
    // 那里，不经过我们自己的 OSS。漏掉它的后果是这些模型永远只给下载链接，
    // 而且因为预览是 fail-open 的，看起来和「没做预览功能」一模一样。
    ".aliyuncs.com,.atlascloud.ai,.volces.com"
  );

  const maxBytes = options.maxBytes ?? 1_500_000;
  const fetcher = options.fetcher ?? fetch;
  const dispatcher = options.dispatcher ?? proxyDispatcher;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      redirect: "error",
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) {
      throw new ApiRequestError(
        `Failed to fetch media from ${new URL(url).hostname}: ${response.status}`,
        response.status
      );
    }
    // Checked twice on purpose: the header is a claim, byteLength is the fact.
    // Without the header check we would pull the whole object before rejecting it.
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > maxBytes) {
      throw new ApiRequestError(`Media exceeds the ${maxBytes} byte preview limit`, 413);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new ApiRequestError(`Media exceeds the ${maxBytes} byte preview limit`, 413);
    }
    return { bytes, contentType: response.headers.get("content-type") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Byte size of an object on Atlas storage, read with a HEAD request, or null.
 *
 * Used so an agent can check that the copy it saved is complete before showing it
 * (a shell that returns early leaves a half-written file that looks "corrupt").
 * Only Atlas storage is probed — the caller passes URLs that isAtlasStorageUrl
 * already accepted — and every failure is silent: the size is a check, not a
 * requirement.
 */
export async function headContentLength(
  url: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {}
): Promise<number | null> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await fetcher(url, {
      method: "HEAD",
      signal: controller.signal,
      ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    });
    if (!response.ok) return null;
    const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a media URL still answers a HEAD request: true for 2xx, false for an
 * explicit 403/404/410 (an expired or deleted object), null when it could not be
 * told (network error, timeout, any other status). Callers treat null as "fine".
 */
export async function headStillServes(
  url: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {}
): Promise<boolean | null> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await fetcher(url, {
      method: "HEAD",
      signal: controller.signal,
      ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    });
    if (response.ok) return true;
    return [403, 404, 410].includes(response.status) ? false : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
