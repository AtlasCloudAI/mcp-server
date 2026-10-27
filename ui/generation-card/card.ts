// 卡片数据：服务端放在工具结果 _meta["atlascloud/card"] 里（见 src/apps/generation-card.ts）。
// 宿主没把 _meta 转过来时，从 structuredContent 推一份够用的。这里只放纯函数，测试直接引。

export type CardMediaKind = "image" | "video" | "audio" | "3d" | "other";

export interface CardMedia {
  url: string;
  kind: CardMediaKind;
}

export type CardState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "transfer_pending";

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
}

export const CARD_META_KEY = "atlascloud/card";
const SITE_URL = "https://www.atlascloud.ai";

const STATES = new Set<CardState>([
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
  if (["starting", "processing", "running", "pending", "in_progress"].includes(s)) return "running";
  if (s === "canceled" || s === "cancelled") return "canceled";
  return "failed";
}

/** 工具结果 → 卡片数据。认不出来返回 undefined。 */
export function cardFromToolResult(result: unknown): CardData | undefined {
  const r = record(result);
  if (!r) return undefined;
  const fromMeta = record(r._meta)?.[CARD_META_KEY];
  if (isCardData(fromMeta)) return fromMeta;
  const structured = record(r.structuredContent);
  if (!structured) return undefined;
  if (isCardData(structured.card)) return structured.card;
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

export function modelLabel(card: CardData): string {
  return card.model_name || card.model_id || "Atlas Cloud";
}

/** 美元金额：至少两位小数，最多四位，去掉多余的 0（$0.03、$1.34、$0.2593）。 */
export function formatUsd(value: number): string {
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
