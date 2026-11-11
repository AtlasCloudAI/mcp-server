// 卡片数据：服务端放在工具结果 _meta["atlascloud/card"] 里（见 src/apps/generation-card.ts）。
// 宿主没把 _meta 转过来时，从 structuredContent 推一份够用的。这里只放纯函数，测试直接引。

import { inputsOf, kindFromField, promptOf, settingsChips } from "../../src/apps/card-params.js";

export type CardMediaKind = "image" | "video" | "audio" | "3d" | "other";

export interface CardMedia {
  url: string;
  kind: CardMediaKind;
}

export type CardState =
  | "quote"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "transfer_pending";

/** 报价卡确认要的东西，见 src/apps/generation-card.ts 的 QuoteInfo。 */
export interface QuoteInfo {
  tool: string;
  arguments: Record<string, unknown>;
  idempotency_key: string;
  confirmation_token: string;
  expires_at?: string;
  estimated_usd?: number;
  partial?: boolean;
  /** 按实际用量结算，最终扣费可能和预估略有出入。 */
  settles_on_usage?: boolean;
  /** 不完整的预估漏掉了什么（服务端给的说法）。 */
  estimate_missing?: string[];
  /** 扣费账户和可用余额；查不到就没有。 */
  account?: { name: string; email?: string; type?: string; balance_usd?: number };
  /** 这一单要生成什么（提示词，截断过）。 */
  prompt?: string;
  /** 这一单引用的素材：缩略图、名称和来源（资产库 / 上传卡 / 对话附件，查不到就没有）。 */
  inputs?: (CardMedia & { name: string; source?: "library" | "upload" | "chat" })[];
  settings: string[];
  /** 报价有效多久（秒），过期时告诉用户「报价 N 分钟内有效」。 */
  valid_seconds?: number;
  /** 只在测试卡片上用：直接显示某个问题状态。 */
  problem?: QuoteProblem;
  /** 只在测试卡片上用：余额不足、价格变了时显示的示例数字。 */
  sample_balance_usd?: number;
  sample_previous_usd?: number;
  /** 只在测试卡片上用：「素材失效」里被删掉的文件名。 */
  sample_missing?: string[];
}

export type QuoteProblem =
  | "insufficient_balance"
  | "price_changed"
  | "settings_changed"
  | "rate_limited"
  | "model_unavailable"
  | "input_missing"
  | "signed_out"
  // 下面三个只为自测：点了确认之后的几个过渡状态，正常只会在点击后出现，样例里直接摆出来好截图。
  | "submitting"
  | "verifying"
  | "uncertain"
  | "in_progress";

export interface CardData {
  state: CardState;
  prediction_id: string;
  model_id?: string;
  model_name?: string;
  model_type?: string;
  price_usd?: number;
  /** 主要参数小标签（1080p · 10 s · 16:9）。 */
  settings?: string[];
  /** charged / partially_charged / pending / not_charged / refunded，见 src/apps/generation-card.ts。 */
  charge_status?: string;
  media: CardMedia[];
  error?: string;
  open_url?: string;
  submitted_at?: string;
  completed_at?: string;
  media_expired?: boolean;
  sample?: boolean;
  /** 只在测试卡片上用：直接显示「需要重新连接」。 */
  sample_signed_out?: boolean;
  /** 测试卡片：显示「Still generating」（卡片自己等太久之后的样子）。 */
  sample_stalled?: boolean;
  quote?: QuoteInfo;
  retry?: { tool: string; arguments: Record<string, unknown> };
}

export const CARD_META_KEY = "atlascloud/card";
const SITE_URL = "https://www.atlascloud.ai";

/**
 * 充值页跟着卡片所在的环境走：服务端给的 open_url 是这个环境的官网（test 是 www.test.atlascloud.ai），
 * 取它的 origin 拼 /console/billing；没有时用生产官网。
 */
export function billingUrlFor(openUrl: string | undefined): string {
  try {
    if (openUrl) return `${new URL(openUrl).origin}/console/billing`;
  } catch {
    // 地址不对：用默认的
  }
  return `${SITE_URL}/console/billing`;
}

const STATES = new Set<CardState>([
  "quote",
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "transfer_pending",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCardData(value: unknown): value is CardData {
  const r = record(value);
  return (
    !!r &&
    typeof r.prediction_id === "string" &&
    typeof r.state === "string" &&
    STATES.has(r.state as CardState) &&
    Array.isArray(r.media)
  );
}

const EXT_KIND: Record<string, CardMediaKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  avif: "image",
  bmp: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  m4v: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  flac: "audio",
  opus: "audio",
  glb: "3d",
  gltf: "3d",
  obj: "3d",
  usdz: "3d",
  fbx: "3d",
  stl: "3d",
  ply: "3d",
};

export function kindOfUrl(url: string): CardMediaKind {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // 相对路径之类，直接按字符串看扩展名
  }
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? "other";
}

function stateOf(status: string, transferPending: boolean): CardState {
  const s = status.toLowerCase();
  if (["completed", "succeeded", "success"].includes(s)) {
    return transferPending ? "transfer_pending" : "succeeded";
  }
  if (["queued", "created", "waiting"].includes(s)) return "queued";
  if (["submitted", "starting", "processing", "running", "pending", "in_progress"].includes(s)) return "running";
  if (s === "canceled" || s === "cancelled") return "canceled";
  return "failed";
}

const KIND_TYPE: Record<string, string> = { image: "Image", video: "Video", audio: "Audio" };

/** 宿主没把 _meta 转过来时，用报价的 structuredContent 加上本次调用的工具名和参数拼报价卡。 */
function quoteFromStructured(
  structured: Record<string, unknown>,
  call: { tool?: string; args?: Record<string, unknown> }
): CardData | undefined {
  if (structured.status !== "confirmation_required") return undefined;
  const token = structured.confirmation_token;
  const key = structured.idempotency_key;
  const seconds = typeof structured.confirmation_valid_seconds === "number" ? structured.confirmation_valid_seconds : 0;
  const args = Object.fromEntries(
    Object.entries(call.args ?? {}).filter(([name]) => !["confirmation_token", "confirmed", "idempotency_key"].includes(name))
  );
  // Cursor 不转 _meta，卡片只能从这里拼（11-05/06 实测：报价卡只剩标题和价格）。提示词、参数和输入素材按服务端
  // 同一套规则从报价里的实际参数取；工具没回参数时用这次调用的参数。素材名字没有服务端记的那么全，只看地址。
  const params = record(structured.params) ?? record(args.params) ?? args;
  const prompt = promptOf(params);
  const firstInput = Array.isArray(structured.input_images) ? record(structured.input_images[0]) : undefined;
  const settings = settingsChips(
    params,
    typeof firstInput?.ratio === "string" ? { ratio: firstInput.ratio } : undefined,
    typeof structured.kind === "string" ? structured.kind : undefined
  );
  const inputs = inputsOf(params).map(({ field, ...input }) => {
    const kind = kindOfUrl(input.url);
    return { ...input, kind: kind !== "other" ? kind : kindFromField(field) ?? kind };
  });
  return {
    state: "quote",
    prediction_id: "",
    media: [],
    ...(typeof structured.model_id === "string" ? { model_id: structured.model_id } : {}),
    ...(typeof structured.model_name === "string" ? { model_name: structured.model_name } : {}),
    ...(typeof structured.kind === "string" && KIND_TYPE[structured.kind] ? { model_type: KIND_TYPE[structured.kind] } : {}),
    open_url: SITE_URL,
    // 没有工具名就没法在卡里确认，只显示报价、请用户在对话里回复。
    ...(call.tool && typeof token === "string" && typeof key === "string"
      ? {
          quote: {
            tool: call.tool,
            arguments: args,
            idempotency_key: key,
            confirmation_token: token,
            ...(seconds > 0 ? { expires_at: new Date(Date.now() + seconds * 1000).toISOString(), valid_seconds: seconds } : {}),
            ...(typeof structured.estimated_cost_usd === "number" ? { estimated_usd: structured.estimated_cost_usd } : {}),
            ...(structured.estimate_partial === true ? { partial: true } : {}),
            ...(structured.estimate_reason === "settles_on_usage" ? { settles_on_usage: true } : {}),
            ...billingAccountOf(structured.billing_account),
            settings,
            ...(prompt ? { prompt } : {}),
            ...(inputs.length > 0 ? { inputs } : {}),
          },
        }
      : {}),
  };
}

// 不带邮箱：设计稿 v3（11-10）扣费行只写「名字 · Personal」，和服务端拼的报价卡一致。
function billingAccountOf(raw: unknown): { account?: { name: string; type?: string; balance_usd?: number } } {
  const account = record(raw);
  if (!account || typeof account.name !== "string") return {};
  return {
    account: {
      name: account.name,
      ...(typeof account.type === "string" ? { type: account.type } : {}),
      ...(typeof account.available_usd === "number" ? { balance_usd: account.available_usd } : {}),
    },
  };
}

/** 工具结果 → 卡片数据。认不出来返回 undefined。call 是这次调用的工具名和参数（报价兜底用）。 */
export function cardFromToolResult(
  result: unknown,
  call: { tool?: string; args?: Record<string, unknown> } = {}
): CardData | undefined {
  const r = record(result);
  if (!r) return undefined;
  const fromMeta = record(r._meta)?.[CARD_META_KEY];
  if (isCardData(fromMeta)) return fromMeta;
  const structured = record(r.structuredContent);
  if (!structured) return undefined;
  if (isCardData(structured.card)) return structured.card;
  const quote = quoteFromStructured(structured, call);
  if (quote) return quote;
  if (typeof structured.prediction_id !== "string" || typeof structured.status !== "string") {
    return undefined;
  }
  const urls = (value: unknown) =>
    Array.isArray(value) ? value.filter((u): u is string => typeof u === "string") : [];
  // 转存中 outputs 是空的，上游临时链接在 temporary_outputs，先拿来显示。
  const outputs = urls(structured.outputs).length > 0 ? urls(structured.outputs) : urls(structured.temporary_outputs);
  return {
    state: stateOf(structured.status, structured.transfer_pending === true),
    prediction_id: structured.prediction_id,
    media: outputs.map((url) => ({ url, kind: kindOfUrl(url) })),
    ...(typeof structured.error === "string" && structured.error ? { error: structured.error } : {}),
    ...(typeof structured.price_usd === "number" ? { price_usd: structured.price_usd } : {}),
    ...(typeof structured.charge_status === "string" ? { charge_status: structured.charge_status } : {}),
    open_url: SITE_URL,
  };
}

/** 被限流后至少等这么久再让用户重试（设计稿「Retry in 30 s」）。 */
export const RATE_LIMIT_WAIT_MS = 30_000;

// 失败原因分类：报价卡提交被拒、生成任务失败都按原话认这两种，各有自己的样子（设计稿「请求太频繁」「模型暂时不可用」）。

/** 被限流：服务端那句 "Rate limit exceeded"、上游的 429 / Too Many Requests。 */
export function isRateLimited(text: string | undefined): boolean {
  return !!text && /rate[\s_-]?limit|too many requests|\b429\b/i.test(text);
}

/**
 * 模型暂时用不了：网关没有这个模型的路由（"model[x/y] router not found"，test 上实测）、
 * 上游说模型下线、过载、没有可用通道。
 */
export function isModelUnavailable(text: string | undefined): boolean {
  return (
    !!text &&
    /router not found|no available (?:channel|provider|route)|\bmodel(?: is)? (?:temporarily |currently )?(?:unavailable|not available|disabled|offline|under maintenance)|server ?overloaded|\boverloaded\b|at capacity|service (?:is )?(?:temporarily )?unavailable/i.test(
      text
    )
  );
}

/**
 * Atlas 登录失效（设计稿 v2「需要重新连接」）。11-02 test 实测断开 ChatGPT 的连接之后：
 * - 第一次调用：交换来的令牌被后端拒了，工具报 handleError 那句 "credential … invalid or expired"；
 * - 之后的调用在服务端 HTTP 层就回 401，ChatGPT 自己弹「连接 Atlas Cloud Test」；用户取消时
 *   卡片收到的报错是 "Connector authorization required"。
 * 工具的报错只认这几种说法：上游模型报错里也会出现 401、Unauthorized，那不是用户掉线。
 * fromHost：宿主自己挡下的调用（请求没到工具），别的宿主说法未知，再加几种常见写法。
 */
export function isSignedOut(text: string | undefined, fromHost = false): boolean {
  if (!text) return false;
  if (
    /connector authorization required|invalid_token|reauthenticate|re-?authori[sz]e to link|not linked to an atlas cloud credential|atlas cloud credential[^.]*(?:invalid|expired)/i.test(
      text
    )
  ) {
    return true;
  }
  return fromHost && /\b401\b|unauthori[sz]ed|authentication required|login required|sign[- ]?in (?:has )?expired/i.test(text);
}

/** 「需要重新连接」各张卡底下那句：不是每个宿主都会自己弹出连接。 */
export const RECONNECT_NOTE = "If no sign-in window opens, reconnect Atlas Cloud in this app's settings, then press Reconnect.";

export function isActive(state: CardState): boolean {
  return state === "queued" || state === "running" || state === "transfer_pending";
}

export const KIND_LABEL: Record<CardMediaKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  "3d": "3D model",
  other: "File",
};

/** 进度卡标题开头的类型词：优先模型目录的类型，没有就看已有结果的类型。 */
export function typeLabel(card: CardData): string {
  if (card.model_type && card.model_type !== "Text") return card.model_type;
  const first = card.media[0];
  return first ? KIND_LABEL[first.kind] : "Generation";
}

/**
 * 目录里查不到名字的模型（比如 atlascloud/workflow/kling-video-effects/korean_baseball）：
 * 去掉厂商和 atlascloud/workflow 前缀，把 - _ / 换成空格、首字母大写。
 */
export function readableModelId(modelId: string): string {
  const parts = modelId.split("/").filter(Boolean);
  const rest = parts[0] === "atlascloud" ? parts.slice(parts[1] === "workflow" || parts[1] === "studio" ? 2 : 1) : parts.slice(1);
  const words = (rest.length > 0 ? rest : parts).join(" ").split(/[\s_-]+/).filter(Boolean);
  return words.map((word) => (/^v?\d/.test(word) ? word : word[0]!.toUpperCase() + word.slice(1))).join(" ") || modelId;
}

/** Marketing Studio 的模板（atlascloud/studio/*）：报价是整套模板的总价，进度卡写模板名。 */
export function isTemplate(card: Pick<CardData, "model_id">): boolean {
  return card.model_id?.startsWith("atlascloud/studio/") === true;
}

export function modelLabel(card: Pick<CardData, "model_name" | "model_id">): string {
  if (card.model_name) return card.model_name;
  return card.model_id ? readableModelId(card.model_id) : "Atlas Cloud";
}

/** 美元金额：1 美元以上两位小数（$1.51），以下最多四位、去掉多余的 0（$0.003、$0.2593）。 */
export function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  let text = value.toFixed(4).replace(/0+$/, "");
  const decimals = text.split(".")[1]?.length ?? 0;
  if (decimals < 2) text = value.toFixed(2);
  return `$${text}`;
}

/**
 * 同一个任务的开始时间只认最早的那个。工作流是多步的，查结果接口的 created_at 是当前这一步的开始时间，
 * 每换一步就往后跳，卡片上的「Running for」就跟着归零（验收问题 27，ChatGPT 里 Image ads 实测）。
 */
export function earliestTime(a: string | undefined, b: string | undefined): string | undefined {
  const at = a ? Date.parse(a) : NaN;
  const bt = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(at)) return Number.isFinite(bt) ? b : undefined;
  if (!Number.isFinite(bt)) return a;
  return bt < at ? b : a;
}

/**
 * 失败原因里网关的原话（「unexpected http status code: 502, body: {"code":400,"message":"…"}」）换成能看懂的
 * 一句：取出 body 里的 message；工作流缺参数时直接说缺哪几项。取不出就只说状态码（验收问题 33）。原话
 * 放在悬停提示里。
 */
export function readableReason(raw: string): string {
  const text = raw.trim();
  const http = /unexpected http status code:\s*(\d{3})\s*,\s*body:\s*([\s\S]*)$/i.exec(text);
  let reason = text;
  if (http) {
    const body = http[2]!;
    let message: string | undefined;
    try {
      const parsed = JSON.parse(body) as { message?: unknown; msg?: unknown; error?: { message?: unknown } | unknown };
      const nested = parsed.error && typeof parsed.error === "object" ? (parsed.error as { message?: unknown }).message : parsed.error;
      const found = [parsed.message, parsed.msg, nested].find((value) => typeof value === "string" && value.trim());
      message = typeof found === "string" ? found : undefined;
    } catch {
      // body 被截断了：照着 "message":"…" 取一段。
      message = /"(?:message|msg)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(body)?.[1]?.replace(/\\"/g, '"');
    }
    reason = message?.trim() || `Atlas Cloud returned an error (HTTP ${http[1]}).`;
  }
  const missing = /missing required parameters?\s*[:：]\s*(.+)$/i.exec(reason)?.[1];
  if (missing) {
    const names = missing.match(/[A-Za-z_][\w.-]*/g) ?? [];
    if (names.length > 0) return `A required setting was missing: ${names.join(", ")}.`;
  }
  return reason.replace(/^(?:workflow error|error)\s*[:：]\s*/i, "").replace(/\s+/g, " ").slice(0, 200);
}

/** 出片比例跟着输入图时的小标签；服务端 src/apps/card-params.ts 照这个写，后面带「 · 4:3」。 */
const RATIO_FROM_IMAGE = "Ratio from image";

/**
 * 输入图的具体比例（「Ratio from image · 4:3」）只有报价时读得出来，提交结果和查结果都只剩
 * 「Ratio from image」。同一个任务换卡时沿用手上那份带比例的标签（验收问题 26）。
 */
export function keepImageRatio(settings: string[], known: string[] | undefined): string[] {
  const detailed = known?.find((label) => label.startsWith(`${RATIO_FROM_IMAGE} · `));
  if (!detailed || !settings.includes(RATIO_FROM_IMAGE)) return settings;
  return settings.map((label) => (label === RATIO_FROM_IMAGE ? detailed : label));
}

/** 余额：截断到分（$45.3967 写 $45.39），和官网一致；服务端同口径见 src/services/billing-account.ts。 */
export function formatBalance(value: number): string {
  const cents = Math.floor(value * 100 + 1e-6);
  return cents < 0 ? `-$${(-cents / 100).toFixed(2)}` : `$${(cents / 100).toFixed(2)}`;
}

/** 长任务 ID 中间省略：前 6 后 4。 */
export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 链接里的文件名，下载时用。 */
export function fileNameOf(url: string, fallback: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return name || fallback;
  } catch {
    return fallback;
  }
}

/** 工作流一次跑出几张图是按次计费；单模型多张图按张计费，单张价才有意义。 */
export function perItemPrice(card: CardData): number | undefined {
  if (card.charge_status === "pending") return undefined;
  if (card.price_usd === undefined || card.media.length === 0) return undefined;
  if (card.model_id?.startsWith("atlascloud/")) return undefined;
  return card.price_usd / card.media.length;
}

/** 新的 UUID v4 幂等键。randomUUID 只在安全上下文里有，退回用 getRandomValues 拼。 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
