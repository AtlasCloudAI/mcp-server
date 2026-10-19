import { headContentLength } from "./api-client.js";
import { classifyOutput } from "./media-preview.js";
import { isAtlasStorageUrl, isPendingTransfer } from "./owned-storage.js";
import type { PredictionResponse } from "../response-schemas.js";

// 一次 atlas_get_prediction 在服务端多等一会儿再回答，原因有三（都是 2026-10-19 实测）：
//
// 1. 模型轮询得太密。技能里写「每 2 秒查一次」，单个会话就是每分钟 30 次，同一用户并行两三个
//    任务就撞上每用户每分钟 60 次的限流，工具调用直接以 HTTP 429 失败。
// 2. 轮询次数越多，模型越容易在「仍在处理中」时结束回合，用户看到的就是停在处理中。
// 3. 任务完成后，慢上游的结果先以上游链接返回、稍后才转存到我们的存储。在服务端等一等，
//    多数情况下直接拿到转存后的链接，而不是一个慢、且一天后过期的上游链接。
//
// 总等待控制在客户端工具调用超时以内（Codex 默认 60 秒）。

const ACTIVE_STATUSES = new Set([
  "created",
  "starting",
  "queued",
  "pending",
  "processing",
  "running",
  "in_progress",
]);

/** A status that means the job is still on its way, so polling should continue. */
export function isActive(status: string): boolean {
  return ACTIVE_STATUSES.has(status.toLowerCase());
}

export function isFinished(status: string): boolean {
  return status === "completed" || status === "succeeded";
}

export function completedAtOf(result: PredictionResponse): unknown {
  return (result.data as Record<string, unknown> | undefined)?.completed_at;
}

export function createdAtOf(result: PredictionResponse): unknown {
  return (result.data as Record<string, unknown> | undefined)?.created_at;
}

export function predictionOutputUrls(result: PredictionResponse): string[] {
  const outputs = result.data?.outputs || result.data?.output;
  return Array.isArray(outputs) ? outputs : outputs ? [outputs] : [];
}

/** Seconds since an ISO timestamp, or null when it is missing or unparseable. */
export function secondsSince(iso: unknown, now: number = Date.now()): number | null {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;
}

function transferHoldSeconds(): number {
  const parsed = Number.parseInt(process.env.MCP_TRANSFER_HOLD_SECONDS ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 3600) : 300;
}

/**
 * Image, video or audio outputs that are still on the provider's storage, and
 * recent enough that the copy to Atlas storage is worth waiting for. The
 * server keeps no state between calls, so the cut-off comes from the task's own
 * completed_at: past it (default 5 minutes) the provider link is handed over
 * rather than holding the user up indefinitely.
 */
export function hasUntransferredMedia(urls: string[], completedAt?: unknown): boolean {
  if (!holdUntransferredOutputs()) return false;
  // No completion time means no way to bound the hold: hand the link over.
  const since = secondsSince(completedAt);
  if (since === null || since > transferHoldSeconds()) return false;
  return urls.some((url) => classifyOutput(url) !== "other" && isPendingTransfer(url));
}

function holdUntransferredOutputs(): boolean {
  const raw = (process.env.MCP_HOLD_UNTRANSFERRED_OUTPUTS ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export function predictionWaitSeconds(): number {
  const parsed = Number.parseInt(process.env.MCP_PREDICTION_WAIT_SECONDS ?? "", 10);
  if (!Number.isFinite(parsed)) return 20;
  // Capped so the wait, an image preview fetch and the size probe stay inside a
  // client's tool timeout (Codex defaults to 60 s).
  return Math.min(Math.max(parsed, 0), 30);
}

// Each re-poll is a user prediction request, and while a job runs the platform asks
// the upstream provider for its status on those requests. 5 s keeps the server's
// loop no busier than an agent polling by hand.
const POLL_INTERVAL_MS = 5_000;

export interface WaitDependencies {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Fetch the prediction, and while it is still running (or finished but not yet on
 * Atlas storage) fetch it again every few seconds until the wait budget runs out.
 * Returns the last answer, which may still be unfinished — the caller says so.
 */
export interface FetchBudget {
  /** Per-request timeout for this fetch. */
  timeoutMs: number;
  /** Retries allowed for this fetch. */
  maxRetries: number;
}

// 一次请求默认 30 秒、重试 3 次，最坏两分多钟——会撑破客户端 60 秒的工具超时
// （2026-10-19 test 上实测一次查询 90 秒超时）。首查 15 秒重试 1 次，等待期间的重查
// 只用剩余预算、不重试，整次调用落在一分钟以内。
const FIRST_FETCH: FetchBudget = { timeoutMs: 15_000, maxRetries: 1 };

export async function waitForPrediction(
  fetchOnce: (budget: FetchBudget) => Promise<PredictionResponse>,
  dependencies: WaitDependencies = {}
): Promise<{ result: PredictionResponse; waitedSeconds: number }> {
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = dependencies.now ?? (() => Date.now());
  const started = now();
  const deadline = started + predictionWaitSeconds() * 1000;
  let result = await fetchOnce(FIRST_FETCH);
  for (;;) {
    const status = result.data?.status ?? "";
    const keepWaiting =
      isActive(status) ||
      (isFinished(status) &&
        hasUntransferredMedia(predictionOutputUrls(result), completedAtOf(result)));
    if (!keepWaiting || now() + POLL_INTERVAL_MS > deadline) break;
    await sleep(POLL_INTERVAL_MS);
    const remaining = deadline - now();
    if (remaining < 2_000) break;
    try {
      result = await fetchOnce({ timeoutMs: Math.min(remaining, 10_000), maxRetries: 0 });
    } catch {
      // The first answer was good; a transient error on a re-check should not turn
      // it into a failed tool call. Report what we have and let the agent poll again.
      break;
    }
  }
  return { result, waitedSeconds: Math.round((now() - started) / 1000) };
}

/** Byte sizes of finished media outputs on Atlas storage, for a completeness check. */
export async function probeSizes(urls: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  // Images too: half-written storyboards and edits were reproduced, not just videos.
  const targets = urls.filter((url) => classifyOutput(url) !== "other" && isAtlasStorageUrl(url));
  const settled = await Promise.all(targets.slice(0, 4).map((url) => headContentLength(url)));
  targets.slice(0, 4).forEach((url, i) => {
    const size = settled[i];
    if (size) sizes.set(url, size);
  });
  return sizes;
}
