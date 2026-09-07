import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { IdempotencyStore } from "./idempotency.js";

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
