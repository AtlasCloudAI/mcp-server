import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { ApiRequestError } from "./api-client.js";
import { getRequestContext } from "./request-context.js";
import { annotateToolCall } from "./tool-call-telemetry.js";

export type StoredRecord<T> =
  | { fingerprint: string; state: "pending"; createdAt: number }
  | { fingerprint: string; state: "completed"; createdAt: number; result: T }
  // 上游明确拒收（4xx）：这一单没开始，也没扣钱。
  | { fingerprint: string; state: "rejected"; createdAt: number }
  | { fingerprint: string; state: "uncertain"; createdAt: number }
  // 报价作废（atlas_cancel_quote）：用户说不要了（declined）或改了需求、另报了价（replaced）。
  // 占住这个幂等键，之后拿它确认一律拒绝；卡片后台核实时据此改成 Canceled / Settings changed。
  | { fingerprint: string; state: "canceled"; createdAt: number; reason: QuoteCancelReason };

export type QuoteCancelReason = "declined" | "replaced";

/**
 * 上游明确拒收、肯定没开始的失败：带状态码的 4xx（408 请求超时除外）。
 * 写请求不自动重试（api-client 里 POST 的重试次数是 0），所以状态码就是唯一那一次的回答。
 * 超时、断网、5xx、响应读不懂都算「不知道开没开始」。
 */
export function rejectedBeforeStart(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  const code = error.statusCode;
  return code !== undefined && code >= 400 && code < 500 && code !== 408;
}

/**
 * 请求发出去了却没等到能用的回答：超时、连接断开（undici 抛 TypeError）、5xx、响应读不懂。
 * 本地就失败的（文件读不到之类）不算：那一单根本没发出去，原样报原因。
 */
function sentWithoutAnswer(error: unknown): boolean {
  if (error instanceof ApiRequestError) return !rejectedBeforeStart(error);
  return error instanceof Error && (error.name === "AbortError" || error instanceof TypeError);
}

function settledState(error: unknown): "rejected" | "uncertain" {
  return rejectedBeforeStart(error) ? "rejected" : "uncertain";
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used with different arguments");
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyInProgressError extends Error {
  constructor() {
    super("A request with this idempotency key is still in progress");
    this.name = "IdempotencyInProgressError";
  }
}

export class IdempotencyRejectedError extends Error {
  constructor() {
    super(
      "A previous request with this idempotency key was rejected by Atlas Cloud before it started, so nothing was charged; use a new idempotency key to try again"
    );
    this.name = "IdempotencyRejectedError";
  }
}

/**
 * 写请求没拿到确定的回答（超时、断网、5xx）：可能已经开跑了。包一层，让报错里说清楚
 * 「先查再重试」，别让模型或卡片照着原来那句「请重试」再提交一单。
 */
export class UnconfirmedRequestError extends Error {
  constructor(readonly reason: unknown) {
    super("The request ended without a confirmed response");
    this.name = "UnconfirmedRequestError";
  }
}

/** 这份报价已经作废（atlas_cancel_quote）：卡片认 "quote was canceled" 这几个词，改措辞要同步 ui/generation-card/quote.ts。 */
export class IdempotencyCanceledError extends Error {
  constructor(readonly reason: QuoteCancelReason) {
    super(
      reason === "replaced"
        ? "This quote was canceled because the request changed and a newer quote replaced it; nothing was charged. Use the newer quote, or quote again"
        : "This quote was canceled because the user declined it; nothing was charged. Quote again only if the user asks for it"
    );
    this.name = "IdempotencyCanceledError";
  }
}

export class IdempotencyUncertainError extends Error {
  constructor() {
    super(
      "A previous request with this idempotency key ended without a confirmed response; check predictions or billing before starting a new request"
    );
    this.name = "IdempotencyUncertainError";
  }
}

export interface IdempotencyStore {
  execute<T>(
    key: string,
    fingerprint: string,
    ttlSeconds: number,
    operation: () => Promise<T>
  ): Promise<T>;
  /** 只看不动：这个键现在记着什么。卡片核实「上一次到底提交没有」用。 */
  peek(key: string): Promise<StoredRecord<unknown> | undefined>;
  /**
   * 占住一个还没用过的键，记成作废。键已经有记录（提交过、正在提交、已作废）就不动，返回那条记录；
   * 占到了返回 undefined。
   */
  cancel(key: string, ttlSeconds: number, reason: QuoteCancelReason): Promise<StoredRecord<unknown> | undefined>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

function existingResult<T>(
  existing: StoredRecord<T>,
  fingerprint: string
): T {
  if (existing.state === "canceled") throw new IdempotencyCanceledError(existing.reason);
  if (existing.fingerprint !== fingerprint) {
    throw new IdempotencyConflictError();
  }
  if (existing.state === "completed") return existing.result;
  if (existing.state === "rejected") throw new IdempotencyRejectedError();
  if (existing.state === "uncertain") throw new IdempotencyUncertainError();
  throw new IdempotencyInProgressError();
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<
    string,
    { expiresAt: number; record: StoredRecord<unknown> }
  >();

  async execute<T>(
    key: string,
    fingerprint: string,
    ttlSeconds: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const now = Date.now();
    const current = this.records.get(key);
    if (current && current.expiresAt > now) {
      return existingResult(current.record as StoredRecord<T>, fingerprint);
    }
    if (current) this.records.delete(key);

    const expiresAt = now + ttlSeconds * 1000;
    this.records.set(key, {
      expiresAt,
      record: { fingerprint, state: "pending", createdAt: now },
    });
    try {
      const result = await operation();
      this.records.set(key, {
        expiresAt,
        record: { fingerprint, state: "completed", createdAt: now, result },
      });
      return result;
    } catch (error) {
      this.records.set(key, {
        expiresAt,
        record: { fingerprint, state: settledState(error), createdAt: now },
      });
      throw error;
    }
  }

  async peek(key: string): Promise<StoredRecord<unknown> | undefined> {
    const current = this.records.get(key);
    return current && current.expiresAt > Date.now() ? current.record : undefined;
  }

  async cancel(key: string, ttlSeconds: number, reason: QuoteCancelReason): Promise<StoredRecord<unknown> | undefined> {
    const now = Date.now();
    const current = this.records.get(key);
    if (current && current.expiresAt > now) return current.record;
    this.records.set(key, { expiresAt: now + ttlSeconds * 1000, record: { fingerprint: "", state: "canceled", createdAt: now, reason } });
    return undefined;
  }

  async ready(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly client: RedisClientType) {}

  private redisKey(key: string): string {
    return `atlascloud:mcp:idempotency:${createHash("sha256").update(key).digest("hex")}`;
  }

  async execute<T>(
    key: string,
    fingerprint: string,
    ttlSeconds: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const redisKey = this.redisKey(key);
    const createdAt = Date.now();
    const pending: StoredRecord<T> = { fingerprint, state: "pending", createdAt };
    const reserved = await this.client.set(redisKey, JSON.stringify(pending), {
      EX: ttlSeconds,
      NX: true,
    });

    if (reserved === null) {
      const raw = await this.client.get(redisKey);
      if (!raw) {
        throw new IdempotencyInProgressError();
      }
      return existingResult(JSON.parse(raw) as StoredRecord<T>, fingerprint);
    }

    try {
      const result = await operation();
      const completed: StoredRecord<T> = {
        fingerprint,
        state: "completed",
        createdAt,
        result,
      };
      await this.client.set(redisKey, JSON.stringify(completed), {
        EX: ttlSeconds,
        XX: true,
      });
      return result;
    } catch (error) {
      const settled: StoredRecord<T> = {
        fingerprint,
        state: settledState(error),
        createdAt,
      };
      await this.client
        .set(redisKey, JSON.stringify(settled), {
          EX: ttlSeconds,
          XX: true,
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async peek(key: string): Promise<StoredRecord<unknown> | undefined> {
    const raw = await this.client.get(this.redisKey(key));
    return raw ? (JSON.parse(raw) as StoredRecord<unknown>) : undefined;
  }

  async cancel(key: string, ttlSeconds: number, reason: QuoteCancelReason): Promise<StoredRecord<unknown> | undefined> {
    const redisKey = this.redisKey(key);
    const record: StoredRecord<unknown> = { fingerprint: "", state: "canceled", createdAt: Date.now(), reason };
    const reserved = await this.client.set(redisKey, JSON.stringify(record), { EX: ttlSeconds, NX: true });
    if (reserved !== null) return undefined;
    const raw = await this.client.get(redisKey);
    return raw ? (JSON.parse(raw) as StoredRecord<unknown>) : undefined;
  }

  async ready(): Promise<boolean> {
    return (await this.client.ping()) === "PONG";
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }
}

export async function createRedisIdempotencyStore(
  url: string
): Promise<RedisIdempotencyStore> {
  const client: RedisClientType = createClient({ url });
  client.on("error", (error: Error) => {
    console.error(`Redis idempotency store error: ${error.message}`);
  });
  await client.connect();
  return new RedisIdempotencyStore(client);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

export function idempotencyFingerprint(args: Record<string, unknown>): string {
  const { idempotency_key: _ignored, ...operationArgs } = args;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(operationArgs)))
    .digest("hex");
}

const stdioStore = new InMemoryIdempotencyStore();

export async function executeIdempotently<T>(
  toolName: string,
  args: Record<string, unknown>,
  idempotencyKey: string,
  operation: () => Promise<T>
): Promise<T> {
  const context = getRequestContext();
  const ttlSeconds = context?.idempotencyTtlSeconds ?? 86400;
  // 走到这里的都是计费提交（生成、对话；上传只在 stdio 下有）。重放已完成的结果也记
  // submit：对调用方来说这就是那次提交的答复。
  annotateToolCall({ execution_mode: "submit", stage: "submit" });
  return currentStore().execute(
    namespacedKey(toolName, idempotencyKey),
    idempotencyFingerprint(args),
    ttlSeconds,
    async () => {
      try {
        return await operation();
      } catch (error) {
        throw sentWithoutAnswer(error) ? new UnconfirmedRequestError(error) : error;
      }
    }
  );
}

/** 当前登录的人用这个工具、这个幂等键提交过什么。只读，不占键。 */
export async function peekIdempotent(
  toolName: string,
  idempotencyKey: string
): Promise<StoredRecord<unknown> | undefined> {
  return currentStore().peek(namespacedKey(toolName, idempotencyKey));
}

/**
 * 作废一份还没提交的报价：占住它的幂等键。返回 canceled（这次作废的或之前就作废了）或 submitted（已经提交过，作废不了）。
 */
export async function cancelIdempotent(
  toolName: string,
  idempotencyKey: string,
  reason: QuoteCancelReason
): Promise<{ status: "canceled"; reason: QuoteCancelReason } | { status: "submitted"; record: StoredRecord<unknown> }> {
  const ttlSeconds = getRequestContext()?.idempotencyTtlSeconds ?? 86400;
  const existing = await currentStore().cancel(namespacedKey(toolName, idempotencyKey), ttlSeconds, reason);
  if (!existing) return { status: "canceled", reason };
  if (existing.state === "canceled") return { status: "canceled", reason: existing.reason };
  // 被上游明确拒收的那一单没开始：键已经用过，不能再确认，算作作废了。
  if (existing.state === "rejected") return { status: "canceled", reason };
  return { status: "submitted", record: existing };
}

function currentStore(): IdempotencyStore {
  return getRequestContext()?.idempotencyStore ?? stdioStore;
}

function namespacedKey(toolName: string, idempotencyKey: string): string {
  const subject = getRequestContext()?.subject ?? "stdio";
  return `${subject}:${toolName}:${idempotencyKey}`;
}
