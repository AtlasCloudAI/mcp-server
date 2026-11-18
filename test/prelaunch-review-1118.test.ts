// 11-18 上线前审查（服务端）：M1 资产库地址只认自家桶；M2 响应读不懂算「已发出、答复不可用」；
// M3 核实提交时结果未知不说「没开始」；M4 被拒收 / 作废的键不再沿用；M5 同样的请求刚提交过，
// 再报价沿用原键并写明；M6 对话每日额度原子预占；M7 链接超量、嵌套过深整单退回。
import assert from "node:assert/strict";
import test from "node:test";
import { NOT_STARTED_AFTER_MS, checkSubmission } from "../src/apps/submission-check.js";
import { ApiRequestError, generationApi, request } from "../src/services/api-client.js";
import {
  alreadySubmittedNotice,
  issueGenerationConfirmation,
  resolveConfirmedIdempotencyKey,
} from "../src/services/generation-confirmation.js";
import {
  UnconfirmedRequestError,
  cancelIdempotent,
  executeIdempotently,
  peekIdempotent,
  sentWithoutAnswer,
} from "../src/services/idempotency.js";
import { checkInputLinks, formatInputLinkProblems, inputLimitProblems } from "../src/services/input-link-check.js";
import { withAssetLibraryReferences } from "../src/services/library-references.js";
import { assetIdFromLibraryUrl, rememberAssetUrls } from "../src/services/media-names.js";
import { runWithRequestContext, type AtlasRequestContext } from "../src/services/request-context.js";
import {
  applyDailyAutoSubmitBudget,
  autoSpentTodayUsd,
  settleAutoSpend,
  type SpendDecision,
} from "../src/services/spend-policy.js";
import { InMemoryIdempotencyStore } from "../src/services/idempotency.js";
import { InMemoryUploadTicketStore, RedisUploadTicketStore, type UploadTicketStore } from "../src/services/upload-ticket-store.js";
import { generationConfirmationStructuredContent } from "../src/tool-contracts.js";
import type { Model, ModelPrice } from "../src/types.js";
import { handleError } from "../src/utils/error-handler.js";
import { keyBurned } from "../ui/generation-card/quote.js";

process.env.ATLASCLOUD_API_KEY ??= "test-atlas-key";

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

function context(subject: string, quoteStore: UploadTicketStore = new InMemoryUploadTicketStore()): AtlasRequestContext {
  return {
    authInfo: { token: "t", clientId: "c", scopes: [] },
    subject,
    atlasApiKey: "user-key",
    idempotencyStore: new InMemoryIdempotencyStore(),
    idempotencyTtlSeconds: 86400,
    generationConfirmationSecret: "test-generation-confirmation-secret-123456",
    generationConfirmationTtlSeconds: 600,
    quoteStore,
  };
}

const PRICE = { actual: { base_price: "0.03" } } as unknown as ModelPrice;
const TOOL = "atlas_generate_image";
const request1 = (prompt: string) => ({ resolved_model: "m/a", request_body: { model: "m/a", prompt } });

/** 照生成工具的样子提交：幂等记录的参数是 { idempotency_key, ...请求 }。 */
function submit<T>(tool: string, key: string, req: Record<string, unknown>, op: () => Promise<T>): Promise<T> {
  return executeIdempotently(tool, { idempotency_key: key, ...req }, key, op);
}

const jsonResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

// ---------- M1 ----------

const libraryUrl = (host: string, id = "asset_0e3519c46209d5d8a0bf181104cb5f35") =>
  `https://${host}/assetd/test/30d/${id}/original/photo.jpg?x-oss-signature=abc`;

test("M1: only the Asset Library's own buckets yield an asset ID", (t) => {
  withEnv(t, { MCP_ASSET_LIBRARY_HOSTS: undefined, MCP_OWNED_MEDIA_HOSTS: undefined });
  const id = "asset_0e3519c46209d5d8a0bf181104cb5f35";
  assert.equal(assetIdFromLibraryUrl(libraryUrl("atlas-asset-dev.oss-us-west-1.aliyuncs.com")), id);
  assert.equal(assetIdFromLibraryUrl(libraryUrl("atlas-asset.oss-us-west-1.aliyuncs.com")), id);
  assert.equal(assetIdFromLibraryUrl(libraryUrl("assets.atlascloud.ai")), id);
  // 别人的桶：路径再像也不认。前缀相同的新桶谁都能注册。
  for (const host of [
    "someone.oss-cn-hangzhou.aliyuncs.com",
    "atlas-asset-evil.oss-us-west-1.aliyuncs.com",
    "atlas-assetx.oss-us-west-1.aliyuncs.com",
    "atlas-media.oss-us-west-1.aliyuncs.com",
    "atlas-asset.s3.aliyuncs.com",
  ]) {
    assert.equal(assetIdFromLibraryUrl(libraryUrl(host)), undefined, host);
  }
  // 运维追加的主机认。
  process.env.MCP_ASSET_LIBRARY_HOSTS = "library.example.com";
  assert.equal(assetIdFromLibraryUrl(libraryUrl("library.example.com")), id);
});

test("M1: a foreign bucket URL is submitted as is, not rewritten to assetd://", async (t) => {
  withEnv(t, { MCP_ASSET_LIBRARY_HOSTS: undefined, MCP_OWNED_MEDIA_HOSTS: undefined });
  const foreign = libraryUrl("someone.oss-cn-hangzhou.aliyuncs.com", "asset_victim00000000000000000000001");
  const body = await withAssetLibraryReferences({ model: "m", images: [foreign], prompt: "x" });
  assert.deepEqual(body.images, [foreign]);
  // 本用户经 atlas_use_assets 取到的地址（记下了编号）照旧换成引用。
  const used = "https://cdn.example.net/signed/abc.png?sig=1";
  await rememberAssetUrls([{ asset_id: "asset_mine000000000000000000000000001", url: used }]);
  const mine = await withAssetLibraryReferences({ model: "m", images: [used] });
  assert.deepEqual(mine.images, ["assetd://asset_mine000000000000000000000000001"]);
});

// ---------- M2 ----------

test("M2: a 2xx response whose JSON can't be read becomes an ApiRequestError 502", async () => {
  await assert.rejects(
    request("https://api.example.test", "/model/generateImage", {
      method: "POST",
      body: {},
      fetcher: (async () => jsonResponse("{not json")) as never,
    }),
    (error: unknown) => error instanceof ApiRequestError && error.statusCode === 502
  );
  assert.equal(sentWithoutAnswer(new SyntaxError("Unexpected token")), true);
});

test("M2: a submission with an unreadable answer is recorded as uncertain and reported as maybe submitted", async () => {
  const key = "2c000000-0000-4000-8000-000000000001";
  let caught: unknown;
  await submit(TOOL, key, request1("m2"), () =>
    generationApi("/model/generateImage", { method: "POST", body: {}, fetcher: (async () => jsonResponse("{\"code\":200,\"data\":")) as never })
  ).catch((error: unknown) => {
    caught = error;
  });
  assert.ok(caught instanceof UnconfirmedRequestError, String(caught));
  assert.match(handleError(caught), /without a confirmed response/);
  assert.equal((await peekIdempotent(TOOL, key))?.state, "uncertain");
});

// ---------- M3 ----------

test("M3: a submission still pending (or uncertain) past the window is 'unknown', never 'didn't start'", async () => {
  const key = "3c000000-0000-4000-8000-000000000001";
  let release!: () => void;
  const running = submit(TOOL, key, request1("m3"), () => new Promise<{ ok: true; predictionId: string }>((resolve) => {
    release = () => resolve({ ok: true, predictionId: "pred-m3" });
  }));
  const later = await checkSubmission({ tool: TOOL, idempotency_key: key, now: Date.now() + NOT_STARTED_AFTER_MS + 1_000 });
  assert.equal(later.outcome, "unknown");
  assert.doesNotMatch((later as { message: string }).message, /didn't start/);
  release();
  await running;
  assert.deepEqual(await checkSubmission({ tool: TOOL, idempotency_key: key }), { outcome: "started", prediction_id: "pred-m3" });

  // 没有记录才说没开始；被拒收的照旧说没开始。
  const none = await checkSubmission({
    tool: TOOL,
    idempotency_key: "3c000000-0000-4000-8000-000000000002",
    submitted_at: new Date(Date.now() - NOT_STARTED_AFTER_MS - 5_000).toISOString(),
  });
  assert.equal(none.outcome, "not_started");
});

// ---------- M4 ----------

test("M4: a re-quote never reuses a key Atlas rejected or a quote that was canceled", async () => {
  await runWithRequestContext(context("m4-user"), async () => {
    const req = request1("m4 rejected");
    const first = await issueGenerationConfirmation(TOOL, "4c000000-0000-4000-8000-000000000001", req, PRICE);
    await submit(TOOL, first.idempotencyKey, req, async () => {
      throw new ApiRequestError("Insufficient balance", 402);
    }).catch(() => undefined);
    assert.equal((await peekIdempotent(TOOL, first.idempotencyKey))?.state, "rejected");
    // 充值后模型带着原键重新报价：拿到新键。
    const again = await issueGenerationConfirmation(TOOL, first.idempotencyKey, req, PRICE);
    assert.notEqual(again.idempotencyKey, first.idempotencyKey);
    assert.equal(again.alreadySubmitted, undefined);
    const resolved = await resolveConfirmedIdempotencyKey(again.confirmationToken, TOOL, again.idempotencyKey, req, PRICE);
    assert.equal(resolved.idempotencyKey, again.idempotencyKey);

    const canceledReq = request1("m4 canceled");
    const quoted = await issueGenerationConfirmation(TOOL, "4c000000-0000-4000-8000-000000000002", canceledReq, PRICE);
    await cancelIdempotent(TOOL, quoted.idempotencyKey, "declined");
    const requoted = await issueGenerationConfirmation(TOOL, quoted.idempotencyKey, canceledReq, PRICE);
    assert.notEqual(requoted.idempotencyKey, quoted.idempotencyKey);
  });
});

test("M4: confirming a quote whose key was rejected asks for a new quote instead of swapping back to it", async () => {
  await runWithRequestContext(context("m4-confirm"), async () => {
    const req = request1("m4 confirm");
    const quote = await issueGenerationConfirmation(TOOL, "4c000000-0000-4000-8000-000000000003", req, PRICE);
    await submit(TOOL, quote.idempotencyKey, req, async () => {
      throw new ApiRequestError("Insufficient balance", 402);
    }).catch(() => undefined);
    // 模型带着一个新键来确认：原来会按报价记录换回被拒的那个，再被拒一次。
    let message = "";
    await assert.rejects(
      resolveConfirmedIdempotencyKey(quote.confirmationToken, TOOL, "4c000000-0000-4000-8000-000000000004", req, PRICE).catch((error: Error) => {
        message = error.message;
        throw error;
      }),
      /rejected by Atlas Cloud before it started/
    );
    assert.match(message, /new quote/);
    // 卡片据这句话换新键重新报价。
    assert.equal(keyBurned(`Error: ${message}`), true);
  });
});

// ---------- M5 ----------

const MODEL = { model: "m/a", displayName: "Model A", type: "Image" } as unknown as Model;

test("M5: re-quoting a request that was just submitted keeps its key and says so; confirming returns that job", async () => {
  await runWithRequestContext(context("m5-user"), async () => {
    const req = request1("m5 same job");
    const quote = await issueGenerationConfirmation(TOOL, "5c000000-0000-4000-8000-000000000001", req, PRICE);
    const confirmed = await resolveConfirmedIdempotencyKey(quote.confirmationToken, TOOL, quote.idempotencyKey, req, PRICE);
    await submit(TOOL, confirmed.idempotencyKey, req, async () => ({ ok: true, predictionId: "pred-m5" }));

    // 模型不知道卡片上已经确认过，又报一次价（没带键，工具给了个新的）。
    const again = await issueGenerationConfirmation(TOOL, "5c000000-0000-4000-8000-000000000002", req, PRICE);
    assert.equal(again.idempotencyKey, quote.idempotencyKey);
    assert.equal(again.alreadySubmitted?.status, "submitted");
    assert.equal(again.alreadySubmitted?.predictionId, "pred-m5");
    assert.match(alreadySubmittedNotice(again.alreadySubmitted), /already submitted .* as prediction pred-m5/);
    const structured = generationConfirmationStructuredContent(MODEL, "image", again) as Record<string, unknown>;
    assert.equal((structured.already_submitted as Record<string, unknown>).prediction_id, "pred-m5");

    // 用户再点确认：拿回原来那一单，不再提交。
    const resolved = await resolveConfirmedIdempotencyKey(again.confirmationToken, TOOL, again.idempotencyKey, req, PRICE);
    let calls = 0;
    const result = await submit(TOOL, resolved.idempotencyKey, req, async () => {
      calls += 1;
      return { ok: true, predictionId: "pred-second" };
    });
    assert.equal(calls, 0);
    assert.deepEqual(result, { ok: true, predictionId: "pred-m5" });
  });
});

test("M5: a submission without a confirmed answer is flagged as unconfirmed; chat and stale submissions are exempt", async (t) => {
  await runWithRequestContext(context("m5-uncertain"), async () => {
    const req = request1("m5 uncertain");
    const quote = await issueGenerationConfirmation(TOOL, "5c000000-0000-4000-8000-000000000003", req, PRICE);
    const confirmed = await resolveConfirmedIdempotencyKey(quote.confirmationToken, TOOL, quote.idempotencyKey, req, PRICE);
    await submit(TOOL, confirmed.idempotencyKey, req, async () => {
      throw new Error("fetch failed");
    }).catch(() => undefined);
    const again = await issueGenerationConfirmation(TOOL, "5c000000-0000-4000-8000-000000000004", req, PRICE);
    assert.equal(again.idempotencyKey, quote.idempotencyKey);
    assert.equal(again.alreadySubmitted?.status, "unconfirmed");
    assert.match(alreadySubmittedNotice(again.alreadySubmitted), /did not confirm whether it started/);

    // atlas_chat：同一句话再问一遍是正常用法，拿新键。
    const chatReq = { resolved_model: "llm/x", request_body: { model: "llm/x", messages: [{ role: "user", content: "hi" }] } };
    const chatQuote = await issueGenerationConfirmation("atlas_chat", "5c000000-0000-4000-8000-000000000005", chatReq, PRICE);
    const chatKey = await resolveConfirmedIdempotencyKey(chatQuote.confirmationToken, "atlas_chat", chatQuote.idempotencyKey, chatReq, PRICE);
    await submit("atlas_chat", chatKey.idempotencyKey, chatReq, async () => ({ id: "c1" }));
    const chatAgain = await issueGenerationConfirmation("atlas_chat", "5c000000-0000-4000-8000-000000000006", chatReq, PRICE);
    assert.equal(chatAgain.idempotencyKey, "5c000000-0000-4000-8000-000000000006");
    assert.equal(chatAgain.alreadySubmitted, undefined);
  });

  // 隔了一段时间（超过 15 分钟）再报同样的价：用户想再跑一次是正常的，给新键。
  await runWithRequestContext(context("m5-stale"), async () => {
    const req = request1("m5 stale");
    const quote = await issueGenerationConfirmation(TOOL, "5c000000-0000-4000-8000-000000000007", req, PRICE);
    const confirmed = await resolveConfirmedIdempotencyKey(quote.confirmationToken, TOOL, quote.idempotencyKey, req, PRICE);
    await submit(TOOL, confirmed.idempotencyKey, req, async () => ({ ok: true, predictionId: "pred-old" }));
    const realNow = Date.now();
    t.mock.method(Date, "now", () => realNow + 16 * 60_000);
    const later = await issueGenerationConfirmation(TOOL, "5c000000-0000-4000-8000-000000000008", req, PRICE);
    assert.equal(later.idempotencyKey, "5c000000-0000-4000-8000-000000000008");
    assert.equal(later.alreadySubmitted, undefined);
    t.mock.restoreAll();
  });
});

// ---------- M6 ----------

const cheap: SpendDecision = { autoSubmit: true, quotedUsd: 0.03, thresholdUsd: 1, reason: "quote is below the threshold" };

test("M6: concurrent chat calls can't all slip under the daily budget", async (t) => {
  withEnv(t, { MCP_AUTOSUBMIT_DAILY_MAX_USD: "0.1" });
  await runWithRequestContext(context("m6-concurrent"), async () => {
    const decisions = await Promise.all(Array.from({ length: 10 }, () => applyDailyAutoSubmitBudget(cheap)));
    // 0.1 / 0.03：最多放行 3 次。原来先读后写，10 次全放行。
    assert.equal(decisions.filter((d) => d.autoSubmit).length, 3);
    assert.ok(decisions.filter((d) => !d.autoSubmit).every((d) => d.reason === "daily auto-run budget reached"));
    // 超额的预占都退回去了，只剩放行的那 3 笔。
    assert.ok(Math.abs((await autoSpentTodayUsd()) - 0.09) < 1e-9);
  });
});

test("M6: a finished call releases the unused part of its reservation; a failed one keeps it", async (t) => {
  withEnv(t, { MCP_AUTOSUBMIT_DAILY_MAX_USD: "0.05" });
  await runWithRequestContext(context("m6-settle"), async () => {
    const first = await applyDailyAutoSubmitBudget(cheap);
    assert.equal(first.autoSubmit, true);
    assert.ok(first.reservation);
    // 实际只花了 0.001：退回 0.029，下一次就能放行。
    await settleAutoSpend(first.reservation, 0.001);
    const second = await applyDailyAutoSubmitBudget(cheap);
    assert.equal(second.autoSubmit, true);
    // 失败、超时、没给用量：保留预占（0.001 + 0.03），再来一次就超了。
    await settleAutoSpend(second.reservation, null);
    const third = await applyDailyAutoSubmitBudget(cheap);
    assert.equal(third.autoSubmit, false);
    assert.ok(Math.abs(third.dailyBudget!.usedUsd - 0.031) < 1e-9);
  });
});

test("M6: the Redis store reserves with INCRBYFLOAT in one transaction", async () => {
  const calls: string[] = [];
  let value = 0;
  const client = {
    multi() {
      const tx = {
        incrByFloat(key: string, delta: number) {
          calls.push(`INCRBYFLOAT ${key} ${delta}`);
          value += delta;
          return tx;
        },
        expire(key: string, seconds: number) {
          calls.push(`EXPIRE ${key} ${seconds}`);
          return tx;
        },
        async exec() {
          return [String(value), 1];
        },
      };
      return tx;
    },
  };
  const store = new RedisUploadTicketStore(client as never, "p:");
  assert.equal(await store.incrementBy("k", 0.5, 60), 0.5);
  assert.equal(await store.incrementBy("k", -0.25, 60), 0.25);
  assert.deepEqual(calls, ["INCRBYFLOAT p:k 0.5", "EXPIRE p:k 60", "INCRBYFLOAT p:k -0.25", "EXPIRE p:k 60"]);
});

// ---------- M7 ----------

test("M7: more than 64 input links rejects the whole request instead of skipping the rest", async () => {
  const links = Array.from({ length: 65 }, (_, i) => `https://example.com/${i}.png`);
  const problems = await checkInputLinks({ model: "m", images: links });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.reason, /more than 64 input links/);
  const text = formatInputLinkProblems(problems);
  assert.match(text, /No quote was made and nothing was charged/);
  assert.doesNotMatch(text, /params: —/);
  assert.deepEqual(inputLimitProblems({ images: links.slice(0, 64) }), []);
});

test("M7: inputs nested deeper than 8 levels are rejected, even when the deep link is private", async () => {
  let deep: unknown = "http://169.254.169.254/latest/meta-data/";
  for (let i = 0; i < 10; i++) deep = { inner: deep };
  const problems = await checkInputLinks({ model: "m", image: deep as Record<string, unknown> });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.reason, /nested more than 8 levels deep/);
  // 8 层以内照常（这里只看上限检查，不发网络请求）。
  let shallow: unknown = "https://example.com/a.png";
  for (let i = 0; i < 7; i++) shallow = { inner: shallow };
  assert.deepEqual(inputLimitProblems({ image: shallow }), []);
  // 文字字段不算。
  assert.deepEqual(inputLimitProblems({ prompt: Array.from({ length: 100 }, (_, i) => `https://e.com/${i}`).join(" ") }), []);
});
