import { findModelByExactId, getModelSchema } from "./doc-fetcher.js";
import { generationApi } from "./api-client.js";
import {
  fillRequiredDefaults,
  validateModelParams,
  formatValidationError,
} from "../utils/schema-validator.js";
import type { Model } from "../types.js";
import {
  predictionResponseSchema,
  type PredictionResponse,
} from "../response-schemas.js";
import {
  annotateToolCall,
  normalizeGenerationStatus,
  recordToolCallError,
  taskHash,
} from "./tool-call-telemetry.js";

export type SubmitResult =
  | { ok: true; predictionId: string; model: Model; outputs: string[] }
  | { ok: false; message: string };

export interface PreparedGeneration {
  model: Model;
  body: Record<string, unknown>;
  endpoint: string;
  typeLabel: string;
}

export type PrepareResult =
  | { ok: true; prepared: PreparedGeneration }
  | { ok: false; message: string };

interface SubmitOptions {
  // Expected model.type for this generation kind ("Image" also covers 3D)
  expectedType: "Image" | "Video" | "Audio";
  // Target endpoint, e.g. "/model/generateImage"
  endpoint: string;
  // Human label used in messages, e.g. "image", "video", "audio"
  typeLabel: string;
}

/**
 * Shared submit flow for image / video / audio generation:
 *   1. resolve the model and verify its type
 *   2. fill required defaults from the model schema
 *   3. validate params against the schema (blocks before any billable call)
 *   4. submit and return the prediction id
 *
 * Returns a discriminated result; callers format their own success message.
 */
export async function prepareGeneration(
  modelId: string,
  params: Record<string, unknown>,
  opts: SubmitOptions
): Promise<PrepareResult> {
  // 查模型、取 schema、校验参数都算 schema 阶段，与 CLI 一致。
  annotateToolCall({ stage: "schema" });
  const found = await findModelByExactId(modelId);
  if (!found) {
    recordToolCallError({ code: "model_not_found" });
    return {
      ok: false,
      message: `Model "${modelId}" not found. Use atlas_list_models with type="${opts.expectedType}" to see available ${opts.typeLabel} models.`,
    };
  }
  // 只报目录里查到的 ID：查不到的那个是调用方随手填的，可能是任意文本。
  annotateToolCall({ model: found.model });
  if (found.type !== opts.expectedType) {
    recordToolCallError({ code: "invalid_param" });
    return {
      ok: false,
      message: `Model "${modelId}" is a ${found.type} model, not an ${opts.expectedType} model. Use atlas_list_models with type="${opts.expectedType}" to find ${opts.typeLabel} models.`,
    };
  }

  // Fetch schema and validate params before hitting the billable endpoint.
  const schema = await getModelSchema(found);
  if (!schema) {
    recordToolCallError({ code: "model_schema_unavailable" });
    return {
      ok: false,
      message:
        `The live input schema for model "${found.model}" is unavailable. ` +
        "No billable request was submitted. Retry later or choose another model whose schema can be inspected.",
    };
  }
  const finalParams = fillRequiredDefaults(schema, params);
  const validation = validateModelParams(schema, found.model, finalParams);
  if (!validation.ok) {
    recordToolCallError({ code: "invalid_param", param: validation.errorParam });
    return { ok: false, message: formatValidationError(found.model, validation) };
  }

  const body = { model: found.model, ...finalParams };
  return {
    ok: true,
    prepared: {
      model: found,
      body,
      endpoint: opts.endpoint,
      typeLabel: opts.typeLabel,
    },
  };
}

export async function submitPreparedGeneration(
  prepared: PreparedGeneration
): Promise<SubmitResult> {
  const response = await generationApi<PredictionResponse>(prepared.endpoint, {
    method: "POST",
    body: prepared.body,
    responseSchema: predictionResponseSchema,
  });

  const predictionId = response.data?.id;
  if (!predictionId) {
    // 平台收下了请求却没给任务号：可能已经在跑、在计费，和 CLI 的 submission_unknown 同义。
    recordToolCallError({ code: "submission_unknown" });
    return {
      ok: false,
      message: `The Atlas Cloud API accepted the ${prepared.typeLabel} request but did not return a prediction ID. No automatic retry was attempted.`,
    };
  }

  // Some models answer synchronously: the finished URLs are already in the
  // submit response, and there is no queue to poll. Dropping them here is what
  // made a completed image look unfinished — the caller was told to poll a
  // prediction that had nothing left to report, and the result never reached
  // the conversation.
  const finished = response.data?.outputs ?? response.data?.output;
  const outputs = Array.isArray(finished) ? finished : finished ? [finished] : [];
  // 提交成功不等于任务成功：只记平台这次真实给出的状态，同步出结果才算 completed。
  annotateToolCall({
    generation_status:
      outputs.length > 0 ? "completed" : normalizeGenerationStatus(response.data?.status),
    task_hash: taskHash(predictionId),
  });

  // Which branch a model takes is not documented anywhere and differs per model,
  // so record it: "submitted but nothing shown" and "finished but nothing shown"
  // are different bugs and used to look the same from outside.
  console.error(
    `[generation] ${prepared.model.model} ${
      outputs.length > 0 ? `returned ${outputs.length} output(s) synchronously` : "queued for polling"
    } (status=${response.data?.status ?? "unknown"})`
  );

  return { ok: true, predictionId, model: prepared.model, outputs };
}

export async function submitGeneration(
  modelId: string,
  params: Record<string, unknown>,
  opts: SubmitOptions
): Promise<SubmitResult> {
  const prepared = await prepareGeneration(modelId, params, opts);
  if (!prepared.ok) return prepared;
  return submitPreparedGeneration(prepared.prepared);
}
