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
  const found = await findModelByExactId(modelId);
  if (!found) {
    return {
      ok: false,
      message: `Model "${modelId}" not found. Use atlas_list_models with type="${opts.expectedType}" to see available ${opts.typeLabel} models.`,
    };
  }
  if (found.type !== opts.expectedType) {
    return {
      ok: false,
      message: `Model "${modelId}" is a ${found.type} model, not an ${opts.expectedType} model. Use atlas_list_models with type="${opts.expectedType}" to find ${opts.typeLabel} models.`,
    };
  }

  // Fetch schema and validate params before hitting the billable endpoint.
  const schema = await getModelSchema(found);
  if (!schema) {
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
