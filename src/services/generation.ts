import { findModel, getModelSchema } from "./doc-fetcher.js";
import { api } from "./api-client.js";
import {
  fillRequiredDefaults,
  validateModelParams,
  formatValidationError,
} from "../utils/schema-validator.js";
import type { Model, PredictionResponse } from "../types.js";

export type SubmitResult =
  | { ok: true; predictionId: string; model: Model }
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
export async function submitGeneration(
  modelId: string,
  params: Record<string, unknown>,
  opts: SubmitOptions
): Promise<SubmitResult> {
  const found = await findModel(modelId);
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
  // If the schema is unavailable, validation is skipped (does not block).
  const schema = await getModelSchema(found);
  const finalParams = fillRequiredDefaults(schema, params);
  const validation = validateModelParams(schema, found.model, finalParams);
  if (!validation.ok) {
    return { ok: false, message: formatValidationError(found.model, validation) };
  }

  const body = { model: found.model, ...finalParams };
  const response = await api<PredictionResponse>(opts.endpoint, {
    method: "POST",
    body,
  });

  const predictionId = response.data?.id;
  if (!predictionId) {
    return {
      ok: false,
      message: `Failed to start ${opts.typeLabel} generation. Response: ${JSON.stringify(response)}`,
    };
  }

  return { ok: true, predictionId, model: found };
}
