import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type AtlasToolName =
  | "atlas_search_docs"
  | "atlas_list_models"
  | "atlas_get_model_info"
  | "atlas_generate_image"
  | "atlas_generate_video"
  | "atlas_upload_media"
  | "atlas_generate_audio"
  | "atlas_transcribe_audio"
  | "atlas_chat"
  | "atlas_get_prediction"
  | "atlas_get_balance"
  | "atlas_get_model_usage"
  | "atlas_get_model_costs"
  | "atlas_quick_generate";

export interface ToolPolicy {
  /**
   * 本工具所需的 scope，取自 REMOTE_SCOPES。
   *
   * null 表示不需要任何 scope：契约 v3 §4.2 规定模型目录与单模型 schema 的读取
   * 匿名可读，带令牌与不带令牌返回同一份内容。MCP 端点本身仍然要求一枚有效令牌
   * （那是 MCP 协议的授权模型），但不再额外要求 scope。
   */
  scope: string | null;
  remote: boolean;
  billable: boolean;
  annotations: Required<
    Pick<
      ToolAnnotations,
      "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint"
    >
  >;
  annotationJustification: string;
}

const firstPartyRead: ToolPolicy["annotations"] = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const billableExternalWrite: ToolPolicy["annotations"] = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

export const TOOL_POLICIES: Record<AtlasToolName, ToolPolicy> = {
  atlas_search_docs: {
    scope: null,
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads the bounded Atlas model catalog and documentation without changing account or public state.",
  },
  atlas_list_models: {
    scope: null,
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Lists the bounded Atlas model catalog and does not mutate any state.",
  },
  atlas_get_model_info: {
    scope: null,
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads one model's catalog metadata, schema, and documentation without mutation.",
  },
  atlas_generate_image: {
    scope: "tasks:write",
    remote: true,
    billable: true,
    annotations: billableExternalWrite,
    annotationJustification:
      "Creates a billable external generation task and asset; a stable idempotency key prevents duplicate effects.",
  },
  atlas_generate_video: {
    scope: "tasks:write",
    remote: true,
    billable: true,
    annotations: billableExternalWrite,
    annotationJustification:
      "Creates a billable external generation task and asset; a stable idempotency key prevents duplicate effects.",
  },
  atlas_upload_media: {
    scope: "tasks:write",
    remote: false,
    billable: false,
    annotations: billableExternalWrite,
    annotationJustification:
      "Uploads a local file and creates an externally hosted asset; retries are deduplicated by idempotency key.",
  },
  atlas_generate_audio: {
    scope: "tasks:write",
    remote: true,
    billable: true,
    annotations: billableExternalWrite,
    annotationJustification:
      "Creates a billable external audio task and asset; a stable idempotency key prevents duplicate effects.",
  },
  atlas_transcribe_audio: {
    scope: "tasks:write",
    remote: true,
    billable: true,
    annotations: billableExternalWrite,
    annotationJustification:
      "Creates a billable external transcription task; a stable idempotency key prevents duplicate effects.",
  },
  atlas_chat: {
    scope: "tasks:write",
    remote: false,
    billable: true,
    annotations: billableExternalWrite,
    annotationJustification:
      "Invokes a billable external model; a stable idempotency key prevents duplicate charges.",
  },
  atlas_get_prediction: {
    scope: "tasks:read",
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads a specific Atlas prediction and does not alter task or asset state.",
  },
  atlas_get_balance: {
    scope: "billing:read",
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads the authenticated Atlas account balance without mutation.",
  },
  atlas_get_model_usage: {
    scope: "billing:read",
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads bounded usage records for the authenticated Atlas account without mutation.",
  },
  atlas_get_model_costs: {
    scope: "billing:read",
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads bounded cost records for the authenticated Atlas account without mutation.",
  },
  atlas_quick_generate: {
    scope: "tasks:write",
    remote: true,
    billable: true,
    annotations: billableExternalWrite,
    annotationJustification:
      "Resolves exactly one model before creating a billable external task; a stable idempotency key prevents duplicates.",
  },
};

export const ALL_TOOL_NAMES = Object.keys(TOOL_POLICIES) as AtlasToolName[];
export const REMOTE_TOOL_NAMES = ALL_TOOL_NAMES.filter(
  (name) => TOOL_POLICIES[name].remote
);

export function toolAnnotations(name: AtlasToolName): ToolAnnotations {
  return { ...TOOL_POLICIES[name].annotations };
}

export function isAtlasToolName(value: string): value is AtlasToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_POLICIES, value);
}
