import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ApiRequestError,
  UploadTooLargeError,
  assetSourceUrl,
  getApiKey,
  uploadMediaBuffer,
  uploadStreamToAssetLibrary,
} from "../services/api-client.js";
import { rememberAssetNames, rememberMediaName } from "../services/media-names.js";
import { readImageShapes } from "../services/input-link-check.js";
import { imagePixelLimit, libraryUploadLimit, libraryUploadMime, sanitizeUploadFilename } from "../http/upload-relay.js";
import { CARD_TOOL_POLICIES } from "../tool-policy.js";
import { assetLibraryAvailable } from "./assets.js";

/**
 * 本地（stdio）版的上传卡：没有托管服务的上传中转（/upload/），卡片把文件切成小块，经宿主一块块交给
 * 这个只给卡片调的工具，传完由本地服务用用户的 API key 存进资产库（资产库用不了时退回普通上传）。
 * 回给卡片的 { status, body } 和托管版中转的 HTTP 状态码、JSON 一样，卡片按同一套规则显示。
 */
export const CARD_UPLOAD_PART_TOOL = "atlas_card_upload_part";
/** 卡片看到这个前缀就不走 XHR，改调上面的工具。plain=1：只走普通上传，不存资产库（空间满了）。 */
export const LOCAL_CARD_UPLOAD_URL = `tool:${CARD_UPLOAD_PART_TOOL}`;
export const LOCAL_CARD_PLAIN_UPLOAD_URL = `${LOCAL_CARD_UPLOAD_URL}?plain=1`;

/** 和托管版资产库上传的默认上限一致（config.ts 的 MCP_LIBRARY_* 默认值）。 */
export const LOCAL_LIBRARY_LIMITS = { maxBytes: 52_428_800, maxVideoBytes: 104_857_600, maxImagePixels: 24_000_000 };
/** 卡片每块最多发这么多 base64 字符（约 1.5 MB 原始字节），宿主转发一条工具调用不至于太大。 */
export const CARD_UPLOAD_PART_MAX_CHARS = 2_000_000;
const PENDING_TTL_MS = 15 * 60_000;
/** 同时攒在内存里的未传完的字节上限，免得一张卡塞爆本地进程。 */
const PENDING_MAX_BYTES = 256 * 1_048_576;

interface Pending {
  filename: string;
  size: number;
  total: number;
  next: number;
  received: number;
  chunks: Buffer[];
  plain: boolean;
  touchedAt: number;
}

const pending = new Map<string, Pending>();

function prune(now: number): void {
  for (const [id, entry] of pending) if (now - entry.touchedAt > PENDING_TTL_MS) pending.delete(id);
}

function pendingBytes(): number {
  let sum = 0;
  for (const entry of pending.values()) sum += entry.received;
  return sum;
}

export interface CardUploadReply {
  status: number;
  body: Record<string, unknown>;
}

function kindOfMime(mime: string): "image" | "video" | "audio" | undefined {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return undefined;
}

function tooLarge(limit: number): CardUploadReply {
  return {
    status: 413,
    body: { error: "upload_too_large", max_bytes: limit, message: `The file is over the ${Math.floor(limit / 1_048_576)} MB limit.` },
  };
}

/** 收齐的文件：存进资产库（能用时），否则普通上传。和 src/http/upload-relay.ts 的两条路一致。 */
export async function storeCardUpload(
  buffer: Buffer,
  filename: string,
  options: { plain?: boolean; libraryAvailable?: () => Promise<boolean> } = {}
): Promise<CardUploadReply> {
  const apiKey = getApiKey();
  const library = !options.plain && (await (options.libraryAvailable ?? assetLibraryAvailable)());
  if (!library) {
    if (buffer.length > LOCAL_LIBRARY_LIMITS.maxVideoBytes) return tooLarge(LOCAL_LIBRARY_LIMITS.maxVideoBytes);
    try {
      const result = await uploadMediaBuffer(buffer, filename, apiKey);
      await rememberMediaName(result.data.download_url, filename, undefined, { source: "upload" });
      return {
        status: 200,
        body: { url: result.data.download_url, filename: result.data.filename, size_bytes: result.data.size, media_type: result.data.type },
      };
    } catch (error) {
      return failure(error, LOCAL_LIBRARY_LIMITS.maxVideoBytes);
    }
  }
  const mime = libraryUploadMime(filename, undefined);
  const limit = libraryUploadLimit(mime, LOCAL_LIBRARY_LIMITS);
  if (buffer.length > limit) return tooLarge(limit);
  try {
    const uploaded = await uploadStreamToAssetLibrary(
      (async function* () {
        yield new Uint8Array(buffer);
      })(),
      { filename, contentType: mime, maxBytes: limit, apiKey }
    );
    const source = await assetSourceUrl(uploaded.assetId, apiKey);
    const kind = kindOfMime(uploaded.mimeType ?? source.mimeType ?? mime);
    await rememberMediaName(source.url, filename, undefined, { source: "upload", assetId: uploaded.assetId, ...(kind ? { kind } : {}) });
    await rememberAssetNames([{ asset_id: uploaded.assetId, name: filename }]);
    const shape = kind === "image" ? (await readImageShapes([source.url]).catch(() => undefined))?.get(source.url) : undefined;
    return {
      status: 200,
      body: {
        url: source.url,
        filename,
        ...(uploaded.sizeBytes !== undefined ? { size_bytes: uploaded.sizeBytes } : {}),
        media_type: kind ?? uploaded.mediaType ?? "other",
        asset_id: uploaded.assetId,
        ...(shape ? { width: shape.width, height: shape.height, orientation: shape.orientation, ratio: shape.ratio } : {}),
        ...(source.expiresAt ? { expires_at: source.expiresAt } : {}),
      },
    };
  } catch (error) {
    if (error instanceof ApiRequestError && error.statusCode === 413 && /upload_quota_exceeded/i.test(error.message)) {
      // 资产库上传空间满了：卡片改传普通上传（不存资产库），和托管版一样。
      return {
        status: 413,
        body: {
          error: "upload_quota_exceeded",
          fallback_upload_url: LOCAL_CARD_PLAIN_UPLOAD_URL,
          fallback_expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
          fallback_max_bytes: LOCAL_LIBRARY_LIMITS.maxVideoBytes,
          message: "The user's Asset Library upload space is full, so this file wasn't saved there.",
        },
      };
    }
    return failure(error, limit);
  }
}

function failure(error: unknown, limit: number): CardUploadReply {
  if (error instanceof UploadTooLargeError) return tooLarge(error.maxBytes);
  if (error instanceof ApiRequestError) {
    const code = error.statusCode;
    if (code === 401 || code === 403) {
      // 不回 401：卡片会当成地址过期反复换。本地的 API key 被拒，换地址也没用。
      return { status: 502, body: { error: "credential_rejected", message: "Atlas Cloud rejected the API key." } };
    }
    if (code === 413) return tooLarge(limit);
    const pixels = imagePixelLimit(error.message);
    if (pixels) {
      return {
        status: 422,
        body: { error: "image_too_large", width: pixels.width, height: pixels.height, max_pixels: pixels.maxPixels },
      };
    }
    if (code === 400 || code === 415 || code === 422 || /not supported|unsupported/i.test(error.message)) {
      return { status: 415, body: { error: "unsupported_media_type" } };
    }
    if (code === 429) return { status: 429, body: { error: "rate_limited" } };
    return { status: 502, body: { error: "upstream_upload_failed", message: error.message } };
  }
  return { status: 502, body: { error: "upstream_upload_failed", message: error instanceof Error ? error.message : String(error) } };
}

export interface CardUploadPart {
  upload_id: string;
  filename: string;
  index: number;
  total: number;
  size: number;
  data: string;
  plain?: boolean;
}

/** 收一块；最后一块收齐后上传。分出来便于测试。 */
export async function receiveCardUploadPart(
  part: CardUploadPart,
  store: (buffer: Buffer, filename: string, plain: boolean) => Promise<CardUploadReply> = (buffer, filename, plain) =>
    storeCardUpload(buffer, filename, { plain })
): Promise<CardUploadReply> {
  const now = Date.now();
  prune(now);
  const filename = sanitizeUploadFilename(part.filename) ?? "upload";
  const limit = LOCAL_LIBRARY_LIMITS.maxVideoBytes;
  if (part.size > limit) return tooLarge(limit);
  if (part.index === 0) {
    pending.set(part.upload_id, {
      filename,
      size: part.size,
      total: part.total,
      next: 0,
      received: 0,
      chunks: [],
      plain: part.plain === true,
      touchedAt: now,
    });
  }
  const entry = pending.get(part.upload_id);
  if (!entry || entry.next !== part.index || entry.total !== part.total || entry.size !== part.size) {
    pending.delete(part.upload_id);
    return { status: 400, body: { error: "upload_out_of_order", message: "Upload parts arrived out of order. Try again." } };
  }
  const chunk = Buffer.from(part.data, "base64");
  if (entry.received + chunk.length > entry.size) {
    pending.delete(part.upload_id);
    return tooLarge(entry.size);
  }
  if (pendingBytes() + chunk.length > PENDING_MAX_BYTES) {
    pending.delete(part.upload_id);
    return { status: 429, body: { error: "too_many_uploads" } };
  }
  entry.chunks.push(chunk);
  entry.received += chunk.length;
  entry.next += 1;
  entry.touchedAt = now;
  if (entry.next < entry.total) return { status: 202, body: { received: entry.received } };
  pending.delete(part.upload_id);
  if (entry.received !== entry.size) {
    return { status: 400, body: { error: "upload_incomplete", message: "The file arrived incomplete. Try again." } };
  }
  return store(Buffer.concat(entry.chunks), entry.filename, entry.plain);
}

export function registerCardUploadPartTool(server: McpServer): void {
  server.registerTool(
    CARD_UPLOAD_PART_TOOL,
    {
      title: "Upload Card File Part",
      description:
        "Used by the Atlas Cloud upload card in a local setup to send a file the user picked, in parts. Not for direct use: use atlas_upload_media with a file path instead.",
      inputSchema: {
        upload_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
        filename: z.string().min(1).max(255),
        index: z.number().int().min(0).max(399),
        total: z.number().int().min(1).max(400),
        size: z.number().int().positive(),
        data: z.string().max(CARD_UPLOAD_PART_MAX_CHARS),
        plain: z.boolean().optional(),
      },
      annotations: { ...CARD_TOOL_POLICIES.atlas_card_upload_part.annotations },
      _meta: {
        ui: { visibility: ["app"] },
        "openai/widgetAccessible": true,
        "openai/visibility": "private",
      },
    },
    async (part) => {
      const reply = await receiveCardUploadPart(part);
      return {
        structuredContent: reply as unknown as Record<string, unknown>,
        content: [{ type: "text", text: `Upload part ${part.index + 1}/${part.total}: ${reply.status}` }],
      };
    }
  );
}
