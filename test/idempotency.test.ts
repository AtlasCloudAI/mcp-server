import assert from "node:assert/strict";
import test from "node:test";
import { ApiRequestError } from "../src/services/api-client.js";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRejectedError,
  IdempotencyUncertainError,
  InMemoryIdempotencyStore,
  UnconfirmedRequestError,
  executeIdempotently,
  idempotencyFingerprint,
  peekIdempotent,
} from "../src/services/idempotency.js";
import { handleError } from "../src/utils/error-handler.js";

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

test("a definitive upstream rejection is remembered as rejected, not uncertain", async () => {
  const store = new InMemoryIdempotencyStore();
  await assert.rejects(
    store.execute("user:tool:key", "same", 60, async () => {
      throw new ApiRequestError("model router not found", 400);
    }),
    ApiRequestError
  );
  assert.equal((await store.peek("user:tool:key"))?.state, "rejected");
  await assert.rejects(
    store.execute("user:tool:key", "same", 60, async () => "duplicate"),
    IdempotencyRejectedError
  );
});

test("timeouts, network errors and 5xx stay uncertain", async () => {
  for (const error of [new ApiRequestError("bad gateway", 502), new ApiRequestError("timeout", 408), new Error("fetch failed")]) {
    const store = new InMemoryIdempotencyStore();
    await assert.rejects(store.execute("user:tool:key", "same", 60, async () => {
      throw error;
    }));
    assert.equal((await store.peek("user:tool:key"))?.state, "uncertain");
  }
});

test("peek reads a record without reserving the key", async () => {
  const store = new InMemoryIdempotencyStore();
  assert.equal(await store.peek("user:tool:key"), undefined);
  await store.execute("user:tool:key", "same", 60, async () => ({ predictionId: "pred-1" }));
  const record = await store.peek("user:tool:key");
  assert.equal(record?.state, "completed");
  assert.deepEqual(record?.state === "completed" ? record.result : undefined, { predictionId: "pred-1" });
});

test("an unconfirmed write says so instead of telling the caller to retry", async () => {
  const key = "7d0c4f62-2a7e-4d8e-9a39-0d7c4f9b1a11";
  const timeout = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  const error = await executeIdempotently("atlas_generate_image", { prompt: "a" }, key, async () => {
    throw timeout;
  }).catch((caught: unknown) => caught);
  assert.ok(error instanceof UnconfirmedRequestError);
  const text = handleError(error);
  assert.match(text, /without a confirmed response/);
  assert.doesNotMatch(text, /try again/i);
  assert.ok(text.indexOf("without a confirmed response") < 240);
  assert.equal((await peekIdempotent("atlas_generate_image", key))?.state, "uncertain");

  // 明确拒收原样抛出，照旧报余额不足等原因。
  const rejected = await executeIdempotently("atlas_generate_image", { prompt: "b" }, "8d0c4f62-2a7e-4d8e-9a39-0d7c4f9b1a11", async () => {
    throw new ApiRequestError("insufficient balance", 402);
  }).catch((caught: unknown) => caught);
  assert.ok(rejected instanceof ApiRequestError);
  assert.match(handleError(rejected), /Insufficient balance/);

  // 本地就失败的（文件读不到）没发出去，照旧报原因，不说「可能已经提交」。
  const local = await executeIdempotently("atlas_upload_media", { file_path: "/nope" }, "9d0c4f62-2a7e-4d8e-9a39-0d7c4f9b1a11", async () => {
    throw new Error("ENOENT: no such file or directory");
  }).catch((caught: unknown) => caught);
  assert.ok(!(local instanceof UnconfirmedRequestError));
  assert.doesNotMatch(handleError(local), /confirmed response/);
});
