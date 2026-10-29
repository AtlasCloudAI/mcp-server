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
  /** 短上传地址：完整票据存这里，URL 里只放编号。省略则发长票据。 */
  uploadTicketStore?: UploadTicketStore;
  /** 报价记录：确认时按参数找回报价，不靠模型抄回令牌（generation-confirmation.ts）。 */
  quoteStore?: UploadTicketStore;
  /** 本次工具调用的统计对象。只有开了埋点、且这是一次 tools/call 时才有。 */
  toolCall?: ToolCallTelemetry;
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
