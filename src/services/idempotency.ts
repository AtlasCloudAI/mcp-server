import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { ApiRequestError } from "./api-client.js";
import { getRequestContext } from "./request-context.js";

export type StoredRecord<T> =
  | { fingerprint: string; state: "pending"; createdAt: number }
  | { fingerprint: string; state: "completed"; createdAt: number; result: T }
  // 上游明确拒收（4xx）：这一单没开始，也没扣钱。
  | { fingerprint: string; state: "rejected"; createdAt: number }
  | { fingerprint: string; state: "uncertain"; createdAt: number };

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
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

function existingResult<T>(
  existing: StoredRecord<T>,
  fingerprint: string
): T {
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

function currentStore(): IdempotencyStore {
  return getRequestContext()?.idempotencyStore ?? stdioStore;
}

function namespacedKey(toolName: string, idempotencyKey: string): string {
  const subject = getRequestContext()?.subject ?? "stdio";
  return `${subject}:${toolName}:${idempotencyKey}`;
}
