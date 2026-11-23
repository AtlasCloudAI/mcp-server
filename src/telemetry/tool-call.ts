import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/**
 * One tool call's telemetry record. The wrapper in telemetry.ts opens one per
 * tools/call and runs the handler inside it; the API client and the generation
 * flow fill it in as they go; the wrapper turns it into a `mcp_local_tool_call`
 * event when the handler returns.
 *
 * Field names and values follow the hosted server's `mcp_tool_call` and the
 * Atlas CLI's `cli_command`, so the three can share dashboards. Only metadata
 * goes in: tool names, catalog model IDs, enum values, counts, sizes and
 * durations. Prompts, URLs, file names, paths, keys and output text never do —
 * the setters below take nothing that could carry free text.
 */

export type ExecutionMode = "estimate" | "dry_run" | "submit" | "wait" | "get" | "list" | "chat" | "upload" | "read";

export type ToolCallStage = "command" | "prepare" | "schema" | "submit" | "fetch" | "upload";

export type GenerationStatus = "completed" | "failed" | "timeout" | "processing" | "queued" | "pending" | "unknown";

/** Error code → [error_category, retryable], same codes and categories as the hosted server and the CLI. */
const ERROR_CODES = {
  invalid_param: ["invalid_request", false],
  request_too_large: ["invalid_request", false],
  model_not_found: ["model", false],
  model_type_mismatch: ["model", false],
  model_schema_unavailable: ["model", true],
  auth_required: ["auth", false],
  auth_expired: ["auth", false],
  access_denied: ["auth", false],
  quota_exceeded: ["quota", false],
  rate_limited: ["rate_limit", true],
  resource_not_found: ["not_found", false],
  network_error: ["network", true],
  timeout: ["network", true],
  upstream_failure: ["internal", false],
  provider_auth_required: ["provider_auth", false],
  provider_insufficient_balance: ["provider_account", false],
  provider_account_blocked: ["provider_account", false],
  provider_access_denied: ["provider_access", false],
  provider_model_unavailable: ["provider_access", false],
  provider_no_compatible_account: ["provider_account", false],
  router_not_found: ["router", false],
  model_overloaded: ["model", true],
  content_policy_violation: ["provider_policy", false],
  prediction_not_found: ["prediction", false],
  prediction_status_rejected: ["wait", false],
  generation_failed: ["generation", false],
  local_file_error: ["invalid_request", false],
  internal_error: ["internal", false],
} as const satisfies Record<string, readonly [string, boolean]>;

export type ToolErrorCode = keyof typeof ERROR_CODES;

export interface ToolCallError {
  code: ToolErrorCode;
  httpStatus?: number;
  /** A finer reason inside the code. Fixed enum values only. */
  cause?: string;
  /** For schema failures: the parameter name the model schema declares. Never its value. */
  param?: string;
}

/** Fields the tools and services fill in. Later writes win. */
export interface ToolCallFields {
  model?: string;
  model_type?: string;
  execution_mode?: ExecutionMode;
  stage?: ToolCallStage;
  generation_status?: GenerationStatus;
  task_hash?: string;
  /** Price the platform reports for the task (USD), as returned, whatever its charge state. */
  price_usd?: number;
  /** Charge state from the result payload: charged / partially_charged / pending / not_charged / refunded. */
  charge_status?: string;
  /** What was actually charged (USD): the price once charged, 0 when not charged or refunded, absent while pending. */
  charged_usd?: number;
  output_count?: number;
  /** A completed task whose outputs were all withheld by the content filter. */
  nsfw_blocked?: boolean;
  /** Platform-side latency of the task (ms), from the result payload. */
  task_latency_ms?: number;
  /** LLM chat: wire protocol and token usage. */
  llm_protocol?: string;
  stream?: boolean;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  finish_reason?: string;
  /** Uploads: size and coarse type of the file, never its name or path. */
  upload_bytes?: number;
  upload_kind?: string;
  /** Listing tools: how many rows came back. */
  result_rows?: number;
  /** Model schema had to be skipped (could not be fetched). */
  schema_skipped?: boolean;
  /** quick_generate: how many catalog models the keyword matched. */
  model_candidates?: number;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const ENUM_VALUE = /^[a-z0-9_.-]{1,40}$/;

export function sanitizeModel(model: unknown): string | undefined {
  return typeof model === "string" && MODEL_ID.test(model) ? model : undefined;
}

export function sanitizeEnum(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  return ENUM_VALUE.test(lower) ? lower : undefined;
}

export function telemetryNumber(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1e6) / 1e6;
}

/**
 * The parameter a schema error is about: the first `backticked` identifier in
 * the first error line. Schema field names only; anything else is dropped.
 */
export function schemaErrorParam(errors: unknown): string | undefined {
  const first = Array.isArray(errors) ? errors[0] : undefined;
  if (typeof first !== "string") return undefined;
  const match = first.match(/`([A-Za-z_][A-Za-z0-9_.]{0,39})`/);
  return match?.[1];
}

/** Same hash as the hosted server and the CLI: one value per task, never the raw ID. */
export function taskHash(predictionId: unknown): string | undefined {
  if (typeof predictionId !== "string" || predictionId.trim() === "") return undefined;
  return createHash("sha256").update(`atlas-task:${predictionId.trim()}`).digest("hex").slice(0, 16);
}

const ACTIVE = new Set(["created", "starting", "running", "in_progress", "processing"]);

export function normalizeGenerationStatus(status: unknown): GenerationStatus | undefined {
  if (typeof status !== "string" || status.trim() === "") return undefined;
  const value = status.trim().toLowerCase();
  if (value === "completed" || value === "succeeded" || value === "success") return "completed";
  if (value === "failed" || value === "error" || value === "canceled" || value === "cancelled") return "failed";
  if (value === "timeout" || value === "queued" || value === "pending") return value;
  return ACTIVE.has(value) ? "processing" : "unknown";
}

/** Upstream message → error code. Same wording checks as the CLI's classifyError, in the same order. */
export function errorCodeForMessage(message: string): ToolErrorCode | undefined {
  const lower = message.toLowerCase();
  if (
    lower.includes("you must log in first") ||
    lower.includes("no api-key provided") ||
    lower.includes("provider account authentication failed")
  ) {
    return "provider_auth_required";
  }
  if (lower.includes("insufficient account balance") || lower.includes("provider account has insufficient balance")) {
    return "provider_insufficient_balance";
  }
  if (lower.includes("user has been banned") || lower.includes("provider account is blocked")) {
    return "provider_account_blocked";
  }
  if (lower.includes("provider access was denied")) return "provider_access_denied";
  if (lower.includes("provider model is unavailable for this account")) return "provider_model_unavailable";
  if (lower.includes("no available compatible accounts")) return "provider_no_compatible_account";
  if (lower.includes("router not found")) return "router_not_found";
  if (lower.includes("serveroverloaded") || lower.includes("model_overloaded")) return "model_overloaded";
  if (lower.includes("content policy") || lower.includes("sensitive content") || lower.includes("nsfw")) {
    return "content_policy_violation";
  }
  if (lower.includes("insufficient balance") || lower.includes("insufficient_balance")) return "quota_exceeded";
  return undefined;
}

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

export type ExitClass =
  | "ok"
  | "user"
  | "api_4xx"
  | "network_5xx"
  | "generation_failed"
  | "unknown"
  | "internal";

/** The CLI's exit_class buckets, inferred from the error since MCP has no exit code. */
export function exitClassOf(error: ToolCallError | undefined, fields: ToolCallFields): ExitClass {
  if (!error) return fields.generation_status === "failed" ? "generation_failed" : "ok";
  if (error.code === "generation_failed") return "generation_failed";
  const status = error.httpStatus;
  if (status !== undefined && status >= 500) return "network_5xx";
  const [category] = ERROR_CODES[error.code];
  if (category === "network") return "network_5xx";
  if (status !== undefined && status >= 400) return "api_4xx";
  if (["invalid_request", "auth", "quota", "model"].includes(category)) return "user";
  if (category === "internal") return "internal";
  return "unknown";
}

/** One HTTP exchange with Atlas, as the API client saw it. */
export interface ApiExchange {
  /** "GET /model/prediction/:id" — IDs replaced, query dropped. */
  route: string;
  status?: number;
  durationMs: number;
  /** 0 for the first try. */
  attempt: number;
  /** network | timeout, when no HTTP status came back. */
  failure?: "network" | "timeout";
}

const MAX_ROUTES = 12;

export class ToolCallRecord {
  readonly startedAt = performance.now();
  private readonly fields: ToolCallFields = {};
  private error?: ToolCallError;
  private apiRequests = 0;
  private apiRetries = 0;
  private apiMs = 0;
  private apiErrors = 0;
  private lastHttpStatus?: number;
  private readonly routes: string[] = [];

  constructor(readonly command: string) {}

  annotate(fields: ToolCallFields): void {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (this.fields as Record<string, unknown>)[key] = value;
    }
  }

  /** First error wins: the specific branch records before a generic fallback can. */
  recordError(error: ToolCallError): void {
    this.error ??= error;
  }

  recordApi(exchange: ApiExchange): void {
    this.apiRequests += 1;
    if (exchange.attempt > 0) this.apiRetries += 1;
    this.apiMs += exchange.durationMs;
    if (exchange.status !== undefined) this.lastHttpStatus = exchange.status;
    if (exchange.failure || (exchange.status !== undefined && exchange.status >= 400)) this.apiErrors += 1;
    if (this.routes.length < MAX_ROUTES && !this.routes.includes(exchange.route)) this.routes.push(exchange.route);
  }

  get annotations(): Readonly<ToolCallFields> {
    return this.fields;
  }

  /**
   * Assemble the event properties. `isError` is what the tool returned to the
   * client; `thrown` means the handler threw instead of returning.
   */
  properties(outcome: { isError: boolean; thrown?: boolean; resultChars?: number; contentItems?: number }): Record<string, unknown> {
    const fields: ToolCallFields = { ...this.fields };
    let error: ToolCallError | undefined;
    if (outcome.isError || outcome.thrown) {
      error = this.error ?? (this.lastHttpStatus && this.lastHttpStatus >= 400
        ? { code: errorCodeForHttpStatus(this.lastHttpStatus), httpStatus: this.lastHttpStatus }
        : { code: outcome.thrown ? "internal_error" : "upstream_failure" });
      if (
        error.code === "invalid_param" &&
        error.httpStatus === 400 &&
        (fields.execution_mode === "get" || fields.execution_mode === "wait")
      ) {
        error = { ...error, code: "prediction_status_rejected" };
      }
    }
    fields.stage ??= "command";
    const props: Record<string, unknown> = {
      command: this.command,
      duration_ms: Math.max(0, Math.round(performance.now() - this.startedAt)),
      is_error: error !== undefined,
      exit_class: exitClassOf(error, fields),
      api_requests: this.apiRequests,
      api_retries: this.apiRetries,
      api_errors: this.apiErrors,
      api_ms: Math.round(this.apiMs),
      api_routes: this.routes,
      ...(this.lastHttpStatus !== undefined ? { last_http_status: this.lastHttpStatus } : {}),
      ...(outcome.resultChars !== undefined ? { result_chars: outcome.resultChars } : {}),
      ...(outcome.contentItems !== undefined ? { content_items: outcome.contentItems } : {}),
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

const storage = new AsyncLocalStorage<ToolCallRecord>();

export function runInToolCall<T>(record: ToolCallRecord, fn: () => T): T {
  return storage.run(record, fn);
}

export function currentToolCall(): ToolCallRecord | undefined {
  return storage.getStore();
}

/** Fill in the current tool call. Outside a tool call (startup prefetch) it does nothing. */
export function annotateToolCall(fields: ToolCallFields): void {
  storage.getStore()?.annotate(fields);
}

export function recordToolCallError(error: ToolCallError): void {
  storage.getStore()?.recordError(error);
}
