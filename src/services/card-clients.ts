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

/**
 * 客户端在 initialize 里有没有声明 MCP Apps（capabilities.extensions["io.modelcontextprotocol/ui"]）。
 * GrokBot 自报的名字也是「Cursor」，按 OAuth 客户端认不出，卡片专用工具（上传卡、作废报价…）照样列给它，
 * 它却显示不了卡片（11-12 回归）。Cursor 3.29 声明了这个扩展（cursor-mcp 的 createSdkClient），GrokBot 没有。
 * 服务无状态，列工具时看不到 initialize，所以 initialize 时按 client_id 记下来。
 */
const UI_KEY_PREFIX = "client-ui-ext:";
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";

function uiKeyOf(clientId: string): string {
  return UI_KEY_PREFIX + createHash("sha256").update(clientId).digest("hex");
}

/** initialize 请求的 params 里有没有声明 MCP Apps 扩展。不是 initialize 返回 undefined。 */
export function declaresMcpApps(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const message = body as { method?: unknown; params?: { capabilities?: { extensions?: Record<string, unknown> } } };
  if (message.method !== "initialize") return undefined;
  const extensions = message.params?.capabilities?.extensions;
  return Boolean(extensions && typeof extensions === "object" && MCP_APPS_EXTENSION in extensions);
}

/** 记下这个客户端声明了还是没声明。失败不影响请求。 */
export async function rememberUiDeclaration(clientId: string | undefined, declared: boolean, store: UploadTicketStore | undefined): Promise<void> {
  if (!clientId || !store) return;
  try {
    await withTimeout(store.put(uiKeyOf(clientId), declared ? "1" : "0", TTL_SECONDS));
  } catch {
    // 记不下来就照旧当会显示卡片。
  }
}

/** 这个客户端上次 initialize 时声明了吗：true / false；没记录或查不到是 undefined。 */
export async function uiDeclaration(clientId: string | undefined, store: UploadTicketStore | undefined): Promise<boolean | undefined> {
  if (!clientId || !store) return undefined;
  try {
    const value = await withTimeout(store.get(uiKeyOf(clientId)));
    return value === null ? undefined : value === "1";
  } catch {
    return undefined;
  }
}

/** initialize 的一行摘要（日志用）：客户端自报的名字、版本、协议版本、声明了哪些能力。不含令牌和用户信息。 */
export function initializeSummary(body: unknown, declared: boolean): string {
  const params = (body as { params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown }; capabilities?: Record<string, unknown> } })?.params;
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 80) : "?");
  const caps = params?.capabilities ? Object.keys(params.capabilities).join(",") : "";
  return `client=${text(params?.clientInfo?.name)} version=${text(params?.clientInfo?.version)} protocol=${text(params?.protocolVersion)} caps=${caps || "(none)"} mcp_apps=${declared}`;
}
