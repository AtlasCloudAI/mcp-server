// 11-19 增量审查（11-18 修复之后的改动）：
// S1 「是不是链接」「链接上限」「内网检查」用同一个判断，首尾夹 Unicode 空白的链接整条退回；
// S2 同样的请求 15 分钟内提交过，只有那一单还没结束才沿用原键，结束了就是新的一次运行。
import assert from "node:assert/strict";
import test from "node:test";
import {
  alreadySubmittedNotice,
  issueGenerationConfirmation,
  resolveConfirmedIdempotencyKey,
  setPredictionStatusLookupForTests,
} from "../src/services/generation-confirmation.js";
import { InMemoryIdempotencyStore, executeIdempotently } from "../src/services/idempotency.js";
import { inputLimitProblems, inputLinks, localInputValues } from "../src/services/input-link-check.js";
import { runWithRequestContext, type AtlasRequestContext } from "../src/services/request-context.js";
import { InMemoryUploadTicketStore } from "../src/services/upload-ticket-store.js";
import type { ModelPrice } from "../src/types.js";

process.env.ATLASCLOUD_API_KEY ??= "test-atlas-key";

// ---------- S1 ----------

const PADDINGS: Array<[string, string]> = [
  ["no-break space", " "],
  ["byte order mark", "﻿"],
  ["zero-width space", "​"],
  ["ideographic space", "　"],
  ["control character", "\u0001"],
];

test("S1: a link padded with Unicode whitespace or control characters is sent back as malformed", () => {
  for (const [name, pad] of PADDINGS) {
    for (const value of [`${pad}http://169.254.169.254/latest/meta-data`, `http://169.254.169.254/x.png${pad}`]) {
      const problems = localInputValues({ image_url: value });
      assert.equal(problems.length, 1, `${name}: ${JSON.stringify(value)}`);
      assert.match(problems[0]!.reason, /not a complete link/, name);
    }
  }
});

test("S1: ordinary links still pass, including surrounding spaces and non-ASCII paths", () => {
  for (const value of [
    "https://example.com/a.png",
    "  https://example.com/a.png \t",
    "https://example.com/图片/猫.png",
    "https://例子.测试/a.png",
  ]) {
    assert.deepEqual(localInputValues({ image_url: value }), [], value);
  }
  assert.deepEqual(inputLinks({ image_url: "  https://example.com/a.png\n" }), [
    { field: "image_url", url: "https://example.com/a.png" },
  ]);
});

test("S1: a padded link counts toward the 64-link limit (the 65th can't slip past)", () => {
  const images = Array.from({ length: 64 }, (_, i) => `https://example.com/${i}.png`);
  assert.deepEqual(inputLimitProblems({ images }), []);
  for (const [name, pad] of PADDINGS) {
    const problems = inputLimitProblems({ images: [...images, `${pad}http://169.254.169.254/x.png`] });
    assert.equal(problems.length, 1, name);
    assert.match(problems[0]!.reason, /more than 64 input links/, name);
  }
});

test("S1: link collection sees the padded link the same way the limit check does", () => {
  const links = inputLinks({ image_url: " http://169.254.169.254/x.png" }, { maxLinks: 64, maxDepth: 8 });
  assert.deepEqual(links, [{ field: "image_url", url: "http://169.254.169.254/x.png" }]);
});

// ---------- S2 ----------

function context(subject: string): AtlasRequestContext {
  return {
    authInfo: { token: "t", clientId: "c", scopes: [] },
    subject,
    atlasApiKey: "user-key",
    idempotencyStore: new InMemoryIdempotencyStore(),
    idempotencyTtlSeconds: 86400,
    generationConfirmationSecret: "test-generation-confirmation-secret-123456",
    generationConfirmationTtlSeconds: 600,
    quoteStore: new InMemoryUploadTicketStore(),
  };
}

const PRICE = { actual: { base_price: "0.03" } } as unknown as ModelPrice;
const TOOL = "atlas_generate_image";
const request1 = (prompt: string) => ({ resolved_model: "m/a", request_body: { model: "m/a", prompt } });

function submit<T>(key: string, req: Record<string, unknown>, op: () => Promise<T>): Promise<T> {
  return executeIdempotently(TOOL, { idempotency_key: key, ...req }, key, op);
}

/** 报价、确认、提交一单，返回那一单用的键。 */
async function submitOnce(req: Record<string, unknown>, key: string, predictionId: string): Promise<string> {
  const quote = await issueGenerationConfirmation(TOOL, key, req, PRICE);
  const confirmed = await resolveConfirmedIdempotencyKey(quote.confirmationToken, TOOL, quote.idempotencyKey, req, PRICE);
  await submit(confirmed.idempotencyKey, req, async () => ({ ok: true, predictionId }));
  return confirmed.idempotencyKey;
}

test("S2: re-quoting the same request while its job is still running keeps the job", async (t) => {
  const asked: string[] = [];
  setPredictionStatusLookupForTests(async (id) => {
    asked.push(id);
    return "processing";
  });
  t.after(() => setPredictionStatusLookupForTests());
  await runWithRequestContext(context("s2-running"), async () => {
    const req = request1("s2 running");
    const first = await submitOnce(req, "5d000000-0000-4000-8000-000000000001", "pred-running");
    const again = await issueGenerationConfirmation(TOOL, "5d000000-0000-4000-8000-000000000002", req, PRICE);
    assert.equal(again.idempotencyKey, first);
    assert.equal(again.alreadySubmitted?.predictionId, "pred-running");
    assert.match(alreadySubmittedNotice(again.alreadySubmitted), /already submitted/);
  });
  assert.deepEqual(asked, ["pred-running"]);
});

test("S2: once that job has finished, the same request is a new run with its own key", async (t) => {
  t.after(() => setPredictionStatusLookupForTests());
  for (const [i, status] of ["completed", "succeeded", "FAILED", "canceled", "cancelled", "timeout"].entries()) {
    setPredictionStatusLookupForTests(async () => status);
    await runWithRequestContext(context(`s2-finished-${i}`), async () => {
      const req = request1(`s2 finished ${status}`);
      const first = await submitOnce(req, `5d000000-0000-4000-8000-00000000010${i}`, `pred-done-${i}`);
      const newKey = `5d000000-0000-4000-8000-00000000020${i}`;
      const again = await issueGenerationConfirmation(TOOL, newKey, req, PRICE);
      assert.equal(again.idempotencyKey, newKey, status);
      assert.notEqual(again.idempotencyKey, first, status);
      assert.equal(again.alreadySubmitted, undefined, status);

      // 用户确认这份新报价：真的提交一单新的。
      const confirmed = await resolveConfirmedIdempotencyKey(again.confirmationToken, TOOL, again.idempotencyKey, req, PRICE);
      assert.equal(confirmed.idempotencyKey, newKey, status);
      let calls = 0;
      const result = await submit(confirmed.idempotencyKey, req, async () => {
        calls += 1;
        return { ok: true, predictionId: `pred-new-${i}` };
      });
      assert.equal(calls, 1, status);
      assert.deepEqual(result, { ok: true, predictionId: `pred-new-${i}` });
    });
  }
});

test("S2: an unknown status, a failed lookup or a slow one keeps the job (never risks a second charge)", async (t) => {
  t.after(() => setPredictionStatusLookupForTests());
  const lookups: Array<[string, () => Promise<string | undefined>]> = [
    ["unknown status", async () => "starting_soon"],
    ["no status", async () => undefined],
    ["lookup error", async () => {
      throw new Error("503 service unavailable");
    }],
    ["lookup hangs", () => new Promise<string | undefined>(() => undefined)],
  ];
  for (const [i, [name, lookup]] of lookups.entries()) {
    setPredictionStatusLookupForTests(lookup);
    await runWithRequestContext(context(`s2-unknown-${i}`), async () => {
      const req = request1(`s2 unknown ${name}`);
      const first = await submitOnce(req, `5d000000-0000-4000-8000-00000000030${i}`, `pred-unknown-${i}`);
      const again = await issueGenerationConfirmation(TOOL, `5d000000-0000-4000-8000-00000000040${i}`, req, PRICE);
      assert.equal(again.idempotencyKey, first, name);
      assert.equal(again.alreadySubmitted?.predictionId, `pred-unknown-${i}`, name);
    });
  }
});

test("S2: a submission with no job ID yet (in progress or unconfirmed) is kept without asking for its status", async (t) => {
  let asked = 0;
  setPredictionStatusLookupForTests(async () => {
    asked += 1;
    return "completed";
  });
  t.after(() => setPredictionStatusLookupForTests());
  await runWithRequestContext(context("s2-no-id"), async () => {
    const req = request1("s2 no id");
    const quote = await issueGenerationConfirmation(TOOL, "5d000000-0000-4000-8000-000000000501", req, PRICE);
    const confirmed = await resolveConfirmedIdempotencyKey(quote.confirmationToken, TOOL, quote.idempotencyKey, req, PRICE);
    await submit(confirmed.idempotencyKey, req, async () => {
      throw new Error("fetch failed");
    }).catch(() => undefined);
    const again = await issueGenerationConfirmation(TOOL, "5d000000-0000-4000-8000-000000000502", req, PRICE);
    assert.equal(again.idempotencyKey, confirmed.idempotencyKey);
    assert.equal(again.alreadySubmitted?.status, "unconfirmed");
  });
  assert.equal(asked, 0);
});
