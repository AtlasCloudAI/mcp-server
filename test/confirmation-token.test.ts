import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  issueGenerationConfirmation,
  verifyGenerationConfirmation,
} from "../src/services/generation-confirmation.js";
import { idempotencyFingerprint } from "../src/services/idempotency.js";
import type { ModelPrice } from "../src/types.js";

const KEY = "11111111-2222-4333-8444-555555555555";
const PRICE = { actual: { base_price: "0.03" } } as unknown as ModelPrice;
const REQUEST = { model: "m", prompt: "make the horse grey", images: ["https://x/y.png"] };

test("确认令牌足够短，模型回传时不易抄错", (t) => {
  t.after(() => delete process.env.MCP_GENERATION_CONFIRMATION_SECRET);
  process.env.MCP_GENERATION_CONFIRMATION_SECRET = "s".repeat(40);
  const { confirmationToken } = issueGenerationConfirmation("atlas_quick_generate", KEY, REQUEST, PRICE);
  // 旧格式约 570 个字符，2026-10-19 实测模型抄丢过一个字符。
  assert.ok(confirmationToken.length < 60, `length ${confirmationToken.length}`);
  verifyGenerationConfirmation(confirmationToken, "atlas_quick_generate", KEY, REQUEST, PRICE);
});

test("抄丢一个字符、改了参数、换了工具都会被拒，且不提交", (t) => {
  t.after(() => delete process.env.MCP_GENERATION_CONFIRMATION_SECRET);
  process.env.MCP_GENERATION_CONFIRMATION_SECRET = "s".repeat(40);
  const { confirmationToken } = issueGenerationConfirmation("atlas_generate_image", KEY, REQUEST, PRICE);
  const dropped = confirmationToken.slice(0, -5) + confirmationToken.slice(-4);
  assert.throws(
    () => verifyGenerationConfirmation(dropped, "atlas_generate_image", KEY, REQUEST, PRICE),
    /does not match this request|invalid/
  );
  assert.throws(
    () => verifyGenerationConfirmation(confirmationToken, "atlas_generate_image", KEY, { ...REQUEST, prompt: "x" }, PRICE),
    /does not match this request/
  );
  assert.throws(
    () => verifyGenerationConfirmation(confirmationToken, "atlas_generate_video", KEY, REQUEST, PRICE),
    /does not match this request/
  );
  const otherPrice = { actual: { base_price: "0.05" } } as unknown as ModelPrice;
  assert.throws(
    () => verifyGenerationConfirmation(confirmationToken, "atlas_generate_image", KEY, REQUEST, otherPrice),
    /does not match this request/
  );
});

test("过期的令牌被拒", (t) => {
  t.after(() => delete process.env.MCP_GENERATION_CONFIRMATION_SECRET);
  process.env.MCP_GENERATION_CONFIRMATION_SECRET = "s".repeat(40);
  const realNow = Date.now;
  const { confirmationToken } = issueGenerationConfirmation("atlas_generate_image", KEY, REQUEST, PRICE);
  Date.now = () => realNow() + 3600_000;
  t.after(() => {
    Date.now = realNow;
  });
  assert.throws(
    () => verifyGenerationConfirmation(confirmationToken, "atlas_generate_image", KEY, REQUEST, PRICE),
    /expired/
  );
});

test("部署前签发的旧格式令牌在过期前仍然有效", (t) => {
  t.after(() => delete process.env.MCP_GENERATION_CONFIRMATION_SECRET);
  const secret = "s".repeat(40);
  process.env.MCP_GENERATION_CONFIRMATION_SECRET = secret;
  const pricing = { actual: { base_price: "0.03" } };
  const payload = {
    version: 1,
    subject_hash: createHash("sha256").update("stdio").digest("hex"),
    tool_name: "atlas_generate_image",
    idempotency_key: KEY,
    request_fingerprint: idempotencyFingerprint(REQUEST),
    pricing_fingerprint: idempotencyFingerprint({ pricing }),
    expires_at: Date.now() + 600_000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const legacy = `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
  verifyGenerationConfirmation(legacy, "atlas_generate_image", KEY, REQUEST, PRICE);
});
