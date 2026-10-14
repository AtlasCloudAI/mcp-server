// Model pricing structure
/** 文本模型的一档阶梯价：输入超过 threshold 个 token 后生效。 */
export interface PromptThresholdPrice {
  threshold?: number;
  input_price?: string;
  output_price?: string;
  cache_price?: string;
  cache_creation_price?: string;
}

export interface ModelPrice {
  discount?: string;
  actual?: {
    input_price?: string;
    output_price?: string;
    base_price?: string;
    cache_price?: string;
    cache_creation_price?: string;
    output_image_price?: string;
    request_price?: string;
    prompt_thresholds?: PromptThresholdPrice[];
  };
  origin?: {
    input_price?: string;
    output_price?: string;
    base_price?: string;
    cache_price?: string;
    output_image_price?: string;
    request_price?: string;
  };
}

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
}

// Models list API response
export interface ModelsResponse {
  code: string;
  data: Model[];
}

// Generation task response
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

// LLM chat message
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type SubmitKind = "image" | "video" | "audio" | "transcription";

// LLM chat completion response
export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
