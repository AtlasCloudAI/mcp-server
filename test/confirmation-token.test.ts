import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  issueGenerationConfirmation,
  resolveConfirmedIdempotencyKey,
  verifyGenerationConfirmation,
} from "../src/services/generation-confirmation.js";
import { idempotencyFingerprint } from "../src/services/idempotency.js";
import type { ModelPrice } from "../src/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { runWithRequestContext } from "../src/services/request-context.js";
import type { UploadTicketStore } from "../src/services/upload-ticket-store.js";

const KEY = "11111111-2222-4333-8444-555555555555";
const PRICE = { actual: { base_price: "0.03" } } as unknown as ModelPrice;
const REQUEST = { model: "m", prompt: "make the horse grey", images: ["https://x/y.png"] };

test("确认令牌足够短，模型回传时不易抄错", async (t) => {
  t.after(() => delete process.env.MCP_GENERATION_CONFIRMATION_SECRET);
  process.env.MCP_GENERATION_CONFIRMATION_SECRET = "s".repeat(40);
  const { confirmationToken } = await issueGenerationConfirmation("atlas_quick_generate", KEY, REQUEST, PRICE);
  // 旧格式约 570 个字符，2026-10-19 实测模型抄丢过一个字符。
  assert.ok(confirmationToken.length < 60, `length ${confirmationToken.length}`);
  verifyGenerationConfirmation(confirmationToken, "atlas_quick_generate", KEY, REQUEST, PRICE);
});

test("抄丢一个字符、改了参数、换了工具都会被拒，且不提交", async (t) => {
  t.after(() => delete process.env.MCP_GENERATION_CONFIRMATION_SECRET);
  process.env.MCP_GENERATION_CONFIRMATION_SECRET = "s".repeat(40);
  const { confirmationToken } = await issueGenerationConfirmation("atlas_generate_image", KEY, REQUEST, PRICE);
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

test("过期的令牌被拒", async (t) => {
  t.after(() => delete process.env.MCP_GENERATION_CONFIRMATION_SECRET);
  process.env.MCP_GENERATION_CONFIRMATION_SECRET = "s".repeat(40);
  const realNow = Date.now;
  const { confirmationToken } = await issueGenerationConfirmation("atlas_generate_image", KEY, REQUEST, PRICE);
  Date.now = () => realNow() + 3600_000;
  t.after(() => {
    Date.now = realNow;
  });
  assert.throws(
    () => verifyGenerationConfirmation(confirmationToken, "atlas_generate_image", KEY, REQUEST, PRICE),
    /expired/
  );
});

test("部署前签发的旧格式令牌在过期前仍然有效", async (t) => {
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

test("签发报价时把幂等键一并返回，模型没记住也能从报价里读到", async () => {
  const quote = await issueGenerationConfirmation("atlas_generate_image", KEY, REQUEST, PRICE);
  assert.equal(quote.idempotencyKey, KEY);
});

test("令牌抄错或幂等键丢了：参数和价格没变就按报价记录找回原来的幂等键", async () => {
  const request = { ...REQUEST, prompt: "find me by the quote record" };
  const { confirmationToken } = await issueGenerationConfirmation("atlas_generate_video", KEY, request, PRICE);
  // 有效令牌：照旧用传入的幂等键
  assert.equal((await resolveConfirmedIdempotencyKey(confirmationToken, "atlas_generate_video", KEY, request, PRICE)).idempotencyKey, KEY);
  // 少抄 3 个字符（2026-10-20 生产实测的样子）
  const typo = confirmationToken.slice(0, -3);
  assert.equal((await resolveConfirmedIdempotencyKey(typo, "atlas_generate_video", KEY, request, PRICE)).idempotencyKey, KEY);
  // 幂等键也换了一个、令牌也没带：仍找回报价时的那个键，重复确认不会变成新任务
  const otherKey = "99999999-2222-4333-8444-555555555555";
  const recovered = await resolveConfirmedIdempotencyKey(undefined, "atlas_generate_video", otherKey, request, PRICE);
  assert.equal(recovered.idempotencyKey, KEY);
  // 键和传入的不一样：提醒模型这可能返回已有任务，而不是新生成
  assert.match(String(recovered.notice), /existing job is returned/);
});

test("没报过价、参数变了、价格变了、换了工具：都找不到报价，不提交", async () => {
  const request = { ...REQUEST, prompt: "quoted once" };
  await issueGenerationConfirmation("atlas_generate_image", KEY, request, PRICE);
  await assert.rejects(
    resolveConfirmedIdempotencyKey(undefined, "atlas_generate_image", KEY, { ...REQUEST, prompt: "never quoted" }, PRICE),
    /No quote was found/
  );
  await assert.rejects(
    resolveConfirmedIdempotencyKey(undefined, "atlas_generate_image", KEY, { ...request, prompt: "quoted once, then edited" }, PRICE),
    /No quote was found/
  );
  const newPrice = { actual: { base_price: "0.05" } } as unknown as ModelPrice;
  await assert.rejects(
    resolveConfirmedIdempotencyKey(undefined, "atlas_generate_image", KEY, request, newPrice),
    /No quote was found/
  );
  await assert.rejects(
    resolveConfirmedIdempotencyKey(undefined, "atlas_generate_video", KEY, request, PRICE),
    /No quote was found/
  );
});

test("报价记录过期后找不到；抄错的令牌报的是令牌自己的错", async (t) => {
  const request = { ...REQUEST, prompt: "expires" };
  const { confirmationToken } = await issueGenerationConfirmation("atlas_generate_image", KEY, request, PRICE);
  const realNow = Date.now();
  t.mock.method(Date, "now", () => realNow + 2 * 3600_000);
  await assert.rejects(
    resolveConfirmedIdempotencyKey(confirmationToken, "atlas_generate_image", KEY, request, PRICE),
    /expired/
  );
  await assert.rejects(
    resolveConfirmedIdempotencyKey(undefined, "atlas_generate_image", KEY, request, PRICE),
    /No quote was found/
  );
});

test("同一组参数报价两次：令牌验过还是抄错，都落到同一个键上，不会各提交一次", async () => {
  const request = { ...REQUEST, prompt: "quoted twice" };
  const k11 = "aaaaaaaa-2222-4333-8444-555555555555";
  const k12 = "bbbbbbbb-2222-4333-8444-555555555555";
  const first = await issueGenerationConfirmation("atlas_generate_image", k11, request, PRICE);
  await issueGenerationConfirmation("atlas_generate_image", k12, request, PRICE);
  // 用第一次报价的有效令牌确认
  const viaToken = await resolveConfirmedIdempotencyKey(first.confirmationToken, "atlas_generate_image", k11, request, PRICE);
  // 模型重试时令牌抄错、键还是 K11
  const viaTypo = await resolveConfirmedIdempotencyKey(first.confirmationToken.slice(0, -3), "atlas_generate_image", k11, request, PRICE);
  assert.equal(viaToken.idempotencyKey, k12);
  assert.equal(viaTypo.idempotencyKey, k12);
  // 传入的就是记录里的键：不带提示
  const same = await resolveConfirmedIdempotencyKey(undefined, "atlas_generate_image", k12, request, PRICE);
  assert.equal(same.idempotencyKey, k12);
  assert.equal(same.notice, undefined);
});

test("报价记录存储挂住时，报价和确认都不会被拖住", async () => {
  const hanging: UploadTicketStore = {
    put: () => new Promise<void>(() => {}),
    get: () => new Promise<string | null>(() => {}),
    close: async () => {},
  };
  const context = {
    authInfo: { token: "t", clientId: "c", scopes: ["tasks:write"] } as AuthInfo,
    subject: "hanging-store-user",
    atlasApiKey: "k",
    idempotencyStore: new InMemoryIdempotencyStore(),
    idempotencyTtlSeconds: 60,
    generationConfirmationSecret: "s".repeat(40),
    generationConfirmationTtlSeconds: 600,
    quoteStore: hanging,
  };
  const request = { ...REQUEST, prompt: "store hangs" };
  const started = Date.now();
  const quote = await runWithRequestContext(context, () =>
    issueGenerationConfirmation("atlas_generate_image", KEY, request, PRICE)
  );
  const resolved = await runWithRequestContext(context, () =>
    resolveConfirmedIdempotencyKey(quote.confirmationToken, "atlas_generate_image", KEY, request, PRICE)
  );
  assert.equal(resolved.idempotencyKey, KEY);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
});
