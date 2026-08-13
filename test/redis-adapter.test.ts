import assert from "node:assert/strict";
import test from "node:test";
import type { RedisClientType } from "redis";
import { RedisOidcAdapter } from "../src/auth/redis-adapter.js";

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    this.values.set(key, value);
    return "OK";
  }

  async mGet(keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => this.values.get(key) ?? null);
  }

  async sMembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async eval(
    _script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<number> {
    const key = options.keys[0];
    const raw = key ? this.values.get(key) : undefined;
    if (!key || !raw) return 0;
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (payload.consumed !== undefined) {
      const now = Number(options.arguments[0]);
      const consumedAt = Number(payload.consumed);
      const graceSeconds = Number(options.arguments[1]);
      const maxAttempts = Number(options.arguments[2]);
      const reuseCount = typeof payload.atlasRefreshTokenReuseCount === "number"
        ? payload.atlasRefreshTokenReuseCount
        : 0;
      if (
        !Number.isFinite(consumedAt)
        || !Number.isFinite(now)
        || now < consumedAt
        || now - consumedAt > graceSeconds
        || reuseCount >= maxAttempts
      ) return -1;
      payload.atlasRefreshTokenReuseCount = reuseCount + 1;
    } else {
      payload.consumed = Number(options.arguments[0]);
      payload.atlasRefreshTokenReuseCount = 0;
    }
    this.values.set(key, JSON.stringify(payload));
    return 1;
  }

  multi() {
    const commands: Array<() => void> = [];
    const transaction = {
      del: (keys: string | string[]) => {
        commands.push(() => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            this.values.delete(key);
            this.sets.delete(key);
          }
        });
        return transaction;
      },
      set: (key: string, value: string) => {
        commands.push(() => this.values.set(key, value));
        return transaction;
      },
      sAdd: (key: string, value: string) => {
        commands.push(() => {
          const members = this.sets.get(key) ?? new Set<string>();
          members.add(value);
          this.sets.set(key, members);
        });
        return transaction;
      },
      sRem: (key: string, value: string) => {
        commands.push(() => this.sets.get(key)?.delete(value));
        return transaction;
      },
      expire: () => transaction,
      exec: async () => {
        for (const command of commands) command();
        return [];
      },
    };
    return transaction;
  }
}

test("grant revocation removes records and secondary indexes across OIDC models", async () => {
  const fake = new FakeRedis();
  const client = fake as unknown as RedisClientType;
  const prefix = "test:oidc";
  const codeAdapter = new RedisOidcAdapter("AuthorizationCode", client, prefix, 86400, 0, 0);
  const interactionAdapter = new RedisOidcAdapter("Interaction", client, prefix, 86400, 0, 0);
  const grantAdapter = new RedisOidcAdapter("Grant", client, prefix, 86400, 0, 0);

  await codeAdapter.upsert("authorization-code-id", {
    grantId: "shared-grant",
    uid: "authorization-code-uid",
    userCode: "authorization-code-user-code",
  }, 300);
  await interactionAdapter.upsert("interaction-id", {
    grantId: "shared-grant",
    uid: "interaction-uid",
    userCode: "interaction-user-code",
  }, 300);
  await grantAdapter.upsert("shared-grant", { accountId: "account-a", clientId: "client-a" }, 300);

  assert.ok(await codeAdapter.findByUid("authorization-code-uid"));
  assert.ok(await interactionAdapter.findByUid("interaction-uid"));
  assert.ok([...fake.values.keys()].some((key) => key.includes(":index:uid:Interaction:")));

  await codeAdapter.revokeByGrantId("shared-grant");

  assert.equal(await codeAdapter.find("authorization-code-id"), undefined);
  assert.equal(await interactionAdapter.find("interaction-id"), undefined);
  assert.equal(await grantAdapter.find("shared-grant"), undefined);
  assert.equal(
    [...fake.values.keys()].some((key) => key.includes(":index:uid:") || key.includes(":index:user-code:")),
    false
  );
  assert.equal(fake.sets.size, 0);
});

test("refresh-token retries are bounded by an atomic fixed grace window", async () => {
  const fake = new FakeRedis();
  const client = fake as unknown as RedisClientType;
  let now = 1_700_000_000;
  const adapter = new RedisOidcAdapter(
    "RefreshToken",
    client,
    "test:oidc",
    86400,
    30,
    2,
    () => now
  );
  const strictObserver = new RedisOidcAdapter(
    "RefreshToken",
    client,
    "test:oidc",
    86400,
    0,
    0,
    () => now
  );
  const grantAdapter = new RedisOidcAdapter("Grant", client, "test:oidc", 86400, 0, 0);

  await grantAdapter.upsert("grant-a", { accountId: "account-a", clientId: "client-a" }, 3600);
  await adapter.upsert("refresh-token-id", { clientId: "client-a", grantId: "grant-a" }, 3600);
  await adapter.consume("refresh-token-id");
  assert.equal((await adapter.find("refresh-token-id"))?.consumed, undefined);
  assert.equal((await strictObserver.find("refresh-token-id"))?.consumed, now);

  now += 1;
  await adapter.consume("refresh-token-id");
  const afterFirstRetry = await strictObserver.find("refresh-token-id");
  assert.equal(afterFirstRetry?.consumed, 1_700_000_000);
  assert.equal(afterFirstRetry?.atlasRefreshTokenReuseCount, 1);
  assert.equal((await adapter.find("refresh-token-id"))?.consumed, undefined);

  await adapter.consume("refresh-token-id");
  const exhausted = await adapter.find("refresh-token-id");
  assert.equal(exhausted?.consumed, 1_700_000_000);
  assert.equal(exhausted?.atlasRefreshTokenReuseCount, 2);
  await assert.rejects(
    () => adapter.consume("refresh-token-id"),
    (error: unknown) =>
      error instanceof Error
      && "error" in error
      && error.error === "invalid_grant"
  );
  assert.equal(await adapter.find("refresh-token-id"), undefined);
  assert.equal(await grantAdapter.find("grant-a"), undefined);

  await adapter.upsert("expired-retry-token", {
    clientId: "client-a",
    consumed: now - 31,
    atlasRefreshTokenReuseCount: 0,
  }, 3600);
  assert.equal((await adapter.find("expired-retry-token"))?.consumed, now - 31);
});
