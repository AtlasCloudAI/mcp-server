// Model pricing structure
export interface ModelPrice {
  discount?: string;
  actual?: {
    input_price?: string;
    output_price?: string;
    base_price?: string;
    cache_price?: string;
    output_image_price?: string;
    request_price?: string;
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
export interface PredictionResponse {
  code: number;
  data: {
    id: string;
    status?: string;
    output?: string | string[];
    outputs?: string[];
    error?: string;
    metrics?: Record<string, unknown>;
  };
}

// LLM chat message
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

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
