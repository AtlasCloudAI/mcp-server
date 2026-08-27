// Backend-declared billing unit for `base_price` (kubedl SkuUnit*).
// Older models do not carry this field; callers fall back to category heuristics.
export type SkuPriceUnit =
  | "generation" // per generation (music, per-task billing)
  | "second" // per second (video)
  | "image" // per image
  | "minute" // per minute of audio
  | "1k_chars"; // per 1K characters (TTS)

// One side (discounted / list) of a model's price table
export interface ModelPriceSide {
  input_price?: string;
  output_price?: string;
  base_price?: string;
  // Billing dimension of `base_price`. Absent on older models.
  unit?: SkuPriceUnit;
  cache_price?: string;
  cache_creation_price?: string;
  output_image_price?: string;
  request_price?: string;
}

// Model pricing structure
export interface ModelPrice {
  discount?: string;
  actual?: ModelPriceSide;
  origin?: ModelPriceSide;
}

// Chat protocol a model speaks. Values match the backend `Protocol` constants.
export type ModelProtocol =
  | "openai.chat.completions"
  | "openai.completions"
  | "openai.responses"
  | "openai.images"
  | "claude.messages"
  | "gemini.generate";

// Model data type
export interface Model {
  uuid: string;
  model: string;
  type: string;
  displayName: string;
  profile: string;
  avatar: string;
  readme: string;
  schema?: string;
  tags: string[];
  price?: ModelPrice;
  contextLength?: number;
  maxCompletionTokens?: number;
  avgLatency?: number | string;
  categories?: string[];
  organization?: string;
  example?: string;
  familyName?: string;
  familyDisplayName?: string;
  totalParameters?: string;
  activeParameters?: string;
  architectureType?: string;
  knowledgeCutoff?: string;
  coreStrengths?: string[];
  useCases?: string[];
  display_console?: boolean;
  // Ordered list of API contracts this model speaks; the first entry is the
  // backend's preferred one. Decides endpoint + request body shape, see
  // services/protocols.ts. Absent on older entries -> assume chat.completions.
  supported_protocols?: string[];
  // What the model can accept / emit, e.g. ["text", "image", "video"].
  input_modalities?: string[];
  output_modalities?: string[];
  // Sampling parameter names an LLM accepts (temperature, top_k, ...).
  supported_sampling_parameters?: string[];
  // Minimum billable duration in seconds, used by video price display.
  minDuration?: number;
  priority?: number;
}

// Models list API response
export interface ModelsResponse {
  code: string;
  data: Model[];
}

// Structured speech-to-text result. `outputs[0]` is only the plain transcript;
// timestamps and per-channel splits live here.
export interface SttResult {
  text?: string;
  language?: string;
  language_code?: string;
  duration?: number;
  words?: Array<{
    text?: string;
    start?: number;
    end?: number;
    type?: string;
    speaker_id?: string;
  }>;
  channels?: Array<{
    index?: number;
    language?: string;
    text?: string;
    words?: unknown[];
  }>;
  [key: string]: unknown;
}

// Lyrics generation result. Structured object; `outputs[0]` is a copy of `lyrics`.
export interface LyricsResult {
  song_title?: string;
  style_tags?: string[];
  lyrics?: string;
  [key: string]: unknown;
}

/**
 * Payload of GET /api/v1/model/prediction/{id}.
 *
 * Field set is model-dependent and still growing, so unknown keys are preserved
 * rather than dropped — a missing field means the caller cannot see part of what
 * they generated. Verified against live responses: id, model, outputs, urls,
 * status, created_at, completed_at, error, executionTime, timings, price,
 * latency_ms, has_nsfw_contents, plus stt_result / lyrics_result / thumbnail /
 * files / layers / duration depending on the model.
 */
export interface PredictionData {
  id?: string;
  model?: string;
  status?: string;
  // Text models return plain text here, not URLs (ASR transcript, lyrics).
  output?: string | string[];
  outputs?: Array<string | Record<string, unknown>> | null;
  // Backend may return a plain string OR an object; never render it directly.
  error?: unknown;
  error_code?: number;
  stt_result?: SttResult | null;
  lyrics_result?: LyricsResult | null;
  // Cover art generated alongside a song (Suno).
  thumbnail?: string;
  // 3D pipelines return extra packaged artifacts here.
  files?: unknown;
  // Layer-decomposition metadata aligned with `outputs`.
  layers?: unknown;
  // Per-output NSFW flags; a blocked generation completes with empty outputs.
  has_nsfw_contents?: boolean[] | null;
  urls?: { get?: string; [key: string]: unknown };
  created_at?: string;
  completed_at?: string;
  duration?: number;
  executionTime?: number;
  latency_ms?: number;
  timings?: Record<string, unknown>;
  price?: string | number;
  metrics?: Record<string, unknown>;
  [key: string]: unknown;
}

// Generation task response
export interface PredictionResponse {
  code: number | string;
  message?: string;
  data: PredictionData;
}

// One row of GET /api/v1/model/history
export interface HistoryItem {
  ID: string;
  createdAt: number;
  model: string;
  requestBody: string;
  result?: PredictionData;
  status: string;
}

export interface HistoryResponse {
  code: number | string;
  data: {
    items: HistoryItem[];
    pageNo: number;
    pageSize: number;
    total: number;
  };
}

// Upload media response
export interface UploadResponse {
  code: number;
  message: string;
  data: {
    type: string;
    download_url: string;
    filename: string;
    size: number;
  };
}

// A monetary amount as returned by billing endpoints
export interface MoneyValue {
  value: string;
  currency: string;
}

// GET /public/v1/balance
export interface BalanceResponse {
  object: string;
  scope: string;
  account?: {
    id: string;
    name: string;
    type: string;
  };
  available?: MoneyValue;
  cash?: MoneyValue;
  bonus?: MoneyValue;
  subscription_bonus?: MoneyValue;
  frozen?: MoneyValue;
  credit_grant?: {
    status?: string;
    granted?: MoneyValue;
    used?: MoneyValue;
    remaining_overdraft?: MoneyValue;
    overdrawn?: MoneyValue;
  };
  request_id?: string;
}

// A single daily bucket shared by usage and cost list responses
export interface DailyBucket {
  object: string;
  date: string;
  start_at?: string;
  end_at?: string;
  partial?: boolean;
  results?: Array<Record<string, unknown>>;
}

// GET /public/v1/model-usage and /public/v1/model-costs
export interface UsageListResponse {
  object: string;
  scope: string;
  data: DailyBucket[];
  has_more?: boolean;
  next_page?: string | null;
  request_id?: string;
}

// A media part attached to a chat message (protocol-neutral)
export interface MediaInput {
  kind: "image" | "video" | "audio";
  // Public URL or data URI (data:image/png;base64,...)
  url: string;
}

// LLM chat message (protocol-neutral; translated per protocol before sending).
// There is no shared response type: each protocol answers with its own shape,
// and services/protocols.ts reads the reply out of whichever one came back.
export interface ChatTurn {
  role: "system" | "user" | "assistant";
  text: string;
  media?: MediaInput[];
}
