import { findModelByExactId, getModelSchema } from "./doc-fetcher.js";
import { generationApi } from "./api-client.js";
import { withAssetLibraryReferences } from "./library-references.js";
import {
  checkInputLinks,
  formatInputLinkProblems,
  inputImageShapes,
  inputLinkCheckEnabled,
  type InputImageShape,
} from "./input-link-check.js";
import {
  fillAllDefaults,
  fillPreferredDefaults,
  fillRequiredDefaults,
  validateModelParams,
  formatValidationError,
} from "../utils/schema-validator.js";
import { routeDefaultParams } from "./default-models.js";
import { isWorkflowModelId } from "./workflow-catalog.js";
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
  /** 参数里图片的宽高和横竖（只在 readInputShapes 时读）。 */
  inputImages?: InputImageShape[];
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
  // 读输入图片的宽高（视频报价时：告诉模型出片会跟着图是横是竖）
  readInputShapes?: boolean;
}

/**
 * Shared submit flow for image / video / audio generation:
 *   1. resolve the model and verify its type
 *   2. fill the default-route settings the caller left out, then required
 *      defaults from the model schema
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
  return prepareWithSchema(found, schema, params, opts);
}

/**
 * 模型和 schema 都拿到之后的那一段：补默认值、校验、查素材链接、读输入图片的横竖。atlas_quick_generate
 * 按关键词找到模型、拼好参数后也走这里（验收问题 29、31：它原来自己校验，工作流的默认值、链接检查和
 * 图片横竖都没有）。
 */
export async function prepareWithSchema(
  found: Model,
  schema: Record<string, unknown>,
  params: Record<string, unknown>,
  opts: SubmitOptions
): Promise<PrepareResult> {
  // 工作流每个选项都要给值，默认值全填；普通模型只填必填的，其余交给上游自己的默认。
  const fillDefaults = isWorkflowModelId(found.model) ? fillAllDefaults : fillRequiredDefaults;
  const finalParams = fillDefaults(
    schema,
    fillPreferredDefaults(schema, params, routeDefaultParams(found.model))
  );
  const validation = validateModelParams(schema, found.model, finalParams);
  if (!validation.ok) {
    recordToolCallError({ code: "invalid_param", param: validation.errorParam });
    return { ok: false, message: formatValidationError(found.model, validation) };
  }

  // 素材链接先检查（需求文档 5.2）：打不开、是网页、类型不对的链接，在报价之前就说清楚是哪一条，
  // 而不是等网关下载失败、任务挂掉之后才知道。
  // 图片宽高和链接检查一起读，不多等一轮。
  let inputImages: InputImageShape[] = [];
  if (inputLinkCheckEnabled()) {
    const [problems, shapes] = await Promise.all([
      checkInputLinks(finalParams),
      opts.readInputShapes ? inputImageShapes(finalParams) : Promise.resolve([]),
    ]);
    if (problems.length > 0) {
      return { ok: false, message: formatInputLinkProblems(problems) };
    }
    inputImages = shapes;
  }

  const body = { model: found.model, ...finalParams };
  return {
    ok: true,
    prepared: {
      model: found,
      body,
      endpoint: opts.endpoint,
      typeLabel: opts.typeLabel,
      ...(inputImages.length > 0 ? { inputImages } : {}),
    },
  };
}

export async function submitPreparedGeneration(
  prepared: PreparedGeneration,
  idempotencyKey?: string
): Promise<SubmitResult> {
  const response = await generationApi<PredictionResponse>(prepared.endpoint, {
    method: "POST",
    // 资产库素材交 assetd:// 引用，和网站一样（library-references.ts）。
    body: await withAssetLibraryReferences(prepared.body),
    responseSchema: predictionResponseSchema,
    ...idempotencyHeaders(idempotencyKey),
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

/**
 * 把这一单的幂等键也交给生成网关（aiproxy#1074 起插件和接口密钥请求也按它去重）。服务端
 * 自己的幂等记录挡住了大多数重复，这一层管的是它挡不住的：提交到网关后超时、记录丢了，
 * 同一个键再交一次时网关直接认出原任务，不会再建一单、再扣一次。
 */
export function idempotencyHeaders(key: string | undefined): { headers?: Record<string, string> } {
  return key ? { headers: { "Idempotency-Key": key } } : {};
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
