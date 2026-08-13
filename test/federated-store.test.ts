import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { RedisClientType } from "redis";
import { RedisFederatedIdentityStore } from "../src/auth/federated-store.js";
import { LINKED_CREDENTIAL_TTL_SECONDS } from "../src/services/linked-credential-store.js";

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttlSeconds = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async getDel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: boolean; EX?: number }
  ): Promise<string | null> {
    if (options?.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    if (options?.EX !== undefined) this.ttlSeconds.set(key, options.EX);
    return "OK";
  }
}

test("federated OIDC state and credential-link tickets are hashed and one-time", async () => {
  const fake = new FakeRedis();
  const store = new RedisFederatedIdentityStore(
    fake as unknown as RedisClientType,
    "test:oidc"
  );
  const state = randomBytes(32).toString("base64url");
  const ticket = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");

  await store.beginUpstreamAuthorization(state, {
    interactionUid: "interaction-1",
    nonce,
    codeVerifier,
  }, 600);
  assert.equal([...fake.values.keys()].some((key) => key.includes(state)), false);
  assert.deepEqual(await store.consumeUpstreamAuthorization(state), {
    interactionUid: "interaction-1",
    nonce,
    codeVerifier,
  });
  assert.equal(await store.consumeUpstreamAuthorization(state), undefined);

  await store.beginCredentialLink(ticket, {
    interactionUid: "interaction-1",
    subject: "oidc-subject-1",
  }, 600);
  assert.equal([...fake.values.keys()].some((key) => key.includes(ticket)), false);
  assert.deepEqual(await store.getCredentialLink(ticket), {
    interactionUid: "interaction-1",
    subject: "oidc-subject-1",
  });
  assert.deepEqual(await store.consumeCredentialLink(ticket), {
    interactionUid: "interaction-1",
    subject: "oidc-subject-1",
  });
  assert.equal(await store.consumeCredentialLink(ticket), undefined);
});

test("federated accounts are schema-validated and indexed by a subject hash", async () => {
  const fake = new FakeRedis();
  const store = new RedisFederatedIdentityStore(
    fake as unknown as RedisClientType,
    "test:oidc"
  );
  await store.putAccount({
    sub: "oidc-subject-1",
    email: "person@example.com",
    name: "Example Person",
  });
  const accountKey = [...fake.values.keys()].find((key) => key.includes(":federated-account:"));
  assert.ok(accountKey);
  assert.equal(accountKey.includes("oidc-subject-1"), false);
  assert.equal(fake.ttlSeconds.get(accountKey), LINKED_CREDENTIAL_TTL_SECONDS);
  assert.deepEqual(await store.getAccount("oidc-subject-1"), {
    sub: "oidc-subject-1",
    email: "person@example.com",
    name: "Example Person",
  });
});
