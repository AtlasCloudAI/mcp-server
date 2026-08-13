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
  scope: string;
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
    scope: "atlas:models:read",
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads the bounded Atlas model catalog and documentation without changing account or public state.",
  },
  atlas_list_models: {
    scope: "atlas:models:read",
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Lists the bounded Atlas model catalog and does not mutate any state.",
  },
  atlas_get_model_info: {
    scope: "atlas:models:read",
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads one model's catalog metadata, schema, and documentation without mutation.",
  },
  atlas_generate_image: {
    scope: "atlas:generation:write",
    remote: true,
    billable: true,
    annotations: billableExternalWrite,
    annotationJustification:
      "Creates a billable external generation task and asset; a stable idempotency key prevents duplicate effects.",
  },
  atlas_generate_video: {
    scope: "atlas:generation:write",
    remote: true,
    billable: true,
    annotations: billableExternalWrite,
    annotationJustification:
      "Creates a billable external generation task and asset; a stable idempotency key prevents duplicate effects.",
  },
  atlas_upload_media: {
    scope: "atlas:assets:write",
    remote: false,
    billable: false,
    annotations: billableExternalWrite,
    annotationJustification:
      "Uploads a local file and creates an externally hosted asset; retries are deduplicated by idempotency key.",
  },
  atlas_generate_audio: {
    scope: "atlas:generation:write",
    remote: true,
    billable: true,
    annotations: billableExternalWrite,
    annotationJustification:
      "Creates a billable external audio task and asset; a stable idempotency key prevents duplicate effects.",
  },
  atlas_transcribe_audio: {
    scope: "atlas:generation:write",
    remote: true,
    billable: true,
    annotations: billableExternalWrite,
    annotationJustification:
      "Creates a billable external transcription task; a stable idempotency key prevents duplicate effects.",
  },
  atlas_chat: {
    scope: "atlas:chat:write",
    remote: false,
    billable: true,
    annotations: billableExternalWrite,
    annotationJustification:
      "Invokes a billable external model; a stable idempotency key prevents duplicate charges.",
  },
  atlas_get_prediction: {
    scope: "atlas:predictions:read",
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads a specific Atlas prediction and does not alter task or asset state.",
  },
  atlas_get_balance: {
    scope: "atlas:billing:read",
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads the authenticated Atlas account balance without mutation.",
  },
  atlas_get_model_usage: {
    scope: "atlas:billing:read",
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads bounded usage records for the authenticated Atlas account without mutation.",
  },
  atlas_get_model_costs: {
    scope: "atlas:billing:read",
    remote: true,
    billable: false,
    annotations: firstPartyRead,
    annotationJustification:
      "Reads bounded cost records for the authenticated Atlas account without mutation.",
  },
  atlas_quick_generate: {
    scope: "atlas:generation:write",
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
