import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RedisClientType } from "redis";
import type { HttpServerConfig } from "../src/config.js";
import { ConfiguredCredentialResolver, CredentialResolutionError } from "../src/services/credential-resolver.js";
import type { CredentialEncryptionKey } from "../src/services/credential-envelope.js";
import {
  LINKED_CREDENTIAL_TTL_SECONDS,
  RedisLinkedAtlasCredentialStore,
} from "../src/services/linked-credential-store.js";

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttlSeconds = new Map<string, number>();
  isOpen = true;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { EX?: number }): Promise<string> {
    this.values.set(key, value);
    if (options?.EX) this.ttlSeconds.set(key, options.EX);
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async quit(): Promise<string> {
    this.isOpen = false;
    return "OK";
  }
}

function authInfo(subject: string): AuthInfo {
  return {
    token: "validated-token",
    clientId: "chatgpt-client",
    scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    extra: { sub: subject },
  };
}

test("Redis linked credentials store only subject hashes and encrypted values", async () => {
  const fake = new FakeRedis();
  const keys: CredentialEncryptionKey[] = [
    { kid: "primary-2026-08", key: randomBytes(32) },
    { kid: "previous-2026-07", key: randomBytes(32) },
  ];
  const store = new RedisLinkedAtlasCredentialStore(
    fake as unknown as RedisClientType,
    "test:credential",
    keys
  );
  await store.put("oauth-subject-a", "atlas-secret-api-key");

  const [[recordKey, recordValue]] = [...fake.values.entries()];
  assert.equal(recordKey.includes("oauth-subject-a"), false);
  assert.equal(recordValue.includes("atlas-secret-api-key"), false);
  assert.equal(fake.ttlSeconds.get(recordKey), LINKED_CREDENTIAL_TTL_SECONDS);
  assert.equal(await store.get("oauth-subject-a"), "atlas-secret-api-key");
  assert.equal(await store.get("missing-subject"), undefined);
  assert.equal(await store.ready(), true);

  await store.delete("oauth-subject-a");
  assert.equal(await store.get("oauth-subject-a"), undefined);
});

test("Redis linked credential tampering fails closed", async () => {
  const fake = new FakeRedis();
  const keys: CredentialEncryptionKey[] = [{ kid: "primary-2026-08", key: randomBytes(32) }];
  const store = new RedisLinkedAtlasCredentialStore(
    fake as unknown as RedisClientType,
    "test:credential",
    keys
  );
  await store.put("oauth-subject-a", "atlas-secret-api-key");
  const [recordKey] = fake.values.keys();
  fake.values.set(recordKey, `${fake.values.get(recordKey)}tampered`);
  await assert.rejects(() => store.get("oauth-subject-a"), /decrypt Atlas credential/);
});

test("configured resolver reads the authenticated subject from the encrypted store", async () => {
  const fake = new FakeRedis();
  const keys: CredentialEncryptionKey[] = [{ kid: "primary-2026-08", key: randomBytes(32) }];
  const store = new RedisLinkedAtlasCredentialStore(
    fake as unknown as RedisClientType,
    "test:credential",
    keys
  );
  const config = {
    credentialMode: "redis-subject-map",
    credentialEncryptionKeys: keys,
  } as HttpServerConfig;
  const resolver = new ConfiguredCredentialResolver(config, store);
  await store.put("oauth-subject-a", "atlas-secret-api-key");

  assert.deepEqual(await resolver.resolve(authInfo("oauth-subject-a")), {
    subject: "oauth-subject-a",
    apiKey: "atlas-secret-api-key",
  });
  await assert.rejects(
    () => resolver.resolve(authInfo("missing-subject")),
    CredentialResolutionError
  );
});
