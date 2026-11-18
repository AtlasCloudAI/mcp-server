// 11-16 security review: M1 (chat auto-run budget), M3 (stdio upload allowlist), A2 (no server key fallback).
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { disableEnvironmentApiKey, getApiKey, uploadMedia } from "../src/services/api-client.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { runWithRequestContext, type AtlasRequestContext } from "../src/services/request-context.js";
import {
  applyDailyAutoSubmitBudget,
  dailyAutoSubmitBudgetUsd,
  type SpendDecision,
} from "../src/services/spend-policy.js";
import { InMemoryUploadTicketStore, type UploadTicketStore } from "../src/services/upload-ticket-store.js";

function withEnv(t: { after(fn: () => void): void }, values: Record<string, string | undefined>): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function context(subject: string, quoteStore: UploadTicketStore): AtlasRequestContext {
  return {
    authInfo: { token: "t", clientId: "c", scopes: [] },
    subject,
    atlasApiKey: "user-key",
    idempotencyStore: new InMemoryIdempotencyStore(),
    idempotencyTtlSeconds: 60,
    generationConfirmationSecret: "test-generation-confirmation-secret-123456",
    generationConfirmationTtlSeconds: 60,
    quoteStore,
  };
}

const cheap: SpendDecision = { autoSubmit: true, quotedUsd: 0.03, thresholdUsd: 1, reason: "quote is below the threshold" };

test("M1: the daily budget defaults to $5 and a malformed value closes it", (t) => {
  withEnv(t, { MCP_AUTOSUBMIT_DAILY_MAX_USD: undefined });
  assert.equal(dailyAutoSubmitBudgetUsd(), 5);
  process.env.MCP_AUTOSUBMIT_DAILY_MAX_USD = "abc";
  assert.equal(dailyAutoSubmitBudgetUsd(), 0);
});

test("M1: requests under the per-request limit stop once the user's daily auto-run budget is used", async (t) => {
  withEnv(t, { MCP_AUTOSUBMIT_DAILY_MAX_USD: "0.05" });
  const store = new InMemoryUploadTicketStore();
  await runWithRequestContext(context("user-a", store), async () => {
    // 放行时已经按最坏情况预占了 0.03（11-18 审查 M6），不用等跑完再记。
    assert.equal((await applyDailyAutoSubmitBudget(cheap)).autoSubmit, true);
    const second = await applyDailyAutoSubmitBudget(cheap);
    assert.equal(second.autoSubmit, false);
    assert.deepEqual(second.dailyBudget, { budgetUsd: 0.05, usedUsd: 0.03 });
  });
  // Another user's budget is separate.
  await runWithRequestContext(context("user-b", store), async () => {
    assert.equal((await applyDailyAutoSubmitBudget(cheap)).autoSubmit, true);
  });
});

test("M1: a budget store that cannot be read means confirm, not run", async () => {
  const broken: UploadTicketStore = {
    put: async () => {
      throw new Error("down");
    },
    get: async () => {
      throw new Error("down");
    },
    close: async () => undefined,
  };
  await runWithRequestContext(context("user-c", broken), async () => {
    assert.equal((await applyDailyAutoSubmitBudget(cheap)).autoSubmit, false);
  });
});

test("M1: decisions that already need confirmation are left alone", async () => {
  const stop: SpendDecision = { autoSubmit: false, quotedUsd: 3, thresholdUsd: 1, reason: "worst-case cost is at or above the threshold" };
  assert.equal(await applyDailyAutoSubmitBudget(stop), stop);
});

test("M3: local upload refuses dotfiles, non-media extensions and non-media contents", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atlas-upload-")));
  writeFileSync(join(root, ".env"), "ATLASCLOUD_API_KEY=secret\n");
  writeFileSync(join(root, "notes.txt"), "secret\n");
  writeFileSync(join(root, "renamed.png"), "ATLASCLOUD_API_KEY=secret\n");
  withEnv(t, { ATLASCLOUD_UPLOAD_ROOTS: root, ATLASCLOUD_API_KEY: "test-key" });
  await assert.rejects(uploadMedia(join(root, ".env")), /Only image, video, audio and GLB/);
  await assert.rejects(uploadMedia(join(root, "notes.txt")), /Only image, video, audio and GLB/);
  await assert.rejects(uploadMedia(join(root, "renamed.png")), /not a recognised image/);
});

test("A2: once the remote server disables it, no request context means no credential", (t) => {
  withEnv(t, { ATLASCLOUD_API_KEY: "server-key" });
  assert.equal(getApiKey(), "server-key"); // stdio behaviour
  disableEnvironmentApiKey();
  assert.throws(() => getApiKey(), /No Atlas Cloud credential/);
  const store = new InMemoryUploadTicketStore();
  assert.equal(runWithRequestContext(context("user-d", store), () => getApiKey()), "user-key");
});
