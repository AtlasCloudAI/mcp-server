import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  decryptAtlasCredential,
  encryptAtlasCredential,
  type CredentialEncryptionKey,
} from "./credential-envelope.js";
import { getRequestContext } from "./request-context.js";

/**
 * 上传票据。
 *
 * 远程 MCP 的生成工具只收 URL，没有上传工具——`atlas_upload_media` 收的是服务端
 * 文件路径，放到远程就成了「读集群里的文件再发布成公网地址」，所以它是 stdio 专属。
 * 用户手里却只有本地文件。模型这一侧有 Bash，能 curl；缺的只是那一次调用的凭据：
 * OAuth 令牌握在客户端库手里，模型看不见，也转不出去。
 *
 * 于是让票据替令牌走一趟。票据在已鉴权的工具调用里铸造——那一刻 request context
 * 里有换来的 Atlas 令牌——中转端点收到票据后解出令牌，代用户把字节转投 Atlas。
 *
 * 令牌为什么随票据走，而不是存在服务端：
 * - 进程内 Map 只在单副本下成立，扩容后票据打到别的 pod 就静默失效；
 * - Redis 会让换来的令牌落盘，而「令牌只在进程内存」是这套架构的承诺；
 * - 嵌进票据则无状态：AES-GCM 加密，密钥从 generation-confirmation 的 secret 用 HKDF
 *   派生，不新增 Secret，也不依赖 MCP_CREDENTIAL_ENCRYPTION_KEYS_JSON（生产没配它）。
 *
 * 票据格式沿用 confirmation_token：`base64url(payload).hmac`，常量时间比较。
 * 明文里只有 subject 的哈希，信封的 AAD 也绑在这个哈希上——票据换了主人就解不开。
 */

const HKDF_SALT = "atlascloud-upload-ticket";
const HKDF_INFO = "envelope-v1";
const KEY_ID = "upload-ticket-v1";

/** 文件名随字节一起送到中转端点的请求头。大小写不敏感。 */
export const UPLOAD_FILENAME_HEADER = "X-Atlas-Filename";

const payloadSchema = z
  .object({
    version: z.literal(1),
    subject_hash: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    expires_at: z.number().int().positive(),
    envelope: z.string().min(1).max(8192),
  })
  .strict();

type UploadTicketPayload = z.infer<typeof payloadSchema>;

export type UploadTicketErrorCode =
  | "invalid_upload_ticket"
  | "upload_ticket_expired";

export class UploadTicketError extends Error {
  constructor(
    public readonly code: UploadTicketErrorCode,
    public readonly status: 401 | 410,
    message: string
  ) {
    super(message);
    this.name = "UploadTicketError";
  }
}

export interface IssueUploadTicketInput {
  subject: string;
  atlasApiKey: string;
  secret: string;
  ttlSeconds: number;
  now?: () => number;
}

export interface IssuedUploadTicket {
  ticket: string;
  /** 毫秒时间戳。 */
  expiresAt: number;
}

export interface VerifiedUploadTicket {
  subjectHash: string;
  atlasApiKey: string;
  expiresAt: number;
}

function subjectHash(subject: string): string {
  return createHash("sha256").update(subject).digest("hex");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

// 同一把 secret 派生出信封密钥。派生而不是直接用：HMAC 签名和 AES 加密不该共用
// 一段原始密钥材料；用途不同的 salt/info 把两者隔开。
function keyringFor(secret: string): CredentialEncryptionKey[] {
  const key = Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, 32));
  return [{ kid: KEY_ID, key }];
}

function invalid(): UploadTicketError {
  return new UploadTicketError(
    "invalid_upload_ticket",
    401,
    "The upload ticket is invalid. Call atlas_get_upload_url for a new one."
  );
}

export function issueUploadTicket(input: IssueUploadTicketInput): IssuedUploadTicket {
  const now = input.now ?? Date.now;
  if (input.secret.length < 16) {
    throw new Error("Upload ticket secret is too short");
  }
  const hashed = subjectHash(input.subject);
  const expiresAt = now() + input.ttlSeconds * 1000;
  const payload: UploadTicketPayload = {
    version: 1,
    subject_hash: hashed,
    nonce: randomBytes(16).toString("base64url"),
    expires_at: expiresAt,
    envelope: encryptAtlasCredential(hashed, input.atlasApiKey, keyringFor(input.secret)),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { ticket: `${encoded}.${sign(encoded, input.secret)}`, expiresAt };
}

export function verifyUploadTicket(
  ticket: string,
  secret: string,
  now: () => number = Date.now
): VerifiedUploadTicket {
  if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > 16384) {
    throw invalid();
  }
  const [encoded, signature, extra] = ticket.split(".");
  if (!encoded || !signature || extra !== undefined) throw invalid();
  const expected = Buffer.from(sign(encoded, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw invalid();
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const parsed = payloadSchema.safeParse(parsedJson);
  if (!parsed.success) throw invalid();
  const payload = parsed.data;
  if (payload.expires_at <= now()) {
    throw new UploadTicketError(
      "upload_ticket_expired",
      410,
      "The upload ticket has expired. Call atlas_get_upload_url for a new one."
    );
  }
  let atlasApiKey: string;
  try {
    atlasApiKey = decryptAtlasCredential(
      payload.subject_hash,
      payload.envelope,
      keyringFor(secret)
    );
  } catch {
    throw invalid();
  }
  return {
    subjectHash: payload.subject_hash,
    atlasApiKey,
    expiresAt: payload.expires_at,
  };
}

export interface IssuedUploadUrl {
  uploadUrl: string;
  /** 毫秒时间戳。 */
  expiresAt: number;
  maxBytes: number;
}

/**
 * 在工具调用里铸票。只有远程 HTTP 服务会把 uploadBaseUrl 放进 request context；
 * stdio 没有中转端点，也不需要——它有直接收路径的 atlas_upload_media。
 */
export function issueUploadTicketFromContext(): IssuedUploadUrl | undefined {
  const context = getRequestContext();
  if (
    !context?.uploadBaseUrl ||
    !context.uploadTicketTtlSeconds ||
    !context.uploadMaxBytes
  ) {
    return undefined;
  }
  const { ticket, expiresAt } = issueUploadTicket({
    subject: context.subject,
    atlasApiKey: context.atlasApiKey,
    secret: context.generationConfirmationSecret,
    ttlSeconds: context.uploadTicketTtlSeconds,
  });
  return {
    uploadUrl: `${context.uploadBaseUrl}${ticket}`,
    expiresAt,
    maxBytes: context.uploadMaxBytes,
  };
}
