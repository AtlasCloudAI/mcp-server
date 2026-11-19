import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { ToolCallTelemetry } from "./tool-call-telemetry.js";
import type { UploadTicketStore } from "./upload-ticket-store.js";

export interface AtlasRequestContext {
  authInfo: AuthInfo;
  subject: string;
  atlasApiKey: string;
  /** 上游判定凭据无效时调用一次，让下一个请求重新取凭据。 */
  onCredentialRejected?: () => void;
  idempotencyStore: IdempotencyStore;
  idempotencyTtlSeconds: number;
  generationConfirmationSecret: string;
  generationConfirmationTtlSeconds: number;
  /**
   * 上传票据。只有远程 HTTP 服务会给这三项；stdio 没有中转端点，工具据此拒绝。
   * 票据格式与用途见 services/upload-ticket.ts。
   */
  uploadBaseUrl?: string;
  uploadTicketTtlSeconds?: number;
  uploadMaxBytes?: number;
  /** 上传存进资产库时的上限（按类型）；省略则只走 /model/uploadMedia。 */
  libraryUpload?: LibraryUploadLimits;
  /** 短上传地址：完整票据存这里，URL 里只放编号。省略则发长票据。 */
  uploadTicketStore?: UploadTicketStore;
  /** 报价记录：确认时按参数找回报价，不靠模型抄回令牌（generation-confirmation.ts）。 */
  quoteStore?: UploadTicketStore;
  /** 素材地址 → 原文件名，报价卡按原名显示输入素材（media-names.ts）。 */
  mediaNameStore?: UploadTicketStore;
  /** 这个 OAuth 客户端调过卡片专用工具，也就是会显示卡片（card-clients.ts）。 */
  knownCardClient?: boolean;
  /** 本次工具调用的统计对象。只有开了埋点、且这是一次 tools/call 时才有。 */
  toolCall?: ToolCallTelemetry;
}

/** 上传存进资产库（资产库二期）的限制，默认值跟 AssetD 一致。 */
export interface LibraryUploadLimits {
  /** 图片、音频的大小上限。 */
  maxBytes: number;
  /** 视频、3D 的大小上限。 */
  maxVideoBytes: number;
  /** 图片像素上限（AssetD 拒收超过的图片）。 */
  maxImagePixels: number;
  /** 每个账户的上传空间，只用在「空间已满」的提示里。 */
  quotaBytes: number;
}

const requestContext = new AsyncLocalStorage<AtlasRequestContext>();

export function runWithRequestContext<T>(
  context: AtlasRequestContext,
  operation: () => T
): T {
  return requestContext.run(context, operation);
}

export function getRequestContext(): AtlasRequestContext | undefined {
  return requestContext.getStore();
}
