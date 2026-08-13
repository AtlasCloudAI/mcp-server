import { createHash } from "node:crypto";
import { errors, type Adapter, type AdapterFactory, type AdapterPayload } from "oidc-provider";
import { createClient, type RedisClientType } from "redis";

const FALLBACK_TTL_SECONDS = 86400;
const REFRESH_TOKEN_REUSE_COUNT_FIELD = "atlasRefreshTokenReuseCount";
const CONSUME_RECORD_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return 0
end

local ok, payload = pcall(cjson.decode, raw)
if not ok or type(payload) ~= "table" then
  return redis.error_reply("OIDC adapter record is not a JSON object")
end

if payload.consumed ~= nil then
  local consumed_at = tonumber(payload.consumed)
  local now = tonumber(ARGV[1])
  local grace_seconds = tonumber(ARGV[2]) or 0
  local max_attempts = tonumber(ARGV[3]) or 0
  local reuse_count = tonumber(payload.${REFRESH_TOKEN_REUSE_COUNT_FIELD}) or 0
  if not consumed_at
    or not now
    or now < consumed_at
    or now - consumed_at > grace_seconds
    or reuse_count >= max_attempts then
    return -1
  end
  payload.${REFRESH_TOKEN_REUSE_COUNT_FIELD} = reuse_count + 1
else
  payload.consumed = tonumber(ARGV[1])
  payload.${REFRESH_TOKEN_REUSE_COUNT_FIELD} = 0
end

redis.call("SET", KEYS[1], cjson.encode(payload), "KEEPTTL", "XX")
return 1
`;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parsePayload(raw: string | null): AdapterPayload | undefined {
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OIDC adapter record is not a JSON object");
  }
  return parsed as AdapterPayload;
}

export class RedisOidcAdapter implements Adapter {
  constructor(
    private readonly modelName: string,
    private readonly client: RedisClientType,
    private readonly prefix: string,
    private readonly dynamicClientTtlSeconds: number,
    private readonly refreshTokenReuseGraceSeconds: number,
    private readonly refreshTokenReuseMaxAttempts: number,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  private visiblePayload(payload: AdapterPayload | undefined): AdapterPayload | undefined {
    if (
      !payload
      || this.modelName !== "RefreshToken"
      || this.refreshTokenReuseGraceSeconds <= 0
      || this.refreshTokenReuseMaxAttempts <= 0
      || !payload.consumed
    ) return payload;
    const consumedAt = typeof payload.consumed === "number" ? payload.consumed : Number.NaN;
    const reuseCountValue = payload[REFRESH_TOKEN_REUSE_COUNT_FIELD];
    const reuseCount = typeof reuseCountValue === "number" && Number.isSafeInteger(reuseCountValue)
      ? reuseCountValue
      : 0;
    const ageSeconds = this.nowSeconds() - consumedAt;
    const withinGrace = Number.isSafeInteger(consumedAt)
      && ageSeconds >= 0
      && ageSeconds <= this.refreshTokenReuseGraceSeconds;
    if (!withinGrace || reuseCount >= this.refreshTokenReuseMaxAttempts) return payload;

    const visible = { ...payload };
    delete visible.consumed;
    return visible;
  }

  private recordKey(id: string): string {
    return `${this.prefix}:record:${this.modelName}:${digest(id)}`;
  }

  private modelNameFromRecordKey(key: string): string | undefined {
    const recordPrefix = `${this.prefix}:record:`;
    if (!key.startsWith(recordPrefix)) return undefined;
    const suffix = key.slice(recordPrefix.length);
    const separator = suffix.lastIndexOf(":");
    if (separator <= 0 || !/^[a-f0-9]{64}$/.test(suffix.slice(separator + 1))) {
      return undefined;
    }
    return suffix.slice(0, separator);
  }

  private userCodeKey(userCode: string, modelName: string = this.modelName): string {
    return `${this.prefix}:index:user-code:${modelName}:${digest(userCode)}`;
  }

  private uidKey(uid: string, modelName: string = this.modelName): string {
    return `${this.prefix}:index:uid:${modelName}:${digest(uid)}`;
  }

  private grantKey(grantId: string): string {
    return `${this.prefix}:index:grant:${digest(grantId)}`;
  }

  private grantRecordKey(grantId: string): string {
    return `${this.prefix}:record:Grant:${digest(grantId)}`;
  }

  private ttl(expiresIn?: number): number {
    if (expiresIn && Number.isSafeInteger(expiresIn) && expiresIn > 0) return expiresIn;
    return this.modelName === "Client" ? this.dynamicClientTtlSeconds : FALLBACK_TTL_SECONDS;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const key = this.recordKey(id);
    const ttl = this.ttl(expiresIn);
    const previous = parsePayload(await this.client.get(key));
    const transaction = this.client.multi();

    if (previous) {
      if (typeof previous.userCode === "string" && previous.userCode !== payload.userCode) {
        transaction.del(this.userCodeKey(previous.userCode));
      }
      if (typeof previous.uid === "string" && previous.uid !== payload.uid) {
        transaction.del(this.uidKey(previous.uid));
      }
      if (typeof previous.grantId === "string" && previous.grantId !== payload.grantId) {
        transaction.sRem(this.grantKey(previous.grantId), key);
      }
    }

    transaction.set(key, JSON.stringify(payload), { expiration: { type: "EX", value: ttl } });
    if (typeof payload.userCode === "string") {
      transaction.set(this.userCodeKey(payload.userCode), id, {
        expiration: { type: "EX", value: ttl },
      });
    }
    if (typeof payload.uid === "string") {
      transaction.set(this.uidKey(payload.uid), id, {
        expiration: { type: "EX", value: ttl },
      });
    }
    if (typeof payload.grantId === "string") {
      const grantKey = this.grantKey(payload.grantId);
      transaction.sAdd(grantKey, key);
      transaction.expire(grantKey, ttl, "NX");
      transaction.expire(grantKey, ttl, "GT");
    }
    await transaction.exec();
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    return this.visiblePayload(parsePayload(await this.client.get(this.recordKey(id))));
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const id = await this.client.get(this.userCodeKey(userCode));
    return id ? this.find(id) : undefined;
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const id = await this.client.get(this.uidKey(uid));
    return id ? this.find(id) : undefined;
  }

  async consume(id: string): Promise<void> {
    const key = this.recordKey(id);
    const consumed = await this.client.eval(CONSUME_RECORD_SCRIPT, {
      keys: [key],
      arguments: [
        String(this.nowSeconds()),
        String(this.modelName === "RefreshToken" ? this.refreshTokenReuseGraceSeconds : 0),
        String(this.modelName === "RefreshToken" ? this.refreshTokenReuseMaxAttempts : 0),
      ],
    });
    if (consumed === 1) return;

    const payload = parsePayload(await this.client.get(key));
    if (typeof payload?.grantId === "string") {
      await this.revokeByGrantId(payload.grantId);
    }
    const detail = this.modelName === "RefreshToken"
      ? "refresh token already used"
      : "grant source already consumed";
    throw new errors.InvalidGrant(detail);
  }

  async destroy(id: string): Promise<void> {
    const key = this.recordKey(id);
    const payload = parsePayload(await this.client.get(key));
    const transaction = this.client.multi();
    transaction.del(key);
    if (payload) {
      if (typeof payload.userCode === "string") {
        transaction.del(this.userCodeKey(payload.userCode));
      }
      if (typeof payload.uid === "string") {
        transaction.del(this.uidKey(payload.uid));
      }
      if (typeof payload.grantId === "string") {
        transaction.sRem(this.grantKey(payload.grantId), key);
      }
    }
    await transaction.exec();
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    const grantKey = this.grantKey(grantId);
    const recordKeys = await this.client.sMembers(grantKey);
    const records = recordKeys.length > 0 ? await this.client.mGet(recordKeys) : [];
    const transaction = this.client.multi();

    for (let index = 0; index < recordKeys.length; index += 1) {
      const payload = parsePayload(records[index] ?? null);
      const recordKey = recordKeys[index];
      const recordModelName = this.modelNameFromRecordKey(recordKey);
      transaction.del(recordKey);
      if (payload && recordModelName && typeof payload.userCode === "string") {
        transaction.del(this.userCodeKey(payload.userCode, recordModelName));
      }
      if (payload && recordModelName && typeof payload.uid === "string") {
        transaction.del(this.uidKey(payload.uid, recordModelName));
      }
    }
    transaction.del([grantKey, this.grantRecordKey(grantId)]);
    await transaction.exec();
  }
}

export interface RedisOidcStore {
  client: RedisClientType;
  adapter: AdapterFactory;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export async function createRedisOidcStore(
  url: string,
  prefix: string,
  dynamicClientTtlSeconds: number,
  refreshTokenReuseGraceSeconds: number,
  refreshTokenReuseMaxAttempts: number
): Promise<RedisOidcStore> {
  const client: RedisClientType = createClient({ url });
  client.on("error", (error: Error) => {
    console.error(`Redis OIDC adapter error: ${error.message}`);
  });
  await client.connect();

  return {
    client,
    adapter: (name) => new RedisOidcAdapter(
      name,
      client,
      prefix,
      dynamicClientTtlSeconds,
      refreshTokenReuseGraceSeconds,
      refreshTokenReuseMaxAttempts
    ),
    async ready() {
      return (await client.ping()) === "PONG";
    },
    async close() {
      if (client.isOpen) await client.quit();
    },
  };
}
