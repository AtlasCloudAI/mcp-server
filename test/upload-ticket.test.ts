import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { runWithRequestContext } from "../src/services/request-context.js";
import {
  UploadTicketError,
  issueUploadTicket,
  issueUploadTicketFromContext,
  verifyUploadTicket,
} from "../src/services/upload-ticket.js";

const secret = "test-upload-ticket-secret-that-is-long-enough";
const token = "exchanged-access-token-for-user-1";

function decodedPayload(ticket: string): string {
  return Buffer.from(ticket.split(".")[0]!, "base64url").toString("utf8");
}

test("票据能原样还回凭据，且明文里既没有凭据也没有 subject", () => {
  const issued = issueUploadTicket({
    subject: "user-1",
    atlasApiKey: token,
    secret,
    ttlSeconds: 600,
  });
  assert.match(issued.ticket, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const payload = decodedPayload(issued.ticket);
  assert.ok(!payload.includes(token), "凭据必须是加密态");
  assert.ok(!payload.includes("user-1"), "payload 里只能有 subject 的哈希");

  const verified = verifyUploadTicket(issued.ticket, secret);
  assert.equal(verified.atlasApiKey, token);
  assert.equal(verified.expiresAt, issued.expiresAt);
  assert.match(verified.subjectHash, /^[a-f0-9]{64}$/);
});

test("过期票据按 410 拒绝，且过期前一刻仍然有效", () => {
  let now = 1_700_000_000_000;
  const issued = issueUploadTicket({
    subject: "user-1",
    atlasApiKey: token,
    secret,
    ttlSeconds: 60,
    now: () => now,
  });
  now += 59_000;
  assert.equal(verifyUploadTicket(issued.ticket, secret, () => now).atlasApiKey, token);
  now += 2_000;
  assert.throws(
    () => verifyUploadTicket(issued.ticket, secret, () => now),
    (error: unknown) =>
      error instanceof UploadTicketError &&
      error.status === 410 &&
      error.code === "upload_ticket_expired"
  );
});

test("签名被改、payload 被改、secret 不对，一律 401 invalid", () => {
  const issued = issueUploadTicket({
    subject: "user-1",
    atlasApiKey: token,
    secret,
    ttlSeconds: 600,
  });
  const [payload, signature] = issued.ticket.split(".") as [string, string];
  const isInvalid = (error: unknown): boolean =>
    error instanceof UploadTicketError &&
    error.status === 401 &&
    error.code === "invalid_upload_ticket";

  // 篡改签名
  const flippedSignature = `${payload}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => verifyUploadTicket(flippedSignature, secret), isInvalid);

  // 篡改 payload（改 expires_at，再用原签名）
  const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    expires_at: number;
  };
  json.expires_at += 3_600_000;
  const forged = `${Buffer.from(JSON.stringify(json)).toString("base64url")}.${signature}`;
  assert.throws(() => verifyUploadTicket(forged, secret), isInvalid);

  // 换 secret
  assert.throws(
    () => verifyUploadTicket(issued.ticket, "another-secret-that-is-also-long-enough"),
    isInvalid
  );

  // 形状不对
  for (const garbage of ["", "not-a-ticket", "a.b.c", `${payload}.`, `.${signature}`]) {
    assert.throws(() => verifyUploadTicket(garbage, secret), isInvalid, garbage);
  }
});

test("信封绑在 subject 哈希上：把别人的 payload 拼上自己的签名也解不开", () => {
  const alice = issueUploadTicket({ subject: "alice", atlasApiKey: "alice-token", secret, ttlSeconds: 600 });
  const bob = issueUploadTicket({ subject: "bob", atlasApiKey: "bob-token", secret, ttlSeconds: 600 });
  const alicePayload = JSON.parse(decodedPayload(alice.ticket)) as Record<string, unknown>;
  const bobPayload = JSON.parse(decodedPayload(bob.ticket)) as Record<string, unknown>;
  // 把 alice 的信封塞进 bob 的 subject_hash 下——签名重新算不出来（没 secret），
  // 这里模拟的是「拿到 secret 但拿错 subject」：直接用 verify 的解密路径验证 AAD 绑定。
  const mixed = { ...bobPayload, envelope: alicePayload.envelope };
  const encoded = Buffer.from(JSON.stringify(mixed)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  assert.throws(
    () => verifyUploadTicket(`${encoded}.${signature}`, secret),
    (error: unknown) => error instanceof UploadTicketError && error.status === 401
  );
});

test("从 request context 铸票：只有远程服务给了 uploadBaseUrl 才发，stdio 拿不到", () => {
  const baseContext = {
    authInfo: {
      token: "test-access-token",
      clientId: "test-client",
      scopes: ["tasks:write"],
    } as AuthInfo,
    subject: "user-1",
    atlasApiKey: token,
    idempotencyStore: new InMemoryIdempotencyStore(),
    idempotencyTtlSeconds: 60,
    generationConfirmationSecret: secret,
    generationConfirmationTtlSeconds: 600,
  };

  // stdio 形态：没有上传相关字段
  assert.equal(runWithRequestContext(baseContext, () => issueUploadTicketFromContext()), undefined);

  const issued = runWithRequestContext(
    {
      ...baseContext,
      uploadBaseUrl: "https://mcp.example.test/upload/",
      uploadTicketTtlSeconds: 600,
      uploadMaxBytes: 33_554_432,
    },
    () => issueUploadTicketFromContext()
  );
  assert.ok(issued);
  assert.ok(issued.uploadUrl.startsWith("https://mcp.example.test/upload/"));
  assert.equal(issued.maxBytes, 33_554_432);
  const ticket = issued.uploadUrl.slice("https://mcp.example.test/upload/".length);
  assert.equal(verifyUploadTicket(ticket, secret).atlasApiKey, token);
});
