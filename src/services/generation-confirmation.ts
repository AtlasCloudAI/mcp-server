import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { ModelPrice } from "../types.js";
import { type StoredRecord, idempotencyFingerprint, peekIdempotent, storedPredictionId } from "./idempotency.js";
import { getRequestContext } from "./request-context.js";
import { annotateToolCall } from "./tool-call-telemetry.js";
import { InMemoryUploadTicketStore, type UploadTicketStore } from "./upload-ticket-store.js";

const localConfirmationSecret = randomBytes(32).toString("base64url");

const confirmationPayloadSchema = z.object({
  version: z.literal(1),
  subject_hash: z.string().regex(/^[a-f0-9]{64}$/),
  tool_name: z.string().min(1).max(128),
  idempotency_key: z.string().uuid(),
  request_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pricing_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.number().int().positive(),
});

export type ConfirmedModelPrice = ModelPrice & {
  actual: NonNullable<ModelPrice["actual"]>;
};

export interface GenerationConfirmationQuote {
  /**
   * 原样回给调用方。确认提交必须带同一个幂等键，但 Codex 的模型常在 JavaScript 单元里
   * 随手生成一个、存进局部变量，自己从没看到过这个值；下一轮确认时就拿不出来，只能
   * 重新报价（2026-10-20 生产实测）。报价里写明这个值，模型照抄即可。
   */
  idempotencyKey: string;
  confirmationToken: string;
  expiresAt: string;
  pricing: ConfirmedModelPrice;
  /**
   * 同样的请求已经提交过（卡片上确认过、或模型确认过）：这份报价沿用那一单的幂等键，确认时拿回那一单，
   * 不会再建一单、再扣一次（11-18 上线前审查 M5）。
   */
  alreadySubmitted?: AlreadySubmitted;
  /**
   * 同样的请求刚跑完（成功、失败、取消）：这份报价是再跑一次，确认就新建一单、再扣一次费（11-19 S2）。
   * 确认时必须带这份报价的令牌或幂等键；旧令牌、旧键、什么都不带都不会落到这份报价上。
   */
  repeatOf?: AlreadySubmitted;
}

export interface AlreadySubmitted {
  /** submitted：拿到了任务号；in_progress：提交还没回来；unconfirmed：没拿到确定答复，可能在跑也可能没有。 */
  status: "submitted" | "in_progress" | "unconfirmed";
  submittedAt: string;
  predictionId?: string;
}

export class GenerationConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationConfirmationError";
  }
}

function currentPricing(price: ModelPrice | undefined): ConfirmedModelPrice {
  if (!price?.actual || Object.values(price.actual).every((value) => !value)) {
    throw new GenerationConfirmationError(
      "Current pricing metadata is unavailable for this model. No billable request was submitted."
    );
  }
  return {
    ...(price.discount ? { discount: price.discount } : {}),
    actual: { ...price.actual },
    ...(price.origin ? { origin: { ...price.origin } } : {}),
  };
}

function subjectHash(subject: string): string {
  return createHash("sha256").update(subject).digest("hex");
}

function runtime(): {
  subject: string;
  secret: string;
  ttlSeconds: number;
} {
  const context = getRequestContext();
  return {
    subject: context?.subject ?? "stdio",
    secret:
      context?.generationConfirmationSecret ??
      process.env.MCP_GENERATION_CONFIRMATION_SECRET ??
      localConfirmationSecret,
    ttlSeconds: context?.generationConfirmationTtlSeconds ?? 3600,
  };
}

function fingerprints(
  request: Record<string, unknown>,
  pricing: ModelPrice
): { requestFingerprint: string; pricingFingerprint: string } {
  return {
    requestFingerprint: idempotencyFingerprint(request),
    pricingFingerprint: idempotencyFingerprint({ pricing }),
  };
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export async function issueGenerationConfirmation(
  toolName: string,
  idempotencyKey: string,
  request: Record<string, unknown>,
  modelPrice: ModelPrice | undefined
): Promise<GenerationConfirmationQuote> {
  const chosen = await unusedIdempotencyKey(toolName, idempotencyKey, request);
  idempotencyKey = chosen.idempotencyKey;
  // 只报价、没提交：这是正常的第一步，不是错误。取值沿用 CLI 的 estimate。
  annotateToolCall({ execution_mode: "estimate", stage: "quote" });
  const pricing = currentPricing(modelPrice);
  const { subject, secret, ttlSeconds } = runtime();
  const { requestFingerprint, pricingFingerprint } = fingerprints(
    request,
    pricing
  );
  const expiresAt = Date.now() + ttlSeconds * 1000;
  await rememberQuote(
    quoteKey(subjectHash(subject), toolName, requestFingerprint, pricingFingerprint),
    { idempotencyKey, expiresAt, ...(chosen.repeatOfKey ? { repeatOf: chosen.repeatOfKey } : {}) },
    ttlSeconds
  );
  return {
    confirmationToken: compactToken(
      {
        subjectHash: subjectHash(subject),
        toolName,
        idempotencyKey,
        requestFingerprint,
        pricingFingerprint,
      },
      expiresAt,
      secret
    ),
    expiresAt: new Date(expiresAt).toISOString(),
    pricing,
    idempotencyKey,
    ...(chosen.alreadySubmitted ? { alreadySubmitted: chosen.alreadySubmitted } : {}),
    ...(chosen.repeatOf ? { repeatOf: chosen.repeatOf } : {}),
  };
}

/**
 * 报价用哪个幂等键。
 *
 * - 键已经提交过另一单（参数不同）：换新键。模型常拿示例 UUID 当键，和自己以前用过的撞上，确认时才报冲突，
 *   用户只好再确认一轮（11-04 问题 51）。换掉的键写进报价结果；确认时模型就算还传旧键，也按报价记录找回新键。
 * - 键被上游拒收过（rejected，比如余额不足）或报价作废了（canceled）：换新键。原来参数相同就沿用，充值后
 *   重新报价拿到的还是那个被拒过的键，确认一次被拒一次（11-18 上线前审查 M4）。
 * - 参数相同、已经提交过（拿到任务号、还在提交、结果不确定）：沿用原键，确认时拿回原来那一单，不重复扣钱。
 * - 调用方没带键或带了个新键，但同一用户、同一工具、同样参数刚提交过（SAME_JOB_WINDOW_SECONDS 内）：也沿用
 *   那一单的键，并在报价里写明已经提交过（11-18 上线前审查 M5：卡片上已确认过，模型不知道，又报一次价拿到
 *   新键，用户再点确认就成了第二单）。atlas_chat 不在此列：同一句话再问一遍是正常用法。
 *   那一单已经跑完（成功、失败、取消）就不再沿用：用户说「再来一张」或重试失败的单是正常需求（11-19 增量
 *   审查 S2）。查不到状态时按还在跑处理，宁可多问一句也不重复扣费。
 */
async function unusedIdempotencyKey(
  toolName: string,
  idempotencyKey: string,
  request: Record<string, unknown>
): Promise<ChosenKey> {
  const fingerprint = idempotencyFingerprint(request);
  // 两样并行查：报价记录存储挂住时（Redis 断线）报价最多多等一次超时。
  const [record, recent] = await Promise.all([
    peekIdempotent(toolName, idempotencyKey).catch(() => undefined),
    recentSubmission(toolName, fingerprint),
  ]);
  const recentOther = recent && recent.idempotencyKey !== idempotencyKey ? recent : undefined;
  // 同样的请求最近一单可能还在跑：沿用那一单（M5）。先看它，调用方的键对应的旧单就算已经跑完，
  // 也不能把正在跑的那一单漏掉（11-19 第二轮复审）。
  if (recentOther && recentOther.ageMs <= SAME_JOB_WINDOW_SECONDS * 1000 && !(await jobFinished(recentOther.alreadySubmitted))) {
    return { idempotencyKey: recentOther.idempotencyKey, alreadySubmitted: recentOther.alreadySubmitted };
  }
  if (record && record.fingerprint === fingerprint) {
    const submitted = alreadySubmittedOf(record);
    if (submitted) {
      // 同一个键、那一单已经跑完：这是再跑一次，换新键（S2，模型常沿用上一次的键）。
      if (await jobFinished(submitted)) return { idempotencyKey: randomUUID(), repeatOf: submitted, repeatOfKey: idempotencyKey };
      return { idempotencyKey, alreadySubmitted: submitted };
    }
  }
  const usable = !record || (record.fingerprint === fingerprint && record.state !== "rejected" && record.state !== "canceled");
  const chosenKey = usable ? idempotencyKey : randomUUID();
  // 同样的请求之前提交过（已经跑完，或超过了沿用的时间窗）：这份报价是再跑一次，标出来，
  // 确认时只认明确指向它的确认（S2）。
  if (recentOther) return { idempotencyKey: chosenKey, repeatOf: recentOther.alreadySubmitted, repeatOfKey: recentOther.idempotencyKey };
  return { idempotencyKey: chosenKey };
}

interface ChosenKey {
  idempotencyKey: string;
  alreadySubmitted?: AlreadySubmitted;
  /** 上一单已经跑完，这份报价是再跑一次：上一单的情况和它的幂等键。 */
  repeatOf?: AlreadySubmitted;
  repeatOfKey?: string;
}

/** 那一单确定已经跑完。没有任务号（还在提交、结果不确定）一律不算。 */
async function jobFinished(submitted: AlreadySubmitted): Promise<boolean> {
  return submitted.status === "submitted" && submitted.predictionId !== undefined && predictionFinished(submitted.predictionId);
}

function alreadySubmittedOf(record: StoredRecord<unknown>): AlreadySubmitted | undefined {
  const submittedAt = new Date(record.createdAt).toISOString();
  if (record.state === "completed") {
    const predictionId = storedPredictionId(record.result);
    return predictionId ? { status: "submitted", submittedAt, predictionId } : { status: "unconfirmed", submittedAt };
  }
  if (record.state === "pending") return { status: "in_progress", submittedAt };
  if (record.state === "uncertain") return { status: "unconfirmed", submittedAt };
  return undefined;
}

// ---- 最近提交过的请求（M5）----
//
// 「同一用户 + 工具 + 请求指纹 → 最近一次确认用的幂等键」。确认时记（resolveConfirmedIdempotencyKey），
// 报价时查；这一单现在是什么状态再去幂等记录里看（被拒收、作废的不算）。只留一小段时间：隔久了用户
// 想把同样的请求再跑一次是正常的。
const SAME_JOB_WINDOW_SECONDS = 15 * 60;
const SAME_JOB_EXEMPT_TOOLS = new Set(["atlas_chat"]);

function submissionIndexKey(subject: string, toolName: string, requestFingerprint: string): string {
  return `submitted:${createHash("sha256").update([subjectHash(subject), toolName, requestFingerprint].join("\n")).digest("hex")}`;
}

async function rememberSubmission(toolName: string, requestFingerprint: string, idempotencyKey: string): Promise<void> {
  if (SAME_JOB_EXEMPT_TOOLS.has(toolName)) return;
  const { subject, ttlSeconds } = runtime();
  try {
    // 记到「确认还可能来」的时候为止（确认有效期 + 沿用时间窗）：超过 15 分钟的旧确认也要认得出是哪一单
    // （11-19 第二轮复审）。沿用旧单只看前 15 分钟（recentSubmission 的 ageMs）。
    await withTimeout(
      quoteStore().put(
        submissionIndexKey(subject, toolName, requestFingerprint),
        JSON.stringify({ key: idempotencyKey, at: Date.now() }),
        SAME_JOB_WINDOW_SECONDS + ttlSeconds
      ),
      QUOTE_STORE_TIMEOUT_MS
    );
  } catch (error) {
    console.error(`[quote-store] submission put failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function recentSubmission(
  toolName: string,
  requestFingerprint: string
): Promise<{ idempotencyKey: string; alreadySubmitted: AlreadySubmitted; ageMs: number } | undefined> {
  const entry = await submissionIndexEntry(toolName, requestFingerprint);
  if (!entry) return undefined;
  try {
    const record = await peekIdempotent(toolName, entry.key);
    if (!record || record.fingerprint !== requestFingerprint) return undefined;
    const alreadySubmitted = alreadySubmittedOf(record);
    return alreadySubmitted ? { idempotencyKey: entry.key, alreadySubmitted, ageMs: Date.now() - entry.at } : undefined;
  } catch (error) {
    console.error(`[quote-store] submission get failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** 同一用户、工具、参数最近一次确认用的键和时间。老格式（只存了键）按刚记下处理。 */
async function submissionIndexEntry(toolName: string, requestFingerprint: string): Promise<{ key: string; at: number } | undefined> {
  if (SAME_JOB_EXEMPT_TOOLS.has(toolName)) return undefined;
  const { subject } = runtime();
  try {
    const raw = await withTimeout(quoteStore().get(submissionIndexKey(subject, toolName, requestFingerprint)), QUOTE_STORE_TIMEOUT_MS);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { key?: unknown; at?: unknown };
      if (parsed && typeof parsed.key === "string") return { key: parsed.key, at: typeof parsed.at === "number" ? parsed.at : Date.now() };
    } catch {
      // 老格式：值就是键
    }
    return { key: raw, at: Date.now() };
  } catch (error) {
    console.error(`[quote-store] submission get failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

// 任务已经结束的状态。没列出的（包括查不到、没状态、新出现的写法）一律按还在跑：沿用原键最多让用户
// 多确认一次，误判成结束则可能重复扣费。
const FINISHED_STATUSES = new Set([
  "completed",
  "succeeded",
  "success",
  "failed",
  "error",
  "canceled",
  "cancelled",
  "timeout",
  "timed_out",
  "expired",
]);
const PREDICTION_STATUS_TIMEOUT_MS = 3_000;

type PredictionStatusLookup = (predictionId: string) => Promise<string | undefined>;

async function lookupPredictionStatus(predictionId: string): Promise<string | undefined> {
  // 用到时才加载：在模块顶部引入 api-client 会和 response-schemas 形成循环引用，启动时报未初始化。
  const { generationApi } = await import("./api-client.js");
  const result = await generationApi<{ data?: { status?: unknown }; status?: unknown }>(
    `/model/prediction/${encodeURIComponent(predictionId)}`,
    { timeout: PREDICTION_STATUS_TIMEOUT_MS, maxRetries: 0 }
  );
  // 网关有带 data 包装和不带两种外形（response-schemas 的 predictionResponseSchema 两种都认）。
  const status = result?.data && typeof result.data === "object" ? result.data.status : result?.status;
  return typeof status === "string" ? status : undefined;
}

let predictionStatusLookup: PredictionStatusLookup = lookupPredictionStatus;

/** 只给测试用：换掉查任务状态的实现（不传则恢复默认）。 */
export function setPredictionStatusLookupForTests(lookup?: PredictionStatusLookup): void {
  predictionStatusLookup = lookup ?? lookupPredictionStatus;
}

async function predictionFinished(predictionId: string): Promise<boolean> {
  try {
    const status = await withTimeout(predictionStatusLookup(predictionId), PREDICTION_STATUS_TIMEOUT_MS + 500);
    return typeof status === "string" && FINISHED_STATUSES.has(status.trim().toLowerCase());
  } catch {
    return false;
  }
}

/** 接在报价文字里幂等键那几行后面：没提交过就是空串。 */
export function alreadySubmittedLine(confirmation: { alreadySubmitted?: AlreadySubmitted; repeatOf?: AlreadySubmitted }): string {
  const notice = alreadySubmittedNotice(confirmation.alreadySubmitted) || repeatNotice(confirmation.repeatOf);
  return notice ? `${notice}\n` : "";
}

/** 报价结果里那一行：同样的请求刚跑完，这份报价是再跑一次，确认会再扣一次费（S2）。 */
export function repeatNotice(previous: AlreadySubmitted | undefined): string {
  if (!previous) return "";
  return (
    `- **Runs again**: the same request (same model and parameters) was already submitted at ${previous.submittedAt}` +
    `${previous.predictionId ? ` as prediction ${previous.predictionId}` : ""}. Confirming this quote starts a new ` +
    `job and is charged again. Tell the user, and confirm only if they want another run; to see the earlier result, ` +
    `use atlas_get_prediction${previous.predictionId ? "" : " or atlas_list_predictions"} instead.`
  );
}

/** 报价结果里那一行：同样的请求已经提交过，确认会拿回那一单。 */
export function alreadySubmittedNotice(submitted: AlreadySubmitted | undefined): string {
  if (!submitted) return "";
  const what =
    submitted.status === "submitted"
      ? `was already submitted at ${submitted.submittedAt} as prediction ${submitted.predictionId}`
      : submitted.status === "in_progress"
        ? `is already being submitted (started at ${submitted.submittedAt})`
        : `was already submitted at ${submitted.submittedAt}, but Atlas Cloud did not confirm whether it started`;
  return (
    `- **Already submitted**: the same request (same model and parameters) ${what}. This quote keeps that ` +
    `job's idempotency_key, so confirming it returns that job instead of starting and billing a second one. ` +
    (submitted.predictionId
      ? `Check it with atlas_get_prediction and tell the user. `
      : `Check atlas_list_predictions for it and tell the user before anything else. `) +
    `If the user really wants another run of the same request, change an argument (for example the prompt or a seed) and quote again.`
  );
}

// 令牌只带版本、过期时间和一段 128 位的签名，其余（用户、工具、幂等键、请求与价格指纹）
// 由服务端在校验时从当前请求重新算出。旧格式把整段 JSON 编进令牌，长约 570 个字符，
// 2026-10-19 在 test 上实测模型回传时抄丢了一个字符，用户被迫二次确认。现在约 35 个字符。
const COMPACT_PREFIX = "c2";

interface TokenFacts {
  subjectHash: string;
  toolName: string;
  idempotencyKey: string;
  requestFingerprint: string;
  pricingFingerprint: string;
}

function compactMac(facts: TokenFacts, expiresAt: number, secret: string): string {
  const material = JSON.stringify([
    COMPACT_PREFIX,
    facts.subjectHash,
    facts.toolName,
    facts.idempotencyKey,
    facts.requestFingerprint,
    facts.pricingFingerprint,
    expiresAt,
  ]);
  return createHmac("sha256", secret).update(material).digest().subarray(0, 16).toString("base64url");
}

function compactToken(facts: TokenFacts, expiresAt: number, secret: string): string {
  return `${COMPACT_PREFIX}.${expiresAt.toString(36)}.${compactMac(facts, expiresAt, secret)}`;
}

const INVALID =
  "Generation confirmation is invalid. Request a new quote. No billable request was submitted.";

function verifyCompact(token: string, facts: TokenFacts, secret: string): void {
  const [, expPart, mac, extra] = token.split(".");
  if (!expPart || !mac || extra !== undefined || !/^[0-9a-z]+$/.test(expPart)) {
    throw new GenerationConfirmationError(INVALID);
  }
  const expiresAt = Number.parseInt(expPart, 36);
  if (!Number.isSafeInteger(expiresAt)) throw new GenerationConfirmationError(INVALID);
  const expected = Buffer.from(compactMac(facts, expiresAt, secret));
  const received = Buffer.from(mac);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    // The facts are recomputed from this request, so a mismatch means the request,
    // price or user changed — or the token was copied incorrectly.
    throw new GenerationConfirmationError(
      "Generation confirmation does not match this request: the arguments, price or user changed, " +
        "or the token was not copied exactly. Request a new quote. No billable request was submitted."
    );
  }
  if (expiresAt <= Date.now()) {
    throw new GenerationConfirmationError(
      "Generation confirmation expired. Request a new quote. No billable request was submitted."
    );
  }
}

/**
 * 报价记录。
 *
 * 确认流程原本全靠模型把两样东西原样带回来：确认令牌和幂等键。实测模型抄不准随机字符串，
 * 而且问题一再换个样子出现：570 字符的令牌抄错（2.9.2 压短），34 字符的令牌照样少抄 3 个
 * （2026-10-20 生产，模型还据此断定"令牌格式有问题"放弃了），幂等键在 Codex 的 JavaScript
 * 单元里随手生成、模型自己没看见，确认时拿不出来（同日生产，用户被迫确认两次）。
 *
 * 所以服务端在报价时记一笔：同一用户、同一工具、同样参数、同样价格 → 当时的幂等键。确认时
 * 令牌对得上就照旧；对不上或没带，就按这四样找回报价。约束和令牌一样：必须先给这个用户报过
 * 这一单的价，参数或价格一变就找不到。找回的是当时的幂等键，所以重复确认也只提交一次。
 */
const localQuotes = new InMemoryUploadTicketStore();

function quoteStore(): UploadTicketStore {
  return getRequestContext()?.quoteStore ?? localQuotes;
}

function quoteKey(
  subjectDigest: string,
  toolName: string,
  requestFingerprint: string,
  pricingFingerprint: string
): string {
  return createHash("sha256")
    .update([subjectDigest, toolName, requestFingerprint, pricingFingerprint].join("\n"))
    .digest("hex");
}

interface QuoteRecord {
  idempotencyKey: string;
  expiresAt: number;
  /** 这份报价是再跑一次已经跑完的请求：上一单的幂等键（S2）。 */
  repeatOf?: string;
}

// node-redis 断线重连期间命令会排队、不报错，await 会一直挂着；报价本身不该被它拖住。
const QUOTE_STORE_TIMEOUT_MS = 800;

function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`quote store timed out after ${ms}ms`)), ms);
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

async function rememberQuote(key: string, record: QuoteRecord, ttlSeconds: number): Promise<void> {
  // 记不下来不影响报价本身：令牌那条路照样能确认。
  try {
    await withTimeout(quoteStore().put(key, JSON.stringify(record), ttlSeconds), QUOTE_STORE_TIMEOUT_MS);
  } catch (error) {
    console.error(`[quote-store] put failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function recallQuote(key: string): Promise<QuoteRecord | null> {
  try {
    const raw = await withTimeout(quoteStore().get(key), QUOTE_STORE_TIMEOUT_MS);
    if (!raw) return null;
    const record = JSON.parse(raw) as QuoteRecord;
    return record.expiresAt > Date.now() && typeof record.idempotencyKey === "string" ? record : null;
  } catch (error) {
    console.error(`[quote-store] get failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export interface ConfirmedKey {
  idempotencyKey: string;
  /** 用的是报价记录里的键、和调用方传来的不一样时，提醒模型这可能返回已有任务。 */
  notice?: string;
}

/**
 * 用户确认后的那次调用：决定这一单用哪个幂等键提交。
 *
 * 有报价记录就一律用记录里的键，令牌只在没有记录时起作用。否则会两条路各提交一次：同一组
 * 参数先后报价两次（键 K1、K2，记录被覆盖成 K2），用 K1 的令牌确认提交了一单，模型再重试时
 * 令牌抄错，按记录找回 K2 又提交一单（2026-10-20 审查实测）。现在同一用户、工具、请求、价格
 * 只落到一个键上，重复确认由幂等存储挡掉。
 *
 * 没有记录（例如存储不可用）时退回令牌校验；两样都不成立才报错，并优先报令牌自己的错误
 * （例如已过期），让模型知道该重新报价。
 */
export async function resolveConfirmedIdempotencyKey(
  token: string | undefined,
  toolName: string,
  idempotencyKey: string | undefined,
  request: Record<string, unknown>,
  modelPrice: ModelPrice | undefined
): Promise<ConfirmedKey> {
  const pricing = currentPricing(modelPrice);
  const { subject } = runtime();
  const { requestFingerprint, pricingFingerprint } = fingerprints(request, pricing);
  const record = await recallQuote(
    quoteKey(subjectHash(subject), toolName, requestFingerprint, pricingFingerprint)
  );
  if (record) {
    // 报价记录指向的键被上游拒收过（余额不足之类）：这份报价不能再确认，换回那个键只会再被拒一次。
    // 原来模型带着新键来确认，也会按记录换回旧键，充值后怎么确认都卡在「换新键」（11-18 上线前审查 M4）。
    // 卡片认 "rejected by Atlas Cloud before it started" 这几个词，会换新键重新报价。
    const state = (await peekIdempotent(toolName, record.idempotencyKey).catch(() => undefined))?.state;
    if (state === "rejected") {
      throw new GenerationConfirmationError(
        "The earlier quote for these exact arguments was rejected by Atlas Cloud before it started, so nothing " +
          "was charged and that quote can't be confirmed again. Call again without confirmed or confirmation_token " +
          "to get a new quote, show it to the user, and wait for their confirmation. No billable request was submitted."
      );
    }
    // 调用方指的不是最新这份报价（带的是更早报价的令牌或键）：那份更早的报价已经用同样的参数提交过，
    // 就拿回那一单，绝不落到最新这份报价上另扣一次（11-19 复审：旧令牌、旧键会被换成新报价的键）。
    // 认不出的令牌（模型抄错）、模型自己编的键，照旧按报价记录找回最新这份。
    const confirmsThisQuote =
      record.idempotencyKey === idempotencyKey ||
      (token !== undefined && tokenFits(token, toolName, record.idempotencyKey, request, modelPrice));
    if (!confirmsThisQuote) {
      const earlier = await earlierSubmission(toolName, token, idempotencyKey, record, requestFingerprint, request, modelPrice);
      if (earlier === "missing") {
        throw new GenerationConfirmationError(
          "This confirmation belongs to an earlier quote for these exact arguments whose job can no longer be looked " +
            "up, so it can't be confirmed again. Call again without confirmed or confirmation_token to get a new quote, " +
            "show it to the user, and wait for their confirmation. No billable request was submitted."
        );
      }
      if (earlier) {
        return {
          idempotencyKey: earlier.key,
          notice:
            `Note: this confirmation belongs to an earlier quote for these exact arguments, which was already ` +
            `submitted${earlier.predictionId ? ` as prediction ${earlier.predictionId}` : ""}, so that job is returned ` +
            `and nothing new was generated or charged. The latest quote (idempotency_key ${record.idempotencyKey}) ` +
            `runs the request again and is charged again; confirm it with that key or its confirmation_token only if ` +
            `the user wants another run.`,
        };
      }
      // 最新这份报价是「再跑一次」：没明确指向它的确认一律不算（什么都不带、带了认不出的令牌或别的键）。
      if (record.repeatOf) {
        throw new GenerationConfirmationError(
          `The latest quote for these exact arguments runs a request that was already submitted, so confirming it ` +
            `starts and bills a new job. Confirm it with that quote's idempotency_key (${record.idempotencyKey}) or its ` +
            `confirmation_token, and only after the user agrees to another run. No billable request was submitted.`
        );
      }
    }
    // 不等它写完：记不下来只是少一层防重，不能拖住确认（内存和 Redis 的写都在调用时就发出了）。
    void rememberSubmission(toolName, requestFingerprint, record.idempotencyKey);
    // 幂等键现在可以不传（服务端在报价时生成）：没带就用报价记录里那个，不算「换了一单」。
    if (idempotencyKey === undefined || record.idempotencyKey === idempotencyKey) {
      return { idempotencyKey: record.idempotencyKey };
    }
    return {
      idempotencyKey: record.idempotencyKey,
      notice:
        `Note: this confirmed the latest quote for these exact arguments, whose idempotency_key is ` +
        `${record.idempotencyKey} (not the key you sent). If that quote was already submitted, the existing ` +
        `job is returned and nothing new was generated or charged.`,
    };
  }
  if (token && idempotencyKey !== undefined) {
    verifyGenerationConfirmation(token, toolName, idempotencyKey, request, modelPrice);
    void rememberSubmission(toolName, requestFingerprint, idempotencyKey);
    return { idempotencyKey };
  }
  throw new GenerationConfirmationError(
    "No quote was found for these exact arguments and current price. Call again without " +
      "confirmed or confirmation_token to get a quote, show it to the user, and wait for their " +
      "confirmation. No billable request was submitted."
  );
}

/**
 * 调用方的确认指向的那份更早的报价，如果它已经用同样的参数提交过：返回那一单的键。
 * 候选：调用方带的键、最新报价记下的上一单（repeatOf）、最近一次确认的键；令牌能对上或键相同才算指向它。
 * 指向的是 repeatOf 那一单、但它的提交记录已经过期：返回 "missing"，不能拿这个键重新提交一单。
 */
async function earlierSubmission(
  toolName: string,
  token: string | undefined,
  idempotencyKey: string | undefined,
  record: QuoteRecord,
  requestFingerprint: string,
  request: Record<string, unknown>,
  modelPrice: ModelPrice | undefined
): Promise<{ key: string; predictionId?: string } | "missing" | undefined> {
  const indexed = (await submissionIndexEntry(toolName, requestFingerprint))?.key;
  const candidates = [...new Set([idempotencyKey, record.repeatOf, indexed])].filter(
    (key): key is string => typeof key === "string" && key !== record.idempotencyKey
  );
  for (const key of candidates) {
    const named = key === idempotencyKey || (token !== undefined && tokenFits(token, toolName, key, request, modelPrice));
    if (!named) continue;
    const earlier = await peekIdempotent(toolName, key).catch(() => undefined);
    const submitted = earlier && earlier.fingerprint === requestFingerprint ? alreadySubmittedOf(earlier) : undefined;
    if (submitted) return { key, ...(submitted.predictionId ? { predictionId: submitted.predictionId } : {}) };
    if (key === record.repeatOf) return "missing";
  }
  return undefined;
}

/** 令牌是不是给这个幂等键、这组参数、这个价格签的（不抛错，只回是否）。 */
function tokenFits(
  token: string,
  toolName: string,
  idempotencyKey: string,
  request: Record<string, unknown>,
  modelPrice: ModelPrice | undefined
): boolean {
  try {
    verifyGenerationConfirmation(token, toolName, idempotencyKey, request, modelPrice);
    return true;
  } catch {
    return false;
  }
}

export function verifyGenerationConfirmation(
  token: string,
  toolName: string,
  idempotencyKey: string,
  request: Record<string, unknown>,
  modelPrice: ModelPrice | undefined
): void {
  const pricing = currentPricing(modelPrice);
  const { subject, secret } = runtime();
  if (token.startsWith(`${COMPACT_PREFIX}.`)) {
    const { requestFingerprint, pricingFingerprint } = fingerprints(request, pricing);
    verifyCompact(
      token,
      { subjectHash: subjectHash(subject), toolName, idempotencyKey, requestFingerprint, pricingFingerprint },
      secret
    );
    return;
  }
  // Legacy JSON tokens issued before the compact format, still honoured until they expire.
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    throw new GenerationConfirmationError(
      "Generation confirmation is invalid. Request a new quote. No billable request was submitted."
    );
  }

  const expectedSignature = Buffer.from(sign(encodedPayload, secret));
  const receivedSignature = Buffer.from(encodedSignature);
  if (
    expectedSignature.length !== receivedSignature.length ||
    !timingSafeEqual(expectedSignature, receivedSignature)
  ) {
    throw new GenerationConfirmationError(
      "Generation confirmation is invalid. Request a new quote. No billable request was submitted."
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );
  } catch {
    throw new GenerationConfirmationError(
      "Generation confirmation is invalid. Request a new quote. No billable request was submitted."
    );
  }
  const parsed = confirmationPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new GenerationConfirmationError(
      "Generation confirmation is invalid. Request a new quote. No billable request was submitted."
    );
  }
  if (parsed.data.expires_at <= Date.now()) {
    throw new GenerationConfirmationError(
      "Generation confirmation expired. Request a new quote. No billable request was submitted."
    );
  }

  const { requestFingerprint, pricingFingerprint } = fingerprints(
    request,
    pricing
  );
  const matches =
    parsed.data.subject_hash === subjectHash(subject) &&
    parsed.data.tool_name === toolName &&
    parsed.data.idempotency_key === idempotencyKey &&
    parsed.data.request_fingerprint === requestFingerprint &&
    parsed.data.pricing_fingerprint === pricingFingerprint;
  if (!matches) {
    throw new GenerationConfirmationError(
      "Generation confirmation does not match the current user, tool, idempotency key, request, or pricing. Request a new quote. No billable request was submitted."
    );
  }
}

export function formatGenerationPricing(pricing: ModelPrice): string {
  const labels: Record<string, string> = {
    input_price: "input price per million tokens",
    output_price: "output price per million tokens",
    cache_price: "cached-input price per million tokens",
    cache_creation_price: "cache-write price per million tokens",
    output_image_price: "price per output image",
    request_price: "price per request",
    base_price: "starting rate per billing unit (not this request's total)",
  };
  const parts = Object.entries(pricing.actual ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
    .map(([field, value]) => `${labels[field] ?? field}: $${value}`);
  for (const tier of pricing.actual?.prompt_thresholds ?? []) {
    if (typeof tier.threshold !== "number") continue;
    const rates = [
      tier.input_price ? `input $${tier.input_price}` : "",
      tier.output_price ? `output $${tier.output_price}` : "",
    ].filter(Boolean);
    if (rates.length) parts.push(`above ${tier.threshold} input tokens: ${rates.join(", ")} per million tokens`);
  }
  if (pricing.discount && pricing.discount !== "100") {
    parts.push(`catalog discount: ${pricing.discount}%`);
  }
  return parts.join("; ");
}
