// 11-22 生产（SLS higress 23:10–23:30 UTC）：Claude 卡片 20 分钟约 440 次 atlas_card_check_submission 回
// not_submitted（5ms、152–157 字节）、512 次 429。旧对话里的报价卡每次加载都问一遍、后台定时问的 10 分钟
// 从加载时重新算、切回标签页每 3 秒就问；进度卡刷新失败一律 5 秒后重试，限流也一样。
import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import {
  POLL_PERMANENT_LIMIT,
  RATE_LIMIT_WAIT_MS,
  permanentPollError,
  pollRetryDelay,
} from "../ui/generation-card/card.js";
import { forgetCheck, quoteKey, readCheck, writeCheck } from "../ui/generation-card/check-memo.js";
import {
  RECORD_KEPT_MS,
  WATCH_FOR_MS,
  type QuoteState,
  checkKeyOf,
  createQuoteActions,
  quoteIssuedAt,
  reopenedOnQuote,
  resumePlan,
  watchGap,
} from "../ui/generation-card/quote.js";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const VALID_S = 3600;

function quoteAt(issued: number, key = "k1") {
  return {
    tool: "atlas_generate_image",
    idempotency_key: key,
    confirmation_token: "t",
    arguments: { model: "m" },
    expires_at: new Date(issued + VALID_S * 1000).toISOString(),
    valid_seconds: VALID_S,
  };
}

const saved = { window: (globalThis as { window?: unknown }).window, document: (globalThis as { document?: unknown }).document };

afterEach(() => {
  mock.timers.reset();
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { document?: unknown }).document = saved.document;
});

/** 卡片前端要的那点浏览器环境：localStorage、切回页面的监听。 */
function fakeBrowser(store: MemoryStorage | undefined) {
  const listeners: Array<() => void> = [];
  const doc = { visibilityState: "visible", addEventListener: (_: string, fn: () => void) => listeners.push(fn) };
  const win = {
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    get localStorage(): MemoryStorage {
      if (!store) throw new Error("SecurityError: storage disabled");
      return store;
    },
  };
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { document?: unknown }).document = doc;
  return { refocus: () => listeners.forEach((fn) => fn()) };
}

/** 一张报价卡和它的操作；calls 记下卡片调了几次核实工具。 */
function quoteCard(quote: ReturnType<typeof quoteAt>, reply: Record<string, unknown> = { outcome: "not_submitted" }) {
  const calls: unknown[] = [];
  let state: QuoteState = { phase: "ready" };
  const card = { state: "quote", quote } as never;
  const actions = createQuoteActions({
    app: {
      callServerTool: async (request: unknown) => {
        calls.push(request);
        return { structuredContent: reply };
      },
    } as never,
    card: () => card,
    state: () => state,
    setState: (next) => {
      state = next;
    },
    quietCalls: () => true,
    accept: () => false,
    startPolling: () => undefined,
    notice: () => undefined,
    openUrl: () => undefined,
  });
  return { calls, actions, state: () => state };
}

/** 让排队的 promise 跑完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("报价发出时间按失效时间减有效期算，重新加载不变；没有有效期就算不出", () => {
  const issued = Date.parse("2026-11-22T23:00:00Z");
  assert.equal(quoteIssuedAt(quoteAt(issued)), issued);
  assert.equal(quoteIssuedAt({ ...quoteAt(issued), valid_seconds: undefined }), undefined);
  assert.equal(quoteIssuedAt(undefined), undefined);
  assert.equal(reopenedOnQuote(quoteAt(issued), issued + 10_000), false);
  assert.equal(reopenedOnQuote(quoteAt(issued), issued + 20_000), true);
});

test("后台定时问的 10 分钟从报价发出时算：发出 10 分钟后才加载的卡一次都不定时问", () => {
  assert.equal(watchGap(0, WATCH_FOR_MS), undefined);
  assert.equal(watchGap(0, WATCH_FOR_MS - 5_000), undefined);
  // 发出 3 分钟后加载：照常先等 10 秒、再每 15 秒。
  assert.equal(watchGap(0, 3 * 60_000), 10_000);
});

test("重新打开时要不要问：作废了、过期后问到没交过、刚问过、过期超过 7 天的都不问", () => {
  const issued = Date.parse("2026-11-22T23:00:00Z");
  const quote = quoteAt(issued);
  const now = issued + 5 * 60_000;
  assert.equal(resumePlan(quote, undefined, now), "ask");
  assert.equal(resumePlan(quote, { at: now - 1_000, outcome: "canceled" }, now), "canceled");
  assert.equal(resumePlan(quote, { at: now - 1_000, outcome: "canceled_replaced" }, now), "replaced");
  assert.equal(resumePlan(quote, { at: now - 30_000, outcome: "not_submitted" }, now), "quote");
  // 有效期内问过没交过，但已经过了一分钟：再问（用户可能在对话里打字确认了）。
  assert.equal(resumePlan(quote, { at: now - 2 * 60_000, outcome: "not_submitted" }, now), "ask");
  // 过期后问到没交过：结论不会再变。
  const later = issued + 3 * 3600_000;
  assert.equal(resumePlan(quote, { at: issued + 2 * 3600_000, outcome: "not_submitted", expired: true }, later), "quote");
  // 没记录（宿主不给存）但过期已超过 7 天：服务端也不记得了，不问。
  assert.equal(resumePlan(quote, undefined, issued + VALID_S * 1000 + RECORD_KEPT_MS + 1), "quote");
  assert.equal(resumePlan(quote, undefined, issued + VALID_S * 1000 + RECORD_KEPT_MS - 60_000), "ask");
});

test("检查记录：读写、作废、过期丢弃；存不了的时候不抛错", () => {
  const store = new MemoryStorage() as unknown as Storage;
  const now = Date.parse("2026-11-23T00:00:00Z");
  const key = quoteKey("atlas_generate_image", "k1", now - 60_000);
  writeCheck(key, { at: now, outcome: "not_submitted" }, now, store);
  assert.deepEqual(readCheck(key, now + 1_000, store), { at: now, outcome: "not_submitted" });
  // 同一个幂等键、卡里重新报了价（发出时间不同）：算另一份报价。
  assert.equal(readCheck(quoteKey("atlas_generate_image", "k1", now), now, store), undefined);
  assert.equal(readCheck(key, now + 9 * 24 * 3600_000, store), undefined);
  forgetCheck(key, store);
  assert.equal(readCheck(key, now, store), undefined);
  // 坏数据、不认识的结论不当真。
  store.setItem("atlas-card-quote-checks", JSON.stringify({ [key]: { at: now, outcome: "started" } }));
  assert.equal(readCheck(key, now, store), undefined);
  store.setItem("atlas-card-quote-checks", "{oops");
  assert.equal(readCheck(key, now, store), undefined);
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  } as unknown as Storage;
  assert.doesNotThrow(() => writeCheck(key, { at: now, outcome: "canceled" }, now, broken));
  assert.equal(readCheck(key, now, broken), undefined);
  assert.doesNotThrow(() => forgetCheck(key, undefined));
});

test("检查记录最多留 200 份，多了丢最早的", () => {
  const store = new MemoryStorage() as unknown as Storage;
  const now = Date.parse("2026-11-23T00:00:00Z");
  for (let i = 0; i < 230; i++) writeCheck(`q${i}`, { at: now + i, outcome: "not_submitted" }, now + i, store);
  const notes = JSON.parse(store.getItem("atlas-card-quote-checks")!) as Record<string, unknown>;
  assert.equal(Object.keys(notes).length, 200);
  assert.equal(notes.q0, undefined);
  assert.ok(notes.q229);
});

test("过期的旧报价卡：第一次加载问一次，之后再加载不问，直接显示过期", async () => {
  const store = new MemoryStorage();
  fakeBrowser(store);
  const quote = quoteAt(Date.now() - 3 * 3600_000);
  const first = quoteCard(quote);
  first.actions.resume();
  await settle();
  assert.equal(first.calls.length, 1);
  assert.equal(first.state().phase, "expired");
  for (let i = 0; i < 5; i++) {
    const again = quoteCard(quote);
    again.actions.resume();
    await settle();
    assert.equal(again.calls.length, 0, `第 ${i + 2} 次加载`);
    assert.equal(again.state().phase, "expired");
  }
});

test("问到作废了：之后再加载直接显示作废，不再问", async () => {
  fakeBrowser(new MemoryStorage());
  const quote = quoteAt(Date.now() - 5 * 60_000);
  const first = quoteCard(quote, { outcome: "canceled", reason: "replaced" });
  first.actions.resume();
  await settle();
  assert.deepEqual(first.state(), { phase: "canceled", replaced: true });
  const again = quoteCard(quote);
  again.actions.resume();
  await settle();
  assert.equal(again.calls.length, 0);
  assert.deepEqual(again.state(), { phase: "canceled", replaced: true });
});

test("有效期内的报价：一分钟内重新加载不再问，过了一分钟再问（可能在对话里打字确认了）", async () => {
  const store = new MemoryStorage();
  fakeBrowser(store);
  const quote = quoteAt(Date.now() - 5 * 60_000);
  const first = quoteCard(quote);
  first.actions.resume();
  await settle();
  assert.equal(first.calls.length, 1);
  assert.equal(first.state().phase, "ready");
  const soon = quoteCard(quote);
  soon.actions.resume();
  await settle();
  assert.equal(soon.calls.length, 0);
  assert.equal(soon.state().phase, "ready");
  // 把记录往前挪两分钟：再问。
  const notes = JSON.parse(store.getItem("atlas-card-quote-checks")!) as Record<string, { at: number }>;
  notes[checkKeyOf(quote)]!.at -= 2 * 60_000;
  store.setItem("atlas-card-quote-checks", JSON.stringify(notes));
  const later = quoteCard(quote);
  later.actions.resume();
  await settle();
  assert.equal(later.calls.length, 1);
});

test("宿主不给存（localStorage 抛错）：照旧每次加载问一次，卡片不受影响；过期超过 7 天的不问", async () => {
  fakeBrowser(undefined);
  const quote = quoteAt(Date.now() - 3 * 3600_000);
  for (let i = 0; i < 2; i++) {
    const card = quoteCard(quote);
    card.actions.resume();
    await settle();
    assert.equal(card.calls.length, 1);
    assert.equal(card.state().phase, "expired");
  }
  const ancient = quoteCard(quoteAt(Date.now() - RECORD_KEPT_MS - 2 * 3600_000));
  ancient.actions.resume();
  await settle();
  assert.equal(ancient.calls.length, 0);
  assert.equal(ancient.state().phase, "expired");
});

test("发出 20 分钟后才加载的有效报价：不定时问；切回页面 30 秒内只问一次", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-23T01:00:00Z") });
  const browser = fakeBrowser(new MemoryStorage());
  const quote = quoteAt(Date.now() - 20 * 60_000);
  const card = quoteCard(quote);
  card.actions.watch();
  mock.timers.tick(15 * 60_000);
  await settle();
  assert.equal(card.calls.length, 0, "定时问");
  browser.refocus();
  await settle();
  assert.equal(card.calls.length, 1);
  // 一张卡挂了两个监听（visibilitychange、focus）：一次切回只问一次；10 秒后再切回也不问。
  mock.timers.tick(10_000);
  browser.refocus();
  await settle();
  assert.equal(card.calls.length, 1);
  mock.timers.tick(30_000);
  browser.refocus();
  await settle();
  assert.equal(card.calls.length, 2);
});

test("刚报出来的报价：照旧前 5 分钟每 15 秒问、问满 10 分钟停；同一份报价的另一张卡刚问过就跳过", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-23T02:00:00Z") });
  fakeBrowser(new MemoryStorage());
  const quote = quoteAt(Date.now());
  const card = quoteCard(quote);
  card.actions.watch();
  // 同一份报价的第二张卡（宿主把卡片又加载了一份）晚 5 秒挂上。
  mock.timers.tick(5_000);
  await settle();
  const twin = quoteCard(quote);
  twin.actions.watch();
  for (let i = 0; i < 12 * 60; i++) {
    mock.timers.tick(1_000);
    await settle();
  }
  assert.ok(card.calls.length >= 20 && card.calls.length < 30, `问了 ${card.calls.length} 次`);
  // 前 5 分钟第二张卡每次都赶在另一张刚问过之后，全跳过；之后每分钟一次的那几次两张错开，各问各的。
  // 加起来远不到翻倍。
  assert.ok(twin.calls.length <= 6, `第二张问了 ${twin.calls.length} 次`);
});

test("进度卡刷新失败：5→10→20→40 秒、最多 60 秒；被限流至少 30 秒", () => {
  assert.equal(pollRetryDelay(1), 5_000);
  assert.equal(pollRetryDelay(2), 10_000);
  assert.equal(pollRetryDelay(3), 20_000);
  assert.equal(pollRetryDelay(4), 40_000);
  assert.equal(pollRetryDelay(5), 60_000);
  assert.equal(pollRetryDelay(50), 60_000);
  assert.equal(pollRetryDelay(1, true), RATE_LIMIT_WAIT_MS);
  assert.equal(pollRetryDelay(5, true), 60_000);
});

test("再刷也没用的错：参数校验、工具不存在、任务查不到；限流、超时、网络错不算", () => {
  assert.ok(POLL_PERMANENT_LIMIT >= 2);
  for (const text of [
    "MCP error -32602: Input validation error: Invalid arguments for tool atlas_card_status",
    "Tool atlas_card_status not found",
    "Unknown tool: atlas_card_status",
    "Prediction abc not found",
  ]) {
    assert.equal(permanentPollError(text), true, text);
  }
  for (const text of [
    "",
    "Rate limit exceeded (rate_limit_exceeded)",
    "Request timed out",
    "fetch failed",
    "Upstream error 502",
    "MCP error -32001: Request timed out",
  ]) {
    assert.equal(permanentPollError(text), false, text);
  }
});
