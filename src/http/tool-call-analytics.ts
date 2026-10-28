import type { RequestHandler, Response } from "express";
import type { HttpServerConfig } from "../config.js";
import { clientPlatform, type ClientPlatform } from "../services/client-profile.js";
import { ToolCallTelemetry } from "../services/tool-call-telemetry.js";
import { isAtlasToolName } from "../tool-policy.js";
import { SERVER_VERSION } from "../version.js";

/**
 * 托管 MCP 的工具调用埋点：每次 tools/call 在响应结束时发一条 PostHog 事件 `mcp_tool_call`。
 *
 * 字段对齐 Atlas CLI 的 `cli_command`（见 services/tool-call-telemetry.ts），再加
 * product=atlas-mcp、client_platform、is_error。distinct_id 是 `uid-<用户 ID>`，与 kubedl
 * `analytics.UserDistinctID`、aiproxy `credit_consume` 同一个人——CLI 只有匿名安装 ID，
 * MCP 服务端拿得到令牌里的 sub，所以直接用人。
 *
 * 不发的情况：没配 POSTHOG_KEY；不是 tools/call；令牌的 sub 不是数字用户 ID（不是 Atlas
 * 授权服务器签的令牌，拿去和 kubedl/aiproxy 对不上）。本地 npm 版（stdio、API key 直连）
 * 不经过这里，一条也不发。JSON-RPC 批量请求不统计（MCP 2025-06-18 起已取消批量）。
 */

export const TOOL_CALL_EVENT = "mcp_tool_call";
const PRODUCT = "atlas-mcp";
const TOOL_CALL_LOCAL = "toolCall";

export interface AnalyticsEvent {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}

export interface AnalyticsSink {
  capture(event: AnalyticsEvent): void;
  shutdown(): Promise<void>;
}

/** 按配置建 PostHog 发送器；没配 key 返回 undefined，调用方据此整套不启用。 */
export async function createPostHogSink(
  settings: HttpServerConfig["analytics"]
): Promise<AnalyticsSink | undefined> {
  if (!settings) return undefined;
  // 动态加载：没开埋点的进程（包括本地 stdio 版）不加载 SDK。
  const { PostHog } = await import("posthog-node");
  // 服务端发的事件带的是 pod 的出口 IP，按它做地理定位只会把所有人定到机房。
  const client = new PostHog(settings.key, { host: settings.host, disableGeoip: true });
  let reported = false;
  client.on("error", (error: unknown) => {
    if (reported) return;
    reported = true;
    // 只打类型名：SDK 的错误文本可能带请求地址。埋点失败不影响任何请求，打一次就够了。
    console.error(
      `PostHog event delivery failed (${error instanceof Error ? error.name : "unknown error"}); further failures are not logged`
    );
  });
  return {
    capture: (event) => client.capture(event),
    shutdown: () => client.shutdown(3000),
  };
}

/** distinct_id，与 kubedl analytics.UserDistinctID 同形。sub 不是数字用户 ID 时不发。 */
export function userDistinctId(sub: unknown): string | undefined {
  return typeof sub === "string" && /^[0-9]{1,20}$/.test(sub) ? `uid-${sub}` : undefined;
}

/**
 * 动态注册的客户端 client_id 是随机的，名字只在 initialize 的 clientInfo 里出现，之后的
 * tools/call 不再带。服务是无状态的，只能按 client_id 记住 initialize 时归到的平台（只记
 * 枚举，不记原名）。进程内、有上限；多副本下 initialize 与 tools/call 落在不同 pod 时记不上，
 * 退回看 User-Agent。
 */
export class ClientPlatformMemory {
  private readonly platforms = new Map<string, ClientPlatform>();

  constructor(private readonly limit = 10_000) {}

  remember(clientId: string, platform: ClientPlatform): void {
    this.platforms.delete(clientId);
    this.platforms.set(clientId, platform);
    if (this.platforms.size > this.limit) {
      const oldest = this.platforms.keys().next().value;
      if (oldest !== undefined) this.platforms.delete(oldest);
    }
  }

  recall(clientId: string | undefined): ClientPlatform | undefined {
    return clientId ? this.platforms.get(clientId) : undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 中间件放进 res.locals 的统计对象，处理器拿它塞进请求上下文、接到传输层上。 */
export function toolCallOf(res: Response): ToolCallTelemetry | undefined {
  const value: unknown = res.locals[TOOL_CALL_LOCAL];
  return value instanceof ToolCallTelemetry ? value : undefined;
}

/**
 * 放在 requireBearerAuth 之后（要用令牌里的 sub 与 client_id）、限流之前（被限流的调用也
 * 要记下来）。没配 key 时是直通。
 */
export function trackToolCalls(
  config: HttpServerConfig,
  sink: AnalyticsSink | undefined,
  memory: ClientPlatformMemory = new ClientPlatformMemory()
): RequestHandler {
  const settings = config.analytics;
  if (!sink || !settings) {
    return (_req, _res, next) => next();
  }
  const base = {
    product: PRODUCT,
    environment: settings.environment,
    version: SERVER_VERSION,
  };
  return (req, res, next) => {
    const payload = asRecord(req.body);
    const params = asRecord(payload?.params);
    const clientId = req.auth?.clientId;

    if (payload?.method === "initialize") {
      const name = asRecord(params?.clientInfo)?.name;
      const platform = clientPlatform(clientId, typeof name === "string" ? name : undefined);
      if (clientId && platform !== "unknown") memory.remember(clientId, platform);
      next();
      return;
    }
    if (payload?.method !== "tools/call") {
      next();
      return;
    }
    const distinctId = userDistinctId(req.auth?.extra?.sub);
    if (!distinctId) {
      next();
      return;
    }

    const toolName = params?.name;
    const toolCall = new ToolCallTelemetry(
      typeof toolName === "string" && isAtlasToolName(toolName) ? toolName : "unknown"
    );
    res.locals[TOOL_CALL_LOCAL] = toolCall;
    const platform = memory.recall(clientId) ?? clientPlatform(clientId, req.get("user-agent"));

    let sent = false;
    const send = (disconnected: boolean): void => {
      if (sent) return;
      sent = true;
      try {
        sink.capture({
          distinctId,
          event: TOOL_CALL_EVENT,
          properties: toolCall.properties(
            { ...base, client_platform: platform },
            res.statusCode,
            { disconnected }
          ),
        });
      } catch {
        // 埋点永远不影响请求本身。
      }
    };
    res.once("finish", () => send(false));
    // 响应没写完连接就断了（客户端工具超时最常见）：不发就会把最慢的那批调用从耗时里漏掉。
    res.once("close", () => send(!res.writableFinished));
    next();
  };
}
