// 报价卡问「这份报价交过没有」（atlas_card_check_submission on_load）的结果，记在浏览器里，几次加载共用。
//
// 2026-11-22 生产（SLS higress，23:10–23:30 UTC）：Claude 卡片 20 分钟约 440 次 5ms、152–157 字节的
// 200 回答，正是这个工具回 not_submitted 的长度。旧对话里的报价卡每次被重新加载都要问一遍，
// 后台定时问、切回页面也问，问来问去都是「没交过」。这里记下问过的结果：已经有定论的（作废了、
// 过期了也没交过）不再问；刚问过的，过一会儿再问。
//
// 宿主不给卡片用 localStorage 时（沙箱 iframe），读写都抛错：照旧每次问，不影响卡片。

const STORAGE_KEY = "atlas-card-quote-checks";
/**
 * 记录留这么久：比报价过期后不再问的时限（quote.ts 的 RECORD_KEPT_MS，7 天）长一点，
 * 中间不会有「记录丢了、又得再问一次」的空档。
 */
const KEEP_MS = 8 * 24 * 60 * 60_000;
/** 最多记这么多份报价，多了丢最早的。 */
const MAX_ENTRIES = 200;

/** 只记「没交过」和「作废了」：开始了的要拿服务端的回答接着显示进度，每次都得问。 */
export type CheckOutcome = "not_submitted" | "canceled" | "canceled_replaced";

export interface CheckNote {
  /** 上次问的时间（毫秒）。 */
  at: number;
  outcome: CheckOutcome;
  /** 问的时候报价已经过期：没交过就再也交不了（换了报价才会有新的卡），不用再问。 */
  expired?: boolean;
}

type Notes = Record<string, CheckNote>;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readAll(store: Storage | undefined): Notes {
  if (!store) return {};
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Notes) : {};
  } catch {
    return {};
  }
}

function valid(note: unknown): note is CheckNote {
  if (!note || typeof note !== "object") return false;
  const { at, outcome } = note as Partial<CheckNote>;
  return (
    typeof at === "number" &&
    Number.isFinite(at) &&
    (outcome === "not_submitted" || outcome === "canceled" || outcome === "canceled_replaced")
  );
}

/** 同一份报价（工具 + 幂等键）。卡里重新报价时幂等键不变、但过期时间会变，所以连发出时间一起算。 */
export function quoteKey(tool: string, idempotencyKey: string, issuedAt: number | undefined): string {
  return `${tool}|${idempotencyKey}|${issuedAt ?? ""}`;
}

export function readCheck(key: string, now = Date.now(), store = storage()): CheckNote | undefined {
  const note = readAll(store)[key];
  if (!valid(note) || now - note.at > KEEP_MS || note.at > now + 60_000) return undefined;
  return note;
}

export function writeCheck(key: string, note: CheckNote, now = Date.now(), store = storage()): void {
  if (!store) return;
  try {
    const kept = Object.entries(readAll(store)).filter(
      ([other, value]) => other !== key && valid(value) && now - value.at <= KEEP_MS
    );
    kept.sort((a, b) => a[1].at - b[1].at);
    const notes: Notes = Object.fromEntries(kept.slice(Math.max(0, kept.length - (MAX_ENTRIES - 1))));
    notes[key] = note;
    store.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // 存满了、不让存：下次照旧问。
  }
}

/** 卡片自己在这份报价上点了确认或重新报价：之前的记录作废，下次加载照常问。 */
export function forgetCheck(key: string, store = storage()): void {
  if (!store) return;
  try {
    const notes = readAll(store);
    if (!(key in notes)) return;
    delete notes[key];
    store.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // 同上。
  }
}
