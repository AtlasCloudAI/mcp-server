import { createHash } from "node:crypto";
import { getRequestContext } from "./request-context.js";
import type { UploadTicketStore } from "./upload-ticket-store.js";

/**
 * 认得出「会显示卡片」的客户端。
 *
 * 远端服务是无状态的，工具调用时拿不到 initialize 里的能力声明；ChatGPT、Claude 网页按 OAuth
 * 客户端认得出，Cursor 这类自行注册的客户端认不出，就被当成「有 shell 的其他客户端」：结果指引
 * 让模型用 curl 把图下到本地，而卡片里明明已经有图和 Download（11-05 Cursor 复测，问题 58）。
 *
 * 卡片专用工具（atlas_card_status、atlas_card_check_submission）只有卡片自己会调，客户端调过它们
 * 就说明它显示了卡片。记下这个 OAuth 客户端，之后同一客户端的请求按聊天类客户端给指引。
 * 借用报价记录的存储（多副本共用），键加前缀，不和报价记录撞上。
 */
const KEY_PREFIX = "card-client:";
// 同一个客户端注册一次会用很久；30 天没再显示过卡片就当它不再显示。
const TTL_SECONDS = 30 * 24 * 3600;
// 每个请求都要查一次，Redis 卡住时宁可当成认不出，也不拖慢工具调用。
const STORE_TIMEOUT_MS = 300;

function keyOf(clientId: string): string {
  return KEY_PREFIX + createHash("sha256").update(clientId).digest("hex");
}

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("card-client store timed out")), STORE_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** 卡片调了卡片专用工具：记下当前请求的 OAuth 客户端。失败不影响工具结果。 */
export async function rememberCardClient(store?: UploadTicketStore): Promise<void> {
  const context = getRequestContext();
  const clientId = context?.authInfo.clientId;
  const target = store ?? context?.quoteStore;
  if (!clientId || !target || context?.knownCardClient) return;
  try {
    await withTimeout(target.put(keyOf(clientId), "1", TTL_SECONDS));
  } catch {
    // 记不下来就下次再记。
  }
}

/** 这个 OAuth 客户端之前显示过卡片吗。查不到（没配存储、超时）就当没有。 */
export async function isKnownCardClient(clientId: string | undefined, store: UploadTicketStore | undefined): Promise<boolean> {
  if (!clientId || !store) return false;
  try {
    return (await withTimeout(store.get(keyOf(clientId)))) !== null;
  } catch {
    return false;
  }
}
