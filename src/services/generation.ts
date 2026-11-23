import { findModel, getModelSchema } from "./doc-fetcher.js";
import { api } from "./api-client.js";
import {
  fillRequiredDefaults,
  validateModelParams,
  formatValidationError,
} from "../utils/schema-validator.js";
import type { Model, PredictionResponse } from "../types.js";
import { annotateToolCall, recordToolCallError, sanitizeModel, schemaErrorParam } from "../telemetry/tool-call.js";

export type SubmitResult =
  | { ok: true; predictionId: string; model: Model; body: Record<string, unknown> }
  // Dry run: the body was built and validated but never sent
  | { ok: true; predictionId: null; model: Model; body: Record<string, unknown> }
  | { ok: false; message: string };

interface SubmitOptions {
  // Expected model.type for this generation kind ("Image" also covers 3D)
  expectedType: "Image" | "Video" | "Audio";
  // Target endpoint, e.g. "/model/generateImage"
  endpoint: string;
  // Human label used in messages, e.g. "image", "video", "audio"
  typeLabel: string;
  /**
   * Optional extra check on the resolved model, for kinds that share a type.
   * The Audio type covers speech synthesis, music and transcription, which run
   * on the same endpoint but are not interchangeable — submitting a TTS model
   * to a transcription request burns credits and returns nonsense.
   * Return an error message to block, or null to proceed.
   */
  validateModel?: (model: Model) => string | null;
  // Build and validate the request, then stop short of sending it
  dryRun?: boolean;
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
  annotateToolCall({ stage: "prepare", model_type: opts.typeLabel, execution_mode: opts.dryRun ? "dry_run" : "submit" });
  const found = await findModel(modelId);
  if (!found) {
    recordToolCallError({ code: "model_not_found" });
    return {
      ok: false,
      message: `Model "${modelId}" not found. Use atlas_list_models with type="${opts.expectedType}" to see available ${opts.typeLabel} models.`,
    };
  }
  annotateToolCall({ model: sanitizeModel(found.model) });
  if (found.type !== opts.expectedType) {
    recordToolCallError({ code: "model_type_mismatch", cause: found.type.toLowerCase() === "image" || found.type.toLowerCase() === "video" || found.type.toLowerCase() === "audio" ? `is_${found.type.toLowerCase()}` : "other" });
    const article = (word: string) =>
      /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
    return {
      ok: false,
      message: `Model "${modelId}" is ${article(found.type)} model, not ${article(opts.expectedType)} model. Use atlas_list_models with type="${opts.expectedType}" to find ${opts.typeLabel} models.`,
    };
  }

  const kindError = opts.validateModel?.(found);
  if (kindError) {
    recordToolCallError({ code: "model_type_mismatch", cause: "wrong_audio_kind" });
    return { ok: false, message: kindError };
  }

  // Fetch schema and validate params before hitting the billable endpoint.
  // If the schema is unavailable, validation is skipped (does not block).
  annotateToolCall({ stage: "schema" });
  const schema = await getModelSchema(found);
  if (!schema) annotateToolCall({ schema_skipped: true });
  const finalParams = fillRequiredDefaults(schema, params);
  const validation = validateModelParams(schema, found.model, finalParams);
  if (!validation.ok) {
    recordToolCallError({ code: "invalid_param", cause: "schema_validation", param: schemaErrorParam(validation.errors) });
    return { ok: false, message: formatValidationError(found.model, validation) };
  }

  const body = { model: found.model, ...finalParams };

  if (opts.dryRun) {
    return { ok: true, predictionId: null, model: found, body };
  }

  annotateToolCall({ stage: "submit" });
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

  return { ok: true, predictionId, model: found, body };
}
