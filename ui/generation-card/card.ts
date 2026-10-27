// 卡片数据：服务端放在工具结果 _meta["atlascloud/card"] 里（见 src/apps/generation-card.ts）。
// 宿主没把 _meta 转过来时，从 structuredContent 推一份够用的。这里只放纯函数，测试直接引。

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
  settings: string[];
  problem?: "insufficient_balance";
}

export interface CardData {
  state: CardState;
  prediction_id: string;
  model_id?: string;
  model_name?: string;
  model_type?: string;
  price_usd?: number;
  media: CardMedia[];
  error?: string;
  open_url?: string;
  submitted_at?: string;
  completed_at?: string;
  media_expired?: boolean;
  sample?: boolean;
  quote?: QuoteInfo;
  retry?: { tool: string; arguments: Record<string, unknown> };
}

export const CARD_META_KEY = "atlascloud/card";
const SITE_URL = "https://www.atlascloud.ai";

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
            ...(seconds > 0 ? { expires_at: new Date(Date.now() + seconds * 1000).toISOString() } : {}),
            ...(typeof structured.estimated_cost_usd === "number" ? { estimated_usd: structured.estimated_cost_usd } : {}),
            ...(structured.estimate_partial === true ? { partial: true } : {}),
            settings: [],
          },
        }
      : {}),
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
  const outputs = Array.isArray(structured.outputs)
    ? structured.outputs.filter((u): u is string => typeof u === "string")
    : [];
  return {
    state: stateOf(structured.status, structured.transfer_pending === true),
    prediction_id: structured.prediction_id,
    media: outputs.map((url) => ({ url, kind: kindOfUrl(url) })),
    ...(typeof structured.error === "string" && structured.error ? { error: structured.error } : {}),
    open_url: SITE_URL,
  };
}

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
  if (card.price_usd === undefined || card.media.length === 0) return undefined;
  if (card.model_id?.startsWith("atlascloud/")) return undefined;
  return card.price_usd / card.media.length;
}
