import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlockedAddress } from "../src/services/input-link-check.js";
import { mayHaveStarted } from "../src/services/not-started.js";
import { RedisIdempotencyStore } from "../src/services/idempotency.js";
import { handleError } from "../src/utils/error-handler.js";
import { UnconfirmedRequestError, IdempotencyInProgressError } from "../src/services/idempotency.js";

// 11-16 review：URL 会把 [::ffff:127.0.0.1] 规范成 ::ffff:7f00:1，旧的正则只认点分写法。
test("IPv6 forms that embed a private IPv4 are blocked", () => {
  for (const ip of [
    "::ffff:7f00:1", // 127.0.0.1
    "::ffff:a9fe:a9fe", // 169.254.169.254
    "::ffff:6464:64c8", // 100.100.100.200
    "::ffff:a00:1", // 10.0.0.1
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:127.0.0.1",
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:a9fe:a9fe::1",
    "0:0:0:0:0:0:0:1",
    "::",
    "fc00::1",
    "FE80::1",
    "ff02::1",
    "fe80::1%eth0",
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1", "2606:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("errors that may have reached the platform are not recorded as not started", () => {
  assert.equal(mayHaveStarted(handleError(new UnconfirmedRequestError(new Error("timeout")))), true);
  assert.equal(mayHaveStarted(handleError(new IdempotencyInProgressError())), true);
  assert.equal(
    mayHaveStarted(
      "Error: A previous request with this idempotency key ended without a confirmed response; check predictions or billing before starting a new request"
    ),
    true
  );
  assert.equal(
    mayHaveStarted("The Atlas Cloud API accepted the video request but did not return a prediction ID. No automatic retry was attempted."),
    true
  );
  assert.equal(mayHaveStarted("Error: Insufficient balance. Please top up your account at: https://x"), false);
  assert.equal(mayHaveStarted("Error: Resource not found. Please check your parameters."), false);
});

// 提交成功后 Redis 写回失败：要返回提交结果，不能当成提交失败抛出去（会让人再交一单）。
test("a failed completed-record write still returns the submission result", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    async set(_key: string, _value: string, options: Record<string, unknown>) {
      calls.push(options);
      if (options.NX) return "OK";
      throw new Error("redis went away");
    },
    async get() {
      return null;
    },
  };
  const store = new RedisIdempotencyStore(client as never);
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const result = await store.execute("k", "fp", 60, async () => ({ id: "pred_1" }));
    assert.deepEqual(result, { id: "pred_1" });
  } finally {
    console.error = originalError;
  }
  assert.equal(calls.length, 2);
});

// 只完整探前 8 条：第 9 条、嵌得更深的内网地址也要挡下，不然放在后面就绕过去了。
test("private addresses past the probe limit are still rejected", async () => {
  const { checkInputLinks } = await import("../src/services/input-link-check.js");
  const images = Array.from({ length: 8 }, (_, i) => `https://cdn${i}.example.invalid/${i}.jpg`);
  const problems = await checkInputLinks({
    images: [...images, "http://[::ffff:a9fe:a9fe]/latest/meta-data/"],
    nested: { a: { b: { c: { d: { url: "http://127.0.0.1:8080/x.png" } } } } },
  });
  assert.deepEqual(
    problems.map((p) => p.url).sort(),
    ["http://127.0.0.1:8080/x.png", "http://[::ffff:a9fe:a9fe]/latest/meta-data/"].sort()
  );
  assert.ok(problems.every((p) => /private or local address/.test(p.reason)));
});
