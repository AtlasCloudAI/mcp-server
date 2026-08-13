import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { getRequestContext } from "./request-context.js";

type StoredRecord<T> =
  | { fingerprint: string; state: "pending"; createdAt: number }
  | { fingerprint: string; state: "completed"; createdAt: number; result: T }
  | { fingerprint: string; state: "uncertain"; createdAt: number };

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
        record: { fingerprint, state: "uncertain", createdAt: now },
      });
      throw error;
    }
  }

  async ready(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly client: RedisClientType) {}

  async execute<T>(
    key: string,
    fingerprint: string,
    ttlSeconds: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const redisKey = `atlascloud:mcp:idempotency:${createHash("sha256")
      .update(key)
      .digest("hex")}`;
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
      const uncertain: StoredRecord<T> = {
        fingerprint,
        state: "uncertain",
        createdAt,
      };
      await this.client
        .set(redisKey, JSON.stringify(uncertain), {
          EX: ttlSeconds,
          XX: true,
        })
        .catch(() => undefined);
      throw error;
    }
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
  const store = context?.idempotencyStore ?? stdioStore;
  const subject = context?.subject ?? "stdio";
  const ttlSeconds = context?.idempotencyTtlSeconds ?? 86400;
  const namespacedKey = `${subject}:${toolName}:${idempotencyKey}`;
  return store.execute(
    namespacedKey,
    idempotencyFingerprint(args),
    ttlSeconds,
    operation
  );
}
