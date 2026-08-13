import assert from "node:assert/strict";
import test from "node:test";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyUncertainError,
  InMemoryIdempotencyStore,
  idempotencyFingerprint,
} from "../src/services/idempotency.js";

test("same idempotency key and arguments replay one completed result", async () => {
  const store = new InMemoryIdempotencyStore();
  let calls = 0;
  const operation = async () => ({ predictionId: `pred-${++calls}` });
  const first = await store.execute("user:tool:key", "fingerprint", 60, operation);
  const second = await store.execute("user:tool:key", "fingerprint", 60, operation);
  assert.deepEqual(first, { predictionId: "pred-1" });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("same key with different arguments is rejected", async () => {
  const store = new InMemoryIdempotencyStore();
  await store.execute("user:tool:key", "first", 60, async () => "ok");
  await assert.rejects(
    store.execute("user:tool:key", "different", 60, async () => "duplicate"),
    IdempotencyConflictError
  );
});

test("concurrent duplicate is rejected while the first operation is pending", async () => {
  const store = new InMemoryIdempotencyStore();
  let release: ((value: string) => void) | undefined;
  const first = store.execute(
    "user:tool:key",
    "same",
    60,
    () => new Promise<string>((resolve) => { release = resolve; })
  );
  await assert.rejects(
    store.execute("user:tool:key", "same", 60, async () => "duplicate"),
    IdempotencyInProgressError
  );
  release?.("ok");
  assert.equal(await first, "ok");
});

test("an uncertain first call blocks an unsafe automatic repeat", async () => {
  const store = new InMemoryIdempotencyStore();
  await assert.rejects(
    store.execute("user:tool:key", "same", 60, async () => {
      throw new Error("connection closed after submit");
    }),
    /connection closed/
  );
  await assert.rejects(
    store.execute("user:tool:key", "same", 60, async () => "duplicate"),
    IdempotencyUncertainError
  );
});

test("fingerprints are canonical and ignore the idempotency key itself", () => {
  const left = idempotencyFingerprint({
    idempotency_key: "one",
    nested: { b: 2, a: 1 },
  });
  const right = idempotencyFingerprint({
    nested: { a: 1, b: 2 },
    idempotency_key: "two",
  });
  assert.equal(left, right);
});

test("resolved billable inputs change the idempotency fingerprint", () => {
  const first = idempotencyFingerprint({
    idempotency_key: "f09b00d9-b8d3-48c1-9a4f-47a1f281dcb8",
    type: "Image",
    resolved_model: "provider/model-v1",
    request_body: { model: "provider/model-v1", prompt: "a lighthouse" },
  });
  const changedCatalogResult = idempotencyFingerprint({
    idempotency_key: "f09b00d9-b8d3-48c1-9a4f-47a1f281dcb8",
    type: "Image",
    resolved_model: "provider/model-v2",
    request_body: { model: "provider/model-v2", prompt: "a lighthouse" },
  });
  assert.notEqual(first, changedCatalogResult);
});
