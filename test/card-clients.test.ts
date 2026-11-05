// 问题 58：认不出、但显示过卡片的客户端（Cursor）不该再被引导去 curl 下载结果。
import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { isKnownCardClient, rememberCardClient } from "../src/services/card-clients.js";
import { currentClientProfile } from "../src/services/client-profile.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { runWithRequestContext } from "../src/services/request-context.js";
import { InMemoryUploadTicketStore } from "../src/services/upload-ticket-store.js";

const CURSOR_DCR_CLIENT = "3f2c9a1e-dcr-cursor";

function withClient<T>(
  clientId: string,
  extra: { quoteStore?: InMemoryUploadTicketStore; knownCardClient?: boolean },
  operation: () => Promise<T> | T
): Promise<T> | T {
  return runWithRequestContext(
    {
      authInfo: { token: "t", clientId, scopes: ["tasks:read"] } as AuthInfo,
      subject: "card-client-user",
      atlasApiKey: "not-used",
      idempotencyStore: new InMemoryIdempotencyStore(),
      idempotencyTtlSeconds: 600,
      generationConfirmationSecret: "test-confirmation-secret-that-is-long-enough",
      generationConfirmationTtlSeconds: 600,
      ...extra,
    },
    operation
  );
}

test("卡片调过卡片专用工具后，同一个 OAuth 客户端被认作会显示卡片", async () => {
  const store = new InMemoryUploadTicketStore();
  assert.equal(await isKnownCardClient(CURSOR_DCR_CLIENT, store), false);
  await withClient(CURSOR_DCR_CLIENT, { quoteStore: store }, () => rememberCardClient());
  assert.equal(await isKnownCardClient(CURSOR_DCR_CLIENT, store), true);
  // 别的客户端不受影响
  assert.equal(await isKnownCardClient("another-dcr-client", store), false);
  // 没有存储、没有客户端编号：当成认不出
  assert.equal(await isKnownCardClient(CURSOR_DCR_CLIENT, undefined), false);
  assert.equal(await isKnownCardClient(undefined, store), false);
});

test("显示过卡片的自行注册客户端按聊天类客户端给结果指引；认得出的客户端不变", () => {
  assert.equal(withClient(CURSOR_DCR_CLIENT, {}, () => currentClientProfile()), "other");
  assert.equal(withClient(CURSOR_DCR_CLIENT, { knownCardClient: true }, () => currentClientProfile()), "chat");
  // Claude Code 是 shell，不会因为这个标记变成 chat
  assert.equal(
    withClient("https://claude.ai/oauth/claude-code-client-metadata", { knownCardClient: true }, () => currentClientProfile()),
    "shell"
  );
});
