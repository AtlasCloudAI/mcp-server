/**
 * 把聊天里用户附上的文件转存进 Atlas，换成生成工具能用的公网地址。
 *
 * 为什么要这一步：ChatGPT 的代码沙箱没有外网，模型自己 curl 我们的上传地址必然失败
 * （2026-10-22、10-23、10-26 三次实测都卡在这里）。Apps SDK 的 file params 换了个
 * 方向：工具声明哪些参数是文件，ChatGPT 调工具时把附件变成一个临时下载链接传进来，
 * 由我们的服务端去取。整个过程不经过模型的沙箱，也不需要卡片。
 *
 * 下载链接是宿主给的，但参数终究是模型填的，所以只认配置里的宿主域名，防止被
 * 拿来让服务端去请求任意地址。
 */
import { basename, extname } from "node:path";
import { fetch as undiciFetch } from "undici";
import {
  ApiRequestError,
  externalProxyDispatcher,
  uploadMediaBuffer,
  type UploadBufferOptions,
} from "./api-client.js";

/** 下载附件用的 fetch：默认走 undici + 出站代理，测试里换成假的。 */
export type DownloadFetcher = (
  url: URL,
  init: { method: "GET"; redirect: "manual"; signal: AbortSignal }
) => Promise<Response>;

const defaultDownloadFetcher: DownloadFetcher = (url, init) => {
  const dispatcher = externalProxyDispatcher();
  return undiciFetch(url, {
    ...init,
    ...(dispatcher ? { dispatcher } : {}),
  }) as unknown as Promise<Response>;
};

/** ChatGPT 文件参数里的一个文件，字段名照 Apps SDK 文档（snake_case）。 */
export interface ChatFile {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export type ChatFileMediaType = "image" | "video" | "audio";

export interface ImportedChatFile {
  file_id: string;
  file_name: string;
  url: string;
  media_type: ChatFileMediaType;
  size_bytes: number;
}

export interface FailedChatFile {
  file_id: string;
  file_name?: string;
  reason: string;
}

export interface ChatFileImportResult {
  imported: ImportedChatFile[];
  failed: FailedChatFile[];
}

export interface ChatFileImportOptions {
  apiKey: string;
  maxBytes: number;
  /** 允许的下载域名后缀，例如 "oaiusercontent.com"。 */
  allowedHosts: string[];
  /** 测试注入：下载附件用的 fetch。 */
  downloadFetcher?: DownloadFetcher;
  /** 测试注入：转投 Atlas 用的 fetch。 */
  uploadFetcher?: UploadBufferOptions["fetcher"];
  downloadTimeoutMs?: number;
}

/**
 * ChatGPT 附件下载链接的域名。文档没写死域名，这里取 OpenAI 自家的几个，
 * 可用 MCP_CHAT_FILE_HOSTS（逗号分隔的域名后缀）覆盖。
 */
export const DEFAULT_CHAT_FILE_HOSTS = ["oaiusercontent.com", "openai.com", "chatgpt.com"];

export function chatFileHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MCP_CHAT_FILE_HOSTS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHAT_FILE_HOSTS;
  return raw
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/^\.+/, ""))
    .filter((host) => host !== "");
}

const MAX_REDIRECTS = 3;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/webm": "webm",
};

const MEDIA_TYPE_BY_EXTENSION: Record<string, ChatFileMediaType> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  gif: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  flac: "audio",
};

/**
 * iPhone 的 HEIC/HEIF 照片：Atlas 能存，但只当普通 media 存（不进 images 目录），大多数
 * 生成模型也不收（2026-10-27 实测上传）。在免费的导入这一步就拦下，免得报价、扣费之后才失败。
 */
const HEIC_EXTENSIONS = new Set(["heic", "heif"]);
const HEIC_MIMES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
const HEIC_REASON =
  "HEIC/HEIF photos cannot be used by the generation models. Ask the user to attach the photo as JPEG or PNG instead.";

/** 宿主没给出具体类型时常见的占位值，不能据此判定不是媒体。 */
const GENERIC_MIMES = new Set(["application/octet-stream", "binary/octet-stream"]);

class ChatFileError extends Error {}

/** 与 api-client 的外部地址检查同一套规矩：只许 https 443、不许带账号密码、域名在名单里。 */
/**
 * ChatGPT 附件实际放在 OpenAI 自己的 Azure 存储账号上，download_url 直接就是
 * https://oaisdmntpr<区域>.blob.core.windows.net/...（2026-10-27 在 ChatGPT 里实测，第 0 跳就是它）。
 * ChatGPT 给卡片沙箱的 CSP 里列着同一批账号名。只认这个前缀的账号，不放开整个 blob.core.windows.net。
 */
const CHAT_FILE_AZURE_ACCOUNT = /^oaisdmntpr[a-z0-9]+\.blob\.core\.windows\.net$/;

export function isAllowedChatFileHost(url: URL, allowedHosts: string[]): boolean {
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  if (CHAT_FILE_AZURE_ACCOUNT.test(host)) return true;
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function normalizeMime(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const mime = value.split(";")[0]!.trim().toLowerCase();
  return mime === "" ? undefined : mime;
}

function extensionOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const ext = extname(name).slice(1).toLowerCase();
  return ext === "" ? undefined : ext;
}

/** 文件名只求安全、非空、带扩展名——Atlas 按扩展名判媒体类型。 */
function safeBaseName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = basename(name.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return undefined;
  return cleaned.length > 200 ? cleaned.slice(cleaned.length - 200) : cleaned;
}

/** 决定这个文件叫什么、是哪类媒体；不是图片、视频、音频就拒绝。 */
export function resolveChatFileName(
  file: Pick<ChatFile, "file_id" | "file_name" | "mime_type">,
  responseContentType?: string,
  bytes?: Uint8Array
): { fileName: string; mediaType: ChatFileMediaType } {
  const declaredName = safeBaseName(file.file_name);
  const declaredExt = extensionOf(declaredName);
  const declaredMime = normalizeMime(file.mime_type);
  const mime =
    (declaredMime && !GENERIC_MIMES.has(declaredMime) ? declaredMime : undefined) ??
    normalizeMime(responseContentType) ??
    declaredMime;
  const sniffed = bytes ? sniffExtension(bytes) : undefined;
  if (
    (declaredExt && HEIC_EXTENSIONS.has(declaredExt)) ||
    (mime && HEIC_MIMES.has(mime)) ||
    (sniffed && HEIC_EXTENSIONS.has(sniffed))
  ) {
    throw new ChatFileError(HEIC_REASON);
  }
  const ext =
    declaredExt && MEDIA_TYPE_BY_EXTENSION[declaredExt]
      ? declaredExt
      : (mime ? EXTENSION_BY_MIME[mime] : undefined) ?? sniffed;
  // 同一个扩展名可能是两类（webm 既有视频也有纯音频），类型以 MIME 为准
  const mimeMediaType =
    mime && EXTENSION_BY_MIME[mime] ? (mime.split("/")[0] as ChatFileMediaType) : undefined;
  const mediaType = ext ? (mimeMediaType ?? MEDIA_TYPE_BY_EXTENSION[ext]) : undefined;
  if (!ext || !mediaType) {
    throw new ChatFileError(
      `Only images, videos and audio can be used as generation inputs${mime ? ` (this file is ${mime})` : ""}.`
    );
  }
  if (declaredName && declaredExt === ext) return { fileName: declaredName, mediaType };
  const stem = declaredName
    ? declaredExt
      ? declaredName.slice(0, -(declaredExt.length + 1))
      : declaredName
    : safeBaseName(file.file_id);
  return { fileName: `${stem || "attachment"}.${ext}`, mediaType };
}

/** 声明的类型明确不是媒体（比如 PDF）就不必下载。 */
function rejectDeclaredNonMedia(file: Pick<ChatFile, "file_name" | "mime_type">): void {
  const ext = extensionOf(safeBaseName(file.file_name));
  const mime = normalizeMime(file.mime_type);
  if ((ext && HEIC_EXTENSIONS.has(ext)) || (mime && HEIC_MIMES.has(mime))) {
    throw new ChatFileError(HEIC_REASON);
  }
  if (ext && MEDIA_TYPE_BY_EXTENSION[ext]) return;
  if (mime && !GENERIC_MIMES.has(mime) && !/^(image|video|audio)\//.test(mime)) {
    throw new ChatFileError(
      `Only images, videos and audio can be used as generation inputs (this file is ${mime}).`
    );
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ChatFileError(`The file is larger than the ${formatBytes(maxBytes)} limit.`);
  }
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ChatFileError(`The file is larger than the ${formatBytes(maxBytes)} limit.`);
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ChatFileError(`The file is larger than the ${formatBytes(maxBytes)} limit.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** 下载附件。跳转自己跟，每一跳都重新检查域名，免得被转去别处。 */
async function downloadChatFile(
  downloadUrl: string,
  options: Required<Pick<ChatFileImportOptions, "maxBytes" | "allowedHosts">> & {
    fetcher: DownloadFetcher;
    timeoutMs: number;
  }
): Promise<{ bytes: Uint8Array; contentType?: string }> {
  if (/^(?:sandbox:|file:|\/)/i.test(downloadUrl.trim()) || downloadUrl.includes("/mnt/data/")) {
    throw new ChatFileError(
      "This is a path inside the chat's own sandbox, which Atlas Cloud cannot reach. Only files the user attached to the chat can be imported; ask the user to attach the file."
    );
  }
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    throw new ChatFileError("The download link is not a valid URL.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isAllowedChatFileHost(url, options.allowedHosts)) {
        // 只记域名：完整链接带临时签名。宿主换了附件存储时，靠这行就能知道该放行哪个域名。
        console.warn(`[chat-file-import] rejected host ${url.host} at hop ${hop}`);
        throw new ChatFileError(
          `This link (${url.host}) is not a chat attachment. Only files the user attached in this chat can be imported here; pass other public URLs to the generation tool directly.`
        );
      }
      const response = await options.fetcher(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new ChatFileError("The download link redirected without a target.");
        url = new URL(location, url);
        continue;
      }
      if (response.status === 403 || response.status === 404 || response.status === 410) {
        throw new ChatFileError(
          "The attachment link has expired or is no longer available. Ask the user to attach the file again."
        );
      }
      if (!response.ok) {
        throw new ChatFileError(`Downloading the attachment failed (HTTP ${response.status}).`);
      }
      const bytes = await readCapped(response, options.maxBytes);
      if (bytes.byteLength === 0) throw new ChatFileError("The attachment is empty.");
      return { bytes, contentType: response.headers.get("content-type") ?? undefined };
    }
    throw new ChatFileError("The download link redirected too many times.");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ChatFileError("Downloading the attachment timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** 名字和类型都没说清时，按文件头认几种常见格式。认不出返回 undefined。 */
export function sniffExtension(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "png";
  if (ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF") {
    const kind = ascii(bytes, 8, 4);
    if (kind === "WEBP") return "webp";
    if (kind === "WAVE") return "wav";
    return undefined;
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
    if (brand === "qt  ") return "mov";
    if (brand === "M4A ") return "m4a";
    return "mp4";
  }
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "flac";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "mp3";
  return undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** 逐个导入，一个失败不影响其他文件；失败原因写给用户看得懂的话。 */
export async function importChatFiles(
  files: ChatFile[],
  options: ChatFileImportOptions
): Promise<ChatFileImportResult> {
  const fetcher = options.downloadFetcher ?? defaultDownloadFetcher;
  const timeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const imported: ImportedChatFile[] = [];
  const failed: FailedChatFile[] = [];

  for (const file of files) {
    try {
      rejectDeclaredNonMedia(file);
      const { bytes, contentType } = await downloadChatFile(file.download_url, {
        fetcher,
        timeoutMs,
        maxBytes: options.maxBytes,
        allowedHosts: options.allowedHosts,
      });
      const { fileName, mediaType } = resolveChatFileName(file, contentType, bytes);
      const result = await uploadMediaBuffer(bytes, fileName, options.apiKey, {
        ...(options.uploadFetcher ? { fetcher: options.uploadFetcher } : {}),
      });
      imported.push({
        file_id: file.file_id,
        file_name: fileName,
        url: result.data.download_url,
        media_type: mediaType,
        size_bytes: result.data.size || bytes.byteLength,
      });
    } catch (error) {
      failed.push({
        file_id: file.file_id,
        ...(file.file_name ? { file_name: file.file_name } : {}),
        reason: failureReason(error),
      });
    }
  }
  return { imported, failed };
}

function failureReason(error: unknown): string {
  if (error instanceof ChatFileError) return error.message;
  if (error instanceof ApiRequestError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return "Atlas Cloud rejected the sign-in while storing the file. Reconnect Atlas Cloud and try again.";
    }
    if (error.statusCode === 413) return "Atlas Cloud rejected the file as too large.";
    return `Storing the file in Atlas Cloud failed: ${error.message}`;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "Storing the file in Atlas Cloud timed out.";
  }
  return "The file could not be imported.";
}
