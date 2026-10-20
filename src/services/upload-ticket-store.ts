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
