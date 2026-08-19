import assert from "node:assert/strict";
import test from "node:test";
import { ensureConsentCredential } from "../src/auth/app.js";
import type { AuthorizationServerConfig } from "../src/auth/config.js";

// 回归背景：auth 会话仍在（oidc-provider 直接给 consent 交互），但服务端凭据已被
// 清空/过期。旧实现只在 /upstream/callback 里做自动换取与手贴兜底，consent 路径
// 两者都绕过，签出的 token 在资源侧永远 account_not_linked。

const config = {
  upstream: { issuer: new URL("https://accounts.google.com") },
} as unknown as AuthorizationServerConfig;

function fakeRuntime(overrides: {
  stored?: string;
  account?: { sub: string; email: string; name: string; upstreamSubject?: string } | undefined;
  exchange?: (req: { issuer: string; subject: string }) => Promise<string | undefined>;
  validate?: (key: string) => Promise<void>;
  noExchange?: boolean;
}) {
  const calls: string[] = [];
  const store = new Map<string, string>();
  if (overrides.stored) store.set("sub-1", overrides.stored);
  const runtime = {
    credentialStore: {
      get: async (subject: string) => store.get(subject),
      put: async (subject: string, key: string) => {
        calls.push(`put:${subject}`);
        store.set(subject, key);
      },
    },
    federatedStore: {
      getAccount: async () => overrides.account,
    },
    upstreamClient: {},
    validateAtlasCredential: async (key: string) => {
      calls.push("validate");
      await (overrides.validate ?? (async () => {}))(key);
    },
    credentialExchange: overrides.noExchange
      ? undefined
      : {
          exchange: async (req: { issuer: string; subject: string }) => {
            calls.push(`exchange:${req.issuer}:${req.subject}`);
            return (overrides.exchange ?? (async () => "apikey-minted"))(req);
          },
        },
  };
  return { runtime: runtime as never, calls, store };
}

const events: string[] = [];
const audit = (event: { event: string; outcome?: string }) => {
  events.push(`${event.event}:${event.outcome}`);
};

test("consent keeps an existing credential untouched", async () => {
  const { runtime, calls } = fakeRuntime({ stored: "apikey-old" });
  assert.equal(await ensureConsentCredential(runtime, config, audit, "sub-1"), "present");
  assert.deepEqual(calls, []);
});

test("consent re-runs the exchange when the credential was wiped", async () => {
  events.length = 0;
  const { runtime, calls, store } = fakeRuntime({
    account: { sub: "sub-1", email: "u@example.com", name: "U", upstreamSubject: "google-sub-9" },
  });
  assert.equal(await ensureConsentCredential(runtime, config, audit, "sub-1"), "linked");
  // issuer 去尾斜杠 + 原始上游 sub；换来的 key 先校验后入库。
  assert.deepEqual(calls, [
    "exchange:https://accounts.google.com:google-sub-9",
    "validate",
    "put:sub-1",
  ]);
  assert.equal(store.get("sub-1"), "apikey-minted");
  assert.deepEqual(events, ["federated_credential_exchange:linked"]);
});

test("consent falls back to the manual form when no Atlas account matches", async () => {
  events.length = 0;
  const { runtime, store } = fakeRuntime({
    account: { sub: "sub-1", email: "u@example.com", name: "U", upstreamSubject: "google-sub-9" },
    exchange: async () => undefined,
  });
  assert.equal(await ensureConsentCredential(runtime, config, audit, "sub-1"), "link");
  assert.equal(store.get("sub-1"), undefined);
  assert.deepEqual(events, ["federated_credential_exchange:no_account"]);
});

test("consent falls back on exchange or validation failure without storing anything", async () => {
  events.length = 0;
  const failing = fakeRuntime({
    account: { sub: "sub-1", email: "u@example.com", name: "U", upstreamSubject: "google-sub-9" },
    exchange: async () => {
      throw new Error("backend down");
    },
  });
  assert.equal(await ensureConsentCredential(failing.runtime, config, audit, "sub-1"), "link");
  assert.equal(failing.store.get("sub-1"), undefined);

  const badKey = fakeRuntime({
    account: { sub: "sub-1", email: "u@example.com", name: "U", upstreamSubject: "google-sub-9" },
    validate: async () => {
      throw new Error("key rejected");
    },
  });
  assert.equal(await ensureConsentCredential(badKey.runtime, config, audit, "sub-1"), "link");
  assert.equal(badKey.store.get("sub-1"), undefined, "校验失败的 key 不得入库");
  assert.deepEqual(events, [
    "federated_credential_exchange:error",
    "federated_credential_exchange:error",
  ]);
});

test("consent skips the exchange entirely when the account record or exchange is absent", async () => {
  const gone = fakeRuntime({ account: undefined });
  assert.equal(await ensureConsentCredential(gone.runtime, config, audit, "sub-1"), "link");
  assert.deepEqual(gone.calls, []);

  const unconfigured = fakeRuntime({
    account: { sub: "sub-1", email: "u@example.com", name: "U", upstreamSubject: "google-sub-9" },
    noExchange: true,
  });
  assert.equal(await ensureConsentCredential(unconfigured.runtime, config, audit, "sub-1"), "link");
  assert.deepEqual(unconfigured.calls, []);
});
