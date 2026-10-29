import { createHash } from "node:crypto";
import { getRequestContext } from "./request-context.js";

/**
 * 一次 MCP 工具调用的统计对象：HTTP 中间件建、工具回填、响应结束时组装成 `mcp_tool_call`。
 *
 * 字段名和取值沿用 Atlas CLI 的 `cli_command`（AtlasCloudTeam/cli
 * `internal/cli/telemetry.go`），两边的事件才能在 PostHog 里放进同一张表。
 * 这里只收内部元数据：工具名、目录里的模型 ID、枚举值。提示词、URL、文件名、
 * 令牌、邮箱一律不进来——回填接口只接受下面这几个字段，没有放自由文本的口子。
 */

/**
 * 取值沿用 CLI。estimate：只报价、没提交（CLI 的 generate.cost.* 也是这个值）；
 * submit：提交了（同步出结果也算）；wait / get：查任务，服务端等或不等。
 */
export type ExecutionMode = "estimate" | "submit" | "wait" | "get";

/**
 * 调用最后停在哪一步，CLI 的 stage 取值的子集。没有回填时是 command，与 CLI 一致。
 * auth / request 只用于工具没跑到的 HTTP 层拒绝。
 */
export type ToolCallStage =
  | "command"
  | "auth"
  | "request"
  | "prepare"
  | "schema"
  | "quote"
  | "submit"
  | "fetch"
  | "wait";

/** 与 CLI 同值。completed 只表示等到了终态，终态也可能是 failed。 */
export type WaitOutcome = "completed" | "timed_out" | "interrupted" | "error";

/** 与 CLI 的 recordGeneration 同一套值，见 normalizeGenerationStatus。 */
export type GenerationStatus =
  | "completed"
  | "failed"
  | "timeout"
  | "processing"
  | "queued"
  | "pending"
  | "unknown";

/**
 * 错误码 → [error_category, retryable]，码与分类照抄 CLI 的 normalizeCLIError /
 * classifyError，看板上两边的失败才能按同一个 error_code 合并。
 * client_disconnected 是 MCP 独有的：客户端等不及（多半是它自己的工具超时）先断了连接。
 */
const ERROR_CODES = {
  invalid_param: ["invalid_request", false],
  request_too_large: ["invalid_request", false],
  model_not_found: ["model", false],
  model_schema_unavailable: ["model", true],
  auth_required: ["auth", false],
  auth_expired: ["auth", false],
  access_denied: ["auth", false],
  quota_exceeded: ["quota", false],
  rate_limited: ["rate_limit", true],
  resource_not_found: ["not_found", false],
  confirmation_required: ["billing", false],
  submission_unknown: ["submission", false],
  idempotency_conflict: ["idempotency", false],
  idempotency_in_progress: ["idempotency", true],
  network_error: ["network", true],
  upstream_failure: ["internal", false],
  client_disconnected: ["network", true],
} as const satisfies Record<string, readonly [string, boolean]>;

export type ToolErrorCode = keyof typeof ERROR_CODES;

export interface ToolCallError {
  code: ToolErrorCode;
  /** 上游 API 的 HTTP 状态；HTTP 层拒绝时是本服务的响应状态。 */
  httpStatus?: number;
  /** CLI 的 error_cause：同一个码下更细的原因，只放固定枚举。 */
  cause?: string;
  /** CLI 的 error_param：参数校验失败时，模型 schema 里声明过的字段名。不带字段值。 */
  param?: string;
}

export interface ToolCallFields {
  model?: string;
  execution_mode?: ExecutionMode;
  generation_status?: GenerationStatus;
  stage?: ToolCallStage;
  wait_outcome?: WaitOutcome;
  task_hash?: string;
}

// 与目录里的模型 ID 同形（tools/predictions.ts 的 modelIdPattern）。不同形的一律不报，
// 因为那可能是用户随手填的文本。
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function sanitizeModel(model: unknown): string | undefined {
  return typeof model === "string" && MODEL_ID.test(model) ? model : undefined;
}

/**
 * 任务去重键：对任务 ID 加固定前缀做 SHA-256，取前 16 位十六进制。同一个任务的提交和
 * 每次查询拿到同一个值，能数出唯一任务；不发原始任务 ID。CLI 还没有这个字段，
 * 它要接的话用同一前缀和算法，两边就能对上。
 */
export function taskHash(predictionId: unknown): string | undefined {
  if (typeof predictionId !== "string" || predictionId.trim() === "") return undefined;
  return createHash("sha256")
    .update(`atlas-task:${predictionId.trim()}`)
    .digest("hex")
    .slice(0, 16);
}

const ACTIVE = new Set(["created", "starting", "running", "in_progress"]);

/**
 * 把平台返回的任务状态归一成 CLI 的那套值。CLI 把 created/starting 这类还在跑的状态记成
 * unknown；这里记成 processing，值域不变、信息不丢。其余没见过的状态记 unknown。
 */
export function normalizeGenerationStatus(status: unknown): GenerationStatus | undefined {
  if (typeof status !== "string" || status.trim() === "") return undefined;
  const value = status.trim().toLowerCase();
  if (value === "completed" || value === "succeeded") return "completed";
  if (["failed", "timeout", "processing", "queued", "pending"].includes(value)) {
    return value as GenerationStatus;
  }
  return ACTIVE.has(value) ? "processing" : "unknown";
}

/** HTTP 状态 → 错误码，与 CLI classifyError 的状态码兜底分支一致。 */
export function errorCodeForHttpStatus(status: number): ToolErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "invalid_param";
    case 401:
      return "auth_required";
    case 402:
      return "quota_exceeded";
    case 403:
      return "access_denied";
    case 404:
      return "resource_not_found";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limited";
    default:
      return "upstream_failure";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// SDK（McpServer）把入参校验失败包成 isError 结果，文案固定以这句开头。
const SDK_INPUT_VALIDATION = "Input validation error";
const JSON_RPC_INVALID_PARAMS = -32602;

export class ToolCallTelemetry {
  private readonly fields: ToolCallFields = {};
  private error?: ToolCallError;
  /** 从发出的 JSON-RPC 响应里看到的结果；undefined 表示响应没经过 MCP 传输层。 */
  private responseIsError?: boolean;
  private responseFallback?: ToolErrorCode;

  constructor(
    readonly command: string,
    private readonly startedAt: number = performance.now()
  ) {}

  /** 回填字段。后写的覆盖先写的：查询任务时最后一次拿到的状态才是答案。 */
  annotate(fields: ToolCallFields): void {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (this.fields as Record<string, unknown>)[key] = value;
    }
  }

  /** 记录出错原因。先记的优先：具体分支先记，handleError 之类的兜底后记不会盖掉它。 */
  recordError(error: ToolCallError): void {
    this.error ??= error;
  }

  /** 传输层发出的每条 JSON-RPC 消息都过一遍；只认带结果或错误的那条响应。 */
  observeResponse(message: unknown): void {
    const record = asRecord(message);
    if (!record || !("id" in record)) return;
    const rpcError = asRecord(record.error);
    if (rpcError) {
      this.responseIsError = true;
      this.responseFallback =
        rpcError.code === JSON_RPC_INVALID_PARAMS ? "invalid_param" : "upstream_failure";
      return;
    }
    const result = asRecord(record.result);
    if (!result) return;
    this.responseIsError = result.isError === true;
    if (this.responseIsError) {
      const first = Array.isArray(result.content) ? asRecord(result.content[0]) : undefined;
      this.responseFallback =
        typeof first?.text === "string" && first.text.startsWith(SDK_INPUT_VALIDATION)
          ? "invalid_param"
          : "upstream_failure";
    }
  }

  /**
   * 组装事件属性。httpStatus 是本服务回给客户端的状态；disconnected 表示响应没写完
   * 客户端就断了。错误字段只在 is_error 时出现，免得成功调用带着半路记下的错误码。
   */
  properties(
    base: Record<string, unknown>,
    httpStatus: number,
    options: { disconnected?: boolean; now?: number } = {}
  ): Record<string, unknown> {
    const now = options.now ?? performance.now();
    const fields: ToolCallFields = { ...this.fields };
    let error: ToolCallError | undefined;
    if (options.disconnected) {
      error = { code: "client_disconnected" };
      // 服务端还在替调用方等任务，客户端先走了：与 CLI 本地等待被打断同义。
      if (fields.execution_mode === "wait") fields.wait_outcome ??= "interrupted";
    } else if (httpStatus >= 400) {
      // 工具没跑到（限流、scope 不够、账户没绑凭据……），按本服务的响应状态分类。
      error = { code: errorCodeForHttpStatus(httpStatus), httpStatus };
      fields.stage ??= httpStatus === 401 || httpStatus === 403 ? "auth" : "request";
    } else if (this.responseIsError) {
      error = this.error ?? { code: this.responseFallback ?? "upstream_failure" };
    }
    fields.stage ??= "command";
    const props: Record<string, unknown> = {
      ...base,
      command: this.command,
      duration_ms: Math.max(0, Math.round(now - this.startedAt)),
      is_error: error !== undefined,
      ...fields,
    };
    if (error) {
      const [category, retryable] = ERROR_CODES[error.code];
      props.error_code = error.code;
      props.error_category = category;
      props.retryable = retryable;
      props.failure_stage = fields.stage;
      if (error.httpStatus) props.http_status = error.httpStatus;
      if (error.cause) props.error_cause = error.cause;
      if (error.param) props.error_param = error.param;
    }
    return props;
  }
}

function current(): ToolCallTelemetry | undefined {
  return getRequestContext()?.toolCall;
}

/** 给当前工具调用回填字段；不在托管 HTTP 请求里（stdio、测试）时什么也不做。 */
export function annotateToolCall(fields: ToolCallFields): void {
  current()?.annotate(fields);
}

export function recordToolCallError(error: ToolCallError): void {
  current()?.recordError(error);
}
