// 11-19 增量审查（11-18 修复之后的改动）：
// S1 「是不是链接」「链接上限」「内网检查」用同一个判断，首尾夹 Unicode 空白的链接整条退回；
// S2 同样的请求 15 分钟内提交过，只有那一单还没结束才沿用原键，结束了就是新的一次运行。
import assert from "node:assert/strict";
import test from "node:test";
import {
  GenerationConfirmationError,
  alreadySubmittedNotice,
  issueGenerationConfirmation,
  repeatNotice,
  resolveConfirmedIdempotencyKey,
  setPredictionStatusLookupForTests,
} from "../src/services/generation-confirmation.js";
import { ApiRequestError } from "../src/services/api-client.js";
import { InMemoryIdempotencyStore, executeIdempotently } from "../src/services/idempotency.js";
import { inputLimitProblems, inputLinks, localInputValues, trimLinkPadding } from "../src/services/input-link-check.js";
import { runWithRequestContext, type AtlasRequestContext } from "../src/services/request-context.js";
import { InMemoryUploadTicketStore } from "../src/services/upload-ticket-store.js";
import { generationConfirmationStructuredContent } from "../src/tool-contracts.js";
import type { Model, ModelPrice } from "../src/types.js";

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
      assert.match(problems[0]!.reason, /invisible character/, name);
    }
  }
});

test("S1: local schemes and paths hidden behind a leading control character are still caught", () => {
  for (const value of ["\u0001file:///etc/passwd", "\u001cfile:///etc/passwd", "\u00a0gopher://127.0.0.1:6379/_x"]) {
    const problems = localInputValues({ image_url: value });
    assert.equal(problems.length, 1, JSON.stringify(value));
    assert.match(problems[0]!.reason, /only http and https/, JSON.stringify(value));
  }
  const path = localInputValues({ image_url: "\u0001/etc/passwd" });
  assert.match(path[0]!.reason, /file path/);
});

test("S1: a link with a backslash is sent back (parsers disagree on its host)", () => {
  const problems = localInputValues({ image_url: "http://evil.example\\@169.254.169.254/x.png" });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.reason, /backslash/);
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
      assert.equal(again.repeatOf?.predictionId, `pred-done-${i}`, status);
      assert.match(repeatNotice(again.repeatOf), /charged again/, status);

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

// ---------- S2：再跑一次的报价只认明确指向它的确认（第一轮复审：旧令牌落到新报价上会另扣一次） ----------

const MODEL = { model: "m/a", displayName: "Model A", type: "Image" } as unknown as Model;

async function quoteConfirmSubmit(req: Record<string, unknown>, key: string, predictionId: string) {
  const quote = await issueGenerationConfirmation(TOOL, key, req, PRICE);
  const confirmed = await resolveConfirmedIdempotencyKey(quote.confirmationToken, TOOL, quote.idempotencyKey, req, PRICE);
  await submit(confirmed.idempotencyKey, req, async () => ({ ok: true, predictionId }));
  return { quote, key: confirmed.idempotencyKey };
}

test("S2: after a re-run quote, the earlier quote's token, its key, or a bare confirm never start the new run", async (t) => {
  setPredictionStatusLookupForTests(async () => "completed");
  t.after(() => setPredictionStatusLookupForTests());
  await runWithRequestContext(context("s2-stale"), async () => {
    const req = request1("s2 stale confirm");
    const first = await quoteConfirmSubmit(req, "5d000000-0000-4000-8000-000000000601", "pred-first");
    const rerun = await issueGenerationConfirmation(TOOL, "5d000000-0000-4000-8000-000000000602", req, PRICE);
    assert.equal(rerun.repeatOf?.predictionId, "pred-first");
    const structured = generationConfirmationStructuredContent(MODEL, "image", rerun) as Record<string, unknown>;
    assert.equal((structured.repeat_of as Record<string, unknown>).prediction_id, "pred-first");
    assert.match(String((structured.repeat_of as Record<string, unknown>).note), /charged again/);

    // 旧报价的令牌 + 旧键：拿回旧单，不新建。
    const viaOldToken = await resolveConfirmedIdempotencyKey(first.quote.confirmationToken, TOOL, first.key, req, PRICE);
    assert.equal(viaOldToken.idempotencyKey, first.key);
    assert.match(viaOldToken.notice ?? "", /already submitted as prediction pred-first/);
    // 只带旧令牌、不带键：同样拿回旧单。
    const viaOldTokenOnly = await resolveConfirmedIdempotencyKey(first.quote.confirmationToken, TOOL, undefined, req, PRICE);
    assert.equal(viaOldTokenOnly.idempotencyKey, first.key);
    // 只带旧键：同样拿回旧单。
    const viaOldKey = await resolveConfirmedIdempotencyKey(undefined, TOOL, first.key, req, PRICE);
    assert.equal(viaOldKey.idempotencyKey, first.key);
    let calls = 0;
    const result = await submit(viaOldKey.idempotencyKey, req, async () => {
      calls += 1;
      return { ok: true, predictionId: "pred-should-not-run" };
    });
    assert.equal(calls, 0);
    assert.deepEqual(result, { ok: true, predictionId: "pred-first" });

    // 什么都不带的确认：拒绝，什么都不提交。
    await assert.rejects(
      resolveConfirmedIdempotencyKey(undefined, TOOL, undefined, req, PRICE),
      (error: unknown) => error instanceof GenerationConfirmationError && /runs a request that was already submitted/.test(String(error))
    );
    // 别的键（模型自己编的）也不行。
    await assert.rejects(
      resolveConfirmedIdempotencyKey(undefined, TOOL, "5d000000-0000-4000-8000-000000000699", req, PRICE),
      GenerationConfirmationError
    );

    // 明确指向新报价（它的令牌或键）：才真的再跑一次。
    const viaNewToken = await resolveConfirmedIdempotencyKey(rerun.confirmationToken, TOOL, first.key, req, PRICE);
    assert.equal(viaNewToken.idempotencyKey, rerun.idempotencyKey);
    const viaNewKey = await resolveConfirmedIdempotencyKey(undefined, TOOL, rerun.idempotencyKey, req, PRICE);
    assert.equal(viaNewKey.idempotencyKey, rerun.idempotencyKey);
  });
});

test("S2: quoting again with the finished job's own key gets a new key (models often reuse the last key)", async (t) => {
  setPredictionStatusLookupForTests(async () => "failed");
  t.after(() => setPredictionStatusLookupForTests());
  await runWithRequestContext(context("s2-same-key"), async () => {
    const req = request1("s2 same key");
    const first = await quoteConfirmSubmit(req, "5d000000-0000-4000-8000-000000000701", "pred-failed");
    const again = await issueGenerationConfirmation(TOOL, first.key, req, PRICE);
    assert.notEqual(again.idempotencyKey, first.key);
    assert.equal(again.alreadySubmitted, undefined);
    assert.equal(again.repeatOf?.predictionId, "pred-failed");
    // 模型确认时还带着旧键、没带令牌：拿回失败的旧单，不新建。
    const viaOldKey = await resolveConfirmedIdempotencyKey(undefined, TOOL, first.key, req, PRICE);
    assert.equal(viaOldKey.idempotencyKey, first.key);
    // 带着新报价的令牌（卡片的 Retry 就是这样）：新建一单。
    const viaToken = await resolveConfirmedIdempotencyKey(again.confirmationToken, TOOL, first.key, req, PRICE);
    assert.equal(viaToken.idempotencyKey, again.idempotencyKey);
    let calls = 0;
    await submit(viaToken.idempotencyKey, req, async () => {
      calls += 1;
      return { ok: true, predictionId: "pred-retry" };
    });
    assert.equal(calls, 1);
  });
});

test("S2: a job still running is never treated as a re-run, even with its own key", async (t) => {
  setPredictionStatusLookupForTests(async () => "processing");
  t.after(() => setPredictionStatusLookupForTests());
  await runWithRequestContext(context("s2-same-key-running"), async () => {
    const req = request1("s2 same key running");
    const first = await quoteConfirmSubmit(req, "5d000000-0000-4000-8000-000000000801", "pred-running-2");
    const again = await issueGenerationConfirmation(TOOL, first.key, req, PRICE);
    assert.equal(again.idempotencyKey, first.key);
    assert.equal(again.repeatOf, undefined);
    assert.equal(again.alreadySubmitted?.predictionId, "pred-running-2");
  });
});

// ---------- 第二轮复审 ----------

test("round 2: an old confirmation after the 15-minute window still returns the earlier job", async (t) => {
  setPredictionStatusLookupForTests(async () => "completed");
  t.after(() => {
    setPredictionStatusLookupForTests();
    t.mock.restoreAll();
  });
  await runWithRequestContext(context("r2-late"), async () => {
    const req = request1("r2 late stale confirm");
    const first = await quoteConfirmSubmit(req, "5d000000-0000-4000-8000-000000000901", "pred-late-1");
    const realNow = Date.now();
    t.mock.method(Date, "now", () => realNow + 16 * 60_000);
    const later = await issueGenerationConfirmation(TOOL, "5d000000-0000-4000-8000-000000000902", req, PRICE);
    assert.equal(later.idempotencyKey, "5d000000-0000-4000-8000-000000000902");
    assert.equal(later.repeatOf?.predictionId, "pred-late-1");
    // 旧令牌 + 旧键（令牌还在有效期内）：拿回旧单。
    const stale = await resolveConfirmedIdempotencyKey(first.quote.confirmationToken, TOOL, first.key, req, PRICE);
    assert.equal(stale.idempotencyKey, first.key);
    let calls = 0;
    const result = await submit(stale.idempotencyKey, req, async () => {
      calls += 1;
      return { ok: true, predictionId: "pred-unapproved" };
    });
    assert.equal(calls, 0);
    assert.deepEqual(result, { ok: true, predictionId: "pred-late-1" });
  });
});

test("round 2: quoting with a finished job's key while a newer run of the same request is running returns the running one", async (t) => {
  let status = "completed";
  setPredictionStatusLookupForTests(async (id) => (id === "pred-r2-old" ? "completed" : status));
  t.after(() => setPredictionStatusLookupForTests());
  await runWithRequestContext(context("r2-running-newer"), async () => {
    const req = request1("r2 running newer");
    const first = await quoteConfirmSubmit(req, "5d000000-0000-4000-8000-000000000a01", "pred-r2-old");
    const rerun = await issueGenerationConfirmation(TOOL, first.key, req, PRICE);
    assert.equal(rerun.repeatOf?.predictionId, "pred-r2-old");
    const confirmed = await resolveConfirmedIdempotencyKey(rerun.confirmationToken, TOOL, rerun.idempotencyKey, req, PRICE);
    await submit(confirmed.idempotencyKey, req, async () => ({ ok: true, predictionId: "pred-r2-new" }));
    status = "processing";
    const again = await issueGenerationConfirmation(TOOL, first.key, req, PRICE);
    assert.equal(again.idempotencyKey, confirmed.idempotencyKey);
    assert.equal(again.alreadySubmitted?.predictionId, "pred-r2-new");
    assert.equal(again.repeatOf, undefined);
  });
});

test("round 2: an old key whose submission record expired is refused, not resubmitted under that key", async (t) => {
  setPredictionStatusLookupForTests(async () => "completed");
  t.after(() => setPredictionStatusLookupForTests());
  const ctx = context("r2-expired");
  await runWithRequestContext(ctx, async () => {
    const req = request1("r2 expired");
    const first = await quoteConfirmSubmit(req, "5d000000-0000-4000-8000-000000000b01", "pred-r2-expired");
    const rerun = await issueGenerationConfirmation(TOOL, "5d000000-0000-4000-8000-000000000b02", req, PRICE);
    assert.equal(rerun.repeatOf?.predictionId, "pred-r2-expired");
    // 旧单的提交记录过期了（模拟：换一个空的幂等存储）。
    ctx.idempotencyStore = new InMemoryIdempotencyStore();
    await assert.rejects(
      resolveConfirmedIdempotencyKey(undefined, TOOL, first.key, req, PRICE),
      (error: unknown) => error instanceof GenerationConfirmationError && /can no longer be looked up/.test(String(error))
    );
  });
});

test("round 2: only http(s), data, asset and assetd reach the gateway from asset fields; dangerous schemes are refused anywhere", () => {
  for (const value of [
    "tcp://169.254.169.254:80/",
    "rtsp://10.0.0.1/stream",
    "rtmp://10.0.0.1/live",
    "udp://10.0.0.1:1234",
    "concat:/etc/passwd|/etc/hosts",
    "subfile,,start,0,end,0,,:/etc/passwd",
    "hls+http://169.254.169.254/x.m3u8",
    "s3://bucket/key",
    "http+unix://%2Fvar%2Frun%2Fdocker.sock/info",
    "URL:http://169.254.169.254/",
    "<URL:file:///etc/passwd>",
  ]) {
    const problems = localInputValues({ image_url: value });
    assert.equal(problems.length, 1, value);
    assert.match(problems[0]!.reason, /only http and https/, value);
  }
  // 字段名看不出是素材的：危险协议和系统路径照样退回。
  for (const value of ["file:///etc/passwd", "/etc/passwd", "tcp://169.254.169.254:80/", "URL:http://169.254.169.254/"]) {
    assert.equal(localInputValues({ face: value }).length, 1, value);
  }
  // 正常写法不受影响。
  for (const value of ["https://example.com/a.png", "data:image/png;base64,iVBORw0KGgo=", "asset://asset_0e3519c46209d5d8a0bf181104cb5f35", "assetd://asset_0e3519c46209d5d8a0bf181104cb5f35"]) {
    assert.deepEqual(localInputValues({ image_url: value }), [], value);
  }
  for (const value of ["fast", "16:9", "mode:portrait", "1080p"]) {
    assert.deepEqual(localInputValues({ style: value }), [], value);
  }
});

test("round 2: whitespace pasted around a link is trimmed (not refused); control characters are still refused", () => {
  const params = trimLinkPadding({
    prompt: "　keep the prompt as is ",
    image_url: "https://example.com/a.png　",
    images: [" https://example.com/b.png", "﻿https://example.com/c.png​"],
    other: "\u0001https://example.com/d.png",
  });
  assert.equal(params.prompt, "　keep the prompt as is ");
  assert.equal(params.image_url, "https://example.com/a.png");
  assert.deepEqual(params.images, ["https://example.com/b.png", "https://example.com/c.png"]);
  assert.equal(params.other, "\u0001https://example.com/d.png");
  assert.deepEqual(localInputValues({ image_url: params.image_url }), []);
  assert.equal(localInputValues({ other: params.other }).length, 1);
});

// ---------- 第三轮复审 ----------

test("round 3: a rejected re-run does not hide the earlier job; the old token still returns it", async (t) => {
  setPredictionStatusLookupForTests(async () => "completed");
  t.after(() => setPredictionStatusLookupForTests());
  await runWithRequestContext(context("r3-rejected"), async () => {
    const req = request1("r3 rejected rerun");
    const first = await quoteConfirmSubmit(req, "5d000000-0000-4000-8000-000000000c01", "pred-r3-first");
    const rerun = await issueGenerationConfirmation(TOOL, "5d000000-0000-4000-8000-000000000c02", req, PRICE);
    const confirmed = await resolveConfirmedIdempotencyKey(rerun.confirmationToken, TOOL, rerun.idempotencyKey, req, PRICE);
    // 上游拒收（429）：这一单没开始。
    await submit(confirmed.idempotencyKey, req, async () => {
      throw new ApiRequestError("rate limited", 429);
    }).catch(() => undefined);
    const again = await issueGenerationConfirmation(TOOL, "5d000000-0000-4000-8000-000000000c03", req, PRICE);
    assert.equal(again.repeatOf?.predictionId, "pred-r3-first");
    const stale = await resolveConfirmedIdempotencyKey(first.quote.confirmationToken, TOOL, undefined, req, PRICE);
    assert.equal(stale.idempotencyKey, first.key);
  });
});

test("round 3: plain-text values in non-asset fields are not taken for schemes or paths", () => {
  for (const [field, value] of [
    ["style", "R+B: smooth"],
    ["tags", "C++: coding lofi"],
    ["title", "Crypto: the movie"],
    ["title", "URL: what it means"],
    ["style", "Async, glitchy"],
    ["input", "Concat: the two scenes"],
    ["note", "// TODO later"],
    ["voice_id", "en-US:Neural"],
    ["timecode", "00:01"],
  ] as const) {
    assert.deepEqual(localInputValues({ [field]: value }), [], `${field}: ${value}`);
  }
});

test("round 3: link-like values without spaces in any non-text field are still checked", () => {
  for (const value of ["URL: http://169.254.169.254/", "< URL: file:///etc/passwd >"]) {
    assert.equal(localInputValues({ title: value }).length, 1, value);
  }
  for (const value of ["tls://10.0.0.1:443", "gophers://127.0.0.1/", "applehttp://10.0.0.1/x", "//169.254.169.254/latest", "../../etc/passwd", "/app/.env", "/data/secret.png", "~/.aws/credentials"]) {
    assert.equal(localInputValues({ garment: value }).length, 1, value);
  }
});

test("round 3: ASCII-only whitespace around a link is left as is (request fingerprints stay stable)", () => {
  assert.equal(trimLinkPadding({ image_url: "https://example.com/a.png \n" }).image_url, "https://example.com/a.png \n");
  assert.equal(trimLinkPadding({ image_url: "https://example.com/a.png\u200b" }).image_url, "https://example.com/a.png");
});

// ---------- 第四轮复审 ----------

test("round 4: rejected re-runs don't push the job that ran out of the submission history", async (t) => {
  setPredictionStatusLookupForTests(async () => "completed");
  t.after(() => setPredictionStatusLookupForTests());
  await runWithRequestContext(context("r4-many-rejected"), async () => {
    const req = request1("r4 many rejected");
    const first = await quoteConfirmSubmit(req, "5d000000-0000-4000-8000-000000000d01", "pred-r4-first");
    for (let i = 0; i < 7; i += 1) {
      const rerun = await issueGenerationConfirmation(TOOL, `5d000000-0000-4000-8000-000000000d1${i}`, req, PRICE);
      assert.equal(rerun.repeatOf?.predictionId, "pred-r4-first", `attempt ${i}`);
      const confirmed = await resolveConfirmedIdempotencyKey(rerun.confirmationToken, TOOL, rerun.idempotencyKey, req, PRICE);
      await submit(confirmed.idempotencyKey, req, async () => {
        throw new ApiRequestError("insufficient balance", 402);
      }).catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const last = await issueGenerationConfirmation(TOOL, "5d000000-0000-4000-8000-000000000d99", req, PRICE);
    assert.equal(last.repeatOf?.predictionId, "pred-r4-first");
    const stale = await resolveConfirmedIdempotencyKey(first.quote.confirmationToken, TOOL, first.key, req, PRICE);
    assert.equal(stale.idempotencyKey, first.key);
  });
});

test("round 4: asset values written with spaces around a scheme are still refused; prose is not", () => {
  for (const value of ["concat: /etc/passwd", "concat:  /etc/passwd|/etc/hosts", "file:/// etc/passwd", "gopher://169.254.169.254/ x", "URL: http://169.254.169.254/ x"]) {
    assert.equal(localInputValues({ image_url: value }).length, 1, value);
  }
  for (const [field, value] of [["input", "/imagine"], ["caption", "/imagine"], ["tags", "/fashion"], ["style", "//bass.drop"], ["input", "Concat: the two scenes"]] as const) {
    assert.deepEqual(localInputValues({ [field]: value }), [], `${field}: ${value}`);
  }
  for (const value of ["//localhost/x", "//intranet/x", "//2130706433/x", "//localhost:8080"]) {
    assert.equal(localInputValues({ face: value }).length, 1, value);
  }
});
