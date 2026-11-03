import { createHash } from "node:crypto";
import { getRequestContext } from "./request-context.js";
import { InMemoryUploadTicketStore, type UploadTicketStore } from "./upload-ticket-store.js";

/**
 * 确认了却没开始的生成（余额不足、模型不可用……）。
 *
 * 卡片里点确认失败时，卡片会用 updateModelContext 告诉模型；但 Claude 收下上下文、模型看不到
 * （2026-11-03 实测）。用户问「生成了吗」，模型查历史没找到，就猜「卡片可能没收到点击」，还提出
 * 再跑一次，而再跑会因为同样的原因失败。所以服务端也记一笔：同一用户最近几次没开始的确认，
 * atlas_list_predictions 附在结果后面。
 *
 * 借用报价记录的存储（多副本也查得到），键加前缀，不会和报价记录的摘要键撞上。
 */
const KEY_PREFIX = "not-started:";
// 用户回头问「生成了吗」通常就在几分钟内；留一小时，太久的失败也不该再提。
const TTL_SECONDS = 3600;
const MAX_ENTRIES = 3;
const MAX_REASON_LENGTH = 200;
// 和报价记录一样：Redis 断线时命令会排队挂住，这一笔不值得拖住工具结果。
const STORE_TIMEOUT_MS = 500;

const localRecords = new InMemoryUploadTicketStore();

export interface NotStarted {
  model: string;
  reason: string;
  /** ISO 时间。 */
  at: string;
}

function store(explicit?: UploadTicketStore): UploadTicketStore {
  return explicit ?? getRequestContext()?.quoteStore ?? localRecords;
}

function keyOf(subject: string): string {
  return KEY_PREFIX + createHash("sha256").update(subject).digest("hex");
}

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("not-started store timed out")), STORE_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function parse(raw: string | null): NotStarted[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is NotStarted =>
            typeof entry?.model === "string" && typeof entry?.reason === "string" && typeof entry?.at === "string"
        )
      : [];
  } catch {
    return [];
  }
}

/** 报错的第一句话：报错后面常接着给模型的长段说明，用户只需要原因。 */
function reasonOf(text: string): string {
  const first = text.trim().split("\n")[0]!.trim();
  return first.length > MAX_REASON_LENGTH ? `${first.slice(0, MAX_REASON_LENGTH - 3)}...` : first;
}

export async function rememberNotStarted(
  model: string,
  errorText: string,
  options: { store?: UploadTicketStore; now?: Date } = {}
): Promise<void> {
  const subject = getRequestContext()?.subject ?? "stdio";
  const key = keyOf(subject);
  try {
    const entries = parse(await withTimeout(store(options.store).get(key)));
    const entry = { model, reason: reasonOf(errorText), at: (options.now ?? new Date()).toISOString() };
    await withTimeout(store(options.store).put(key, JSON.stringify([entry, ...entries].slice(0, MAX_ENTRIES)), TTL_SECONDS));
  } catch (error) {
    console.error(`[not-started] put failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function recentNotStarted(
  options: { store?: UploadTicketStore; now?: Date } = {}
): Promise<NotStarted[]> {
  const subject = getRequestContext()?.subject ?? "stdio";
  const since = (options.now ?? new Date()).getTime() - TTL_SECONDS * 1000;
  try {
    return parse(await withTimeout(store(options.store).get(keyOf(subject)))).filter(
      (entry) => Date.parse(entry.at) > since
    );
  } catch (error) {
    console.error(`[not-started] get failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** 附在 atlas_list_predictions 结果后面的一段；没有记录就返回 undefined。 */
export function describeNotStarted(entries: NotStarted[]): string | undefined {
  if (entries.length === 0) return undefined;
  return [
    "Confirmed in the last hour but did not start, so these are not in the list above and nothing was charged:",
    ...entries.map((entry) => `- ${entry.at} — ${entry.model}: ${entry.reason}`),
    "If the user asks about one of these, tell them why it did not start. Running it again fails the same way until that changes (for example a top-up, or another model).",
  ].join("\n");
}
