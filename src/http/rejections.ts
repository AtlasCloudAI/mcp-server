import type { Request, RequestHandler, Response } from "express";
import { clientPlatform } from "../services/client-profile.js";
import { remoteToolPolicy } from "../tool-policy.js";
import { isCardRefreshRequest } from "./middleware.js";

/**
 * 被拒的 /mcp 请求：原因分类、限流额度、协议版本，以及一行服务端日志。
 *
 * 2026-11-22 生产：一位用户的卡片调用 36 分钟里连续 264 次 HTTP 400，埋点只有状态码，日志里什么都没有，
 * 看不出是协议版本不对、JSON 坏了还是别的，只能找运维翻 ingress。这些拒绝大多发生在 MCP 传输层
 * （SDK 的 StreamableHTTPServerTransport），原因只写在响应体里。这里记下响应体开头，按固定的报错文字
 * 归类，不留响应原文、不记用户数据。
 */

const LOCAL_KEY = "rejection";
/** 归类只需要报错文字的开头；成功的响应也会过这里，只留这么多。 */
const HEAD_LIMIT = 400;

export type RejectionReason =
  | "rate_limited"
  | "tool_not_available"
  | "insufficient_scope"
  | "account_not_linked"
  | "invalid_token"
  | "unsupported_protocol_version"
  | "not_acceptable"
  | "unsupported_media_type"
  | "parse_error"
  | "invalid_jsonrpc"
  | "batch_limit"
  | "server_not_initialized"
  | "session_error"
  | "request_too_large"
  | "other";

// 顺序有讲究：先认本服务自己的错误码，再认 SDK 的报错文字（node_modules/@modelcontextprotocol/sdk
// 的 webStandardStreamableHttp.js 里 createJsonErrorResponse 的那几句）。
const PATTERNS: ReadonlyArray<readonly [RegExp, RejectionReason]> = [
  [/rate_limit_exceeded/, "rate_limited"],
  [/tool_not_available/, "tool_not_available"],
  [/insufficient_scope/, "insufficient_scope"],
  [/account_not_linked/, "account_not_linked"],
  [/invalid_token/, "invalid_token"],
  [/request_too_large/, "request_too_large"],
  [/Batch requests may carry/, "batch_limit"],
  [/Unsupported protocol version/, "unsupported_protocol_version"],
  [/Not Acceptable/, "not_acceptable"],
  [/Unsupported Media Type/, "unsupported_media_type"],
  [/Parse error: Invalid JSON-RPC message|Invalid Request/, "invalid_jsonrpc"],
  [/Parse error/, "parse_error"],
  [/Server not initialized/, "server_not_initialized"],
  [/Mcp-Session-Id|Session not found/, "session_error"],
];

export function rejectionReason(head: string): RejectionReason {
  return PATTERNS.find(([pattern]) => pattern.test(head))?.[1] ?? "other";
}

/** MCP 协议版本头（形如 2025-06-18）；不是这个形状的不记，免得任意字符串进埋点和日志。 */
export function protocolVersionOf(req: Request): string | undefined {
  const value = req.get("mcp-protocol-version")?.trim();
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/** 本服务提供的工具名；别的一律 unknown，不把任意字符串写进日志。 */
function servedToolName(req: Request): string | undefined {
  const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
  if (body?.method !== "tools/call") return undefined;
  const name = body.params?.name;
  return typeof name === "string" && remoteToolPolicy(name) ? name : "unknown";
}

export interface Rejection {
  status: number;
  reason: RejectionReason;
  /** 限流时是哪份额度：卡片刷新单独计（MCP_CARD_REQUESTS_PER_MINUTE），其余算总额度。 */
  bucket?: "card" | "subject";
}

/** 中间件记下的拒绝信息；没被拒（状态码 < 400）时为 undefined。 */
export function rejectionOf(res: Response): Rejection | undefined {
  const value: unknown = res.locals[LOCAL_KEY];
  return value && typeof value === "object" ? (value as Rejection) : undefined;
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return "";
}

/**
 * 记下响应体开头，响应结束时状态码 >= 400 就归类，放进 res.locals 给埋点用，并打一行日志。
 * 401 一般不打日志（正常的 OAuth 挑战），account_not_linked 例外。放在认证之后、限流之前，限流的 429 也能记到。
 */
export function noteRejections(log: (line: string) => void = (line) => console.warn(line)): RequestHandler {
  return (req, res, next) => {
    let head = "";
    const capture = (chunk: unknown): void => {
      if (head.length >= HEAD_LIMIT) return;
      head += chunkText(chunk).slice(0, HEAD_LIMIT - head.length);
    };
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    const end = res.end.bind(res) as (...args: unknown[]) => Response;
    res.write = ((...args: unknown[]) => {
      capture(args[0]);
      return write(...args);
    }) as Response["write"];
    res.end = ((...args: unknown[]) => {
      if (typeof args[0] !== "function") capture(args[0]);
      if (res.statusCode >= 400) {
        const rejection: Rejection = {
          status: res.statusCode,
          reason: rejectionReason(head),
          ...(res.statusCode === 429 ? { bucket: isCardRefreshRequest(req) ? "card" : "subject" } : {}),
        };
        res.locals[LOCAL_KEY] = rejection;
        // 401 大多是正常的 OAuth 挑战（令牌过期、新连接），不打；「账户没绑凭据」不是例行的，照打。
        if (res.statusCode !== 401 || rejection.reason === "account_not_linked") {
          const body = req.body as { method?: unknown } | undefined;
          const method = typeof body?.method === "string" ? body.method : Array.isArray(req.body) ? "batch" : "-";
          log(
            `[mcp-rejected] status=${rejection.status} reason=${rejection.reason}` +
              `${rejection.bucket ? ` bucket=${rejection.bucket}` : ""}` +
              ` method=${method} tool=${servedToolName(req) ?? "-"}` +
              ` platform=${clientPlatform(req.auth?.clientId, req.get("user-agent"))}` +
              ` protocol=${protocolVersionOf(req) ?? "-"}`
          );
        }
      }
      return end(...args);
    }) as Response["end"];
    next();
  };
}
