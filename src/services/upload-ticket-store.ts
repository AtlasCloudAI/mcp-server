import { randomBytes } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

/**
 * 短上传地址。
 *
 * 票据本身（upload-ticket.ts）把加密后的 Atlas 令牌编进去，长约 2000 个字符。模型要把
 * 它原样抄进 curl 命令，2026-10-19 在 test 上实测三次里抄错两次（丢字符），上传被判
 * 票据无效。所以 URL 里只放一个 22 位的随机编号，完整票据存在这里，由中转端点取回后
 * 照旧校验。
 *
 * 存进来的仍是那张加密、签名过的票据：密钥由 generation-confirmation 的 secret 派生，
 * 只在进程里，Redis 里只有密文。有 Redis（生产、test）就用 Redis，多副本也能对上；
 * 没有就退回进程内存，单副本足够。
 */
export interface UploadTicketStore {
  put(id: string, ticket: string, ttlSeconds: number): Promise<void>;
  get(id: string): Promise<string | null>;
  /**
   * 原子地给一个数值加上 delta（可以是负数），返回加完后的值；键不存在时从 0 起，并设上过期时间。
   * 对话每日自动执行额度用它预占（spend-policy.ts，11-18 上线前审查 M6）。没实现的存储退回先读后写。
   */
  incrementBy?(id: string, delta: number, ttlSeconds: number): Promise<number>;
  close(): Promise<void>;
}

export const SHORT_TICKET_PREFIX = "t_";
const SHORT_TICKET = /^t_[A-Za-z0-9_-]{22}$/;

export function newShortTicketId(): string {
  return `${SHORT_TICKET_PREFIX}${randomBytes(16).toString("base64url")}`;
}

export function isShortTicket(value: string): boolean {
  return SHORT_TICKET.test(value);
}

export class InMemoryUploadTicketStore implements UploadTicketStore {
  private readonly tickets = new Map<string, { ticket: string; expiresAt: number }>();

  async put(id: string, ticket: string, ttlSeconds: number): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of this.tickets) {
      if (entry.expiresAt <= now) this.tickets.delete(key);
    }
    this.tickets.set(id, { ticket, expiresAt: now + ttlSeconds * 1000 });
  }

  async get(id: string): Promise<string | null> {
    const entry = this.tickets.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.tickets.delete(id);
      return null;
    }
    return entry.ticket;
  }

  async incrementBy(id: string, delta: number, ttlSeconds: number): Promise<number> {
    // 读、算、写之间没有 await：单线程里这就是原子的，并发的调用一个接一个地加。
    const now = Date.now();
    const entry = this.tickets.get(id);
    const live = entry && entry.expiresAt > now ? entry : undefined;
    const current = live ? Number.parseFloat(live.ticket) : 0;
    // 存的不是数（被写坏了）：当作用完，不覆盖。
    if (!Number.isFinite(current)) return Number.POSITIVE_INFINITY;
    const next = current + delta;
    this.tickets.set(id, { ticket: String(next), expiresAt: live?.expiresAt ?? now + ttlSeconds * 1000 });
    return next;
  }

  async close(): Promise<void> {
    this.tickets.clear();
  }
}

const REDIS_PREFIX = "atlascloud:mcp:upload-ticket:";

export class RedisUploadTicketStore implements UploadTicketStore {
  // 报价记录（generation-confirmation.ts）复用这个带过期的键值存储，只换前缀。
  constructor(
    private readonly client: RedisClientType,
    private readonly prefix: string = REDIS_PREFIX
  ) {}

  async put(id: string, ticket: string, ttlSeconds: number): Promise<void> {
    await this.client.set(`${this.prefix}${id}`, ticket, { EX: Math.max(1, ttlSeconds) });
  }

  async get(id: string): Promise<string | null> {
    return await this.client.get(`${this.prefix}${id}`);
  }

  async incrementBy(id: string, delta: number, ttlSeconds: number): Promise<number> {
    const key = `${this.prefix}${id}`;
    // INCRBYFLOAT 是原子的，多副本并发也不会少记；和 EXPIRE 放进同一个事务。
    const [value] = await this.client.multi().incrByFloat(key, delta).expire(key, Math.max(1, ttlSeconds)).exec();
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }
}

export async function createRedisUploadTicketStore(
  url: string,
  prefix: string = REDIS_PREFIX
): Promise<RedisUploadTicketStore> {
  const client: RedisClientType = createClient({ url });
  client.on("error", (error: Error) => {
    console.error(`Redis key-value store (${prefix}) error: ${error.message}`);
  });
  await client.connect();
  return new RedisUploadTicketStore(client, prefix);
}

export const QUOTE_REDIS_PREFIX = "atlascloud:mcp:quote:";
