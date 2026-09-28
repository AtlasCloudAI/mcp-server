import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../services/api-client.js";
import { handleError } from "../utils/error-handler.js";
import { toolAnnotations } from "../tool-policy.js";
import {
  historyResponseSchema,
  type HistoryItem,
  type HistoryResponse,
} from "../response-schemas.js";

// 和目录里的模型 ID 同形：厂商/名字/变体，只放这几类字符。
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export interface PredictionSummary {
  prediction_id: string;
  model: string;
  status: string;
  created_at?: string;
  outputs: string[];
  error?: string;
  prompt?: string;
}

// 后端给的是秒级时间戳字符串；这里同时容忍毫秒、数字和 ISO 字符串。
function toIsoTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(String(value).trim());
  if (Number.isFinite(numeric) && numeric > 0) {
    const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

// requestBody 在库里是 JSON 字符串，result 是对象；两边都按「可能是任一种」处理。
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function outputUrls(result: Record<string, unknown> | undefined): string[] {
  if (!result) return [];
  const rawOutputs = result.outputs ?? result.output;
  const list = Array.isArray(rawOutputs)
    ? rawOutputs
    : typeof rawOutputs === "string"
      ? [rawOutputs]
      : [];
  return list.filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate !== ""
  );
}

export function summarizeHistoryItem(item: HistoryItem): PredictionSummary {
  const result = asRecord(item.result);
  const request = asRecord(item.requestBody);
  const prompt = typeof request?.prompt === "string" ? request.prompt : undefined;
  const error =
    typeof result?.error === "string" && result.error !== "" ? result.error : undefined;
  const createdAt = toIsoTimestamp(item.createdAt);
  return {
    prediction_id: item.ID,
    model: item.model,
    status: item.status && item.status !== "" ? item.status : "unknown",
    ...(createdAt ? { created_at: createdAt } : {}),
    outputs: outputUrls(result),
    ...(error ? { error } : {}),
    ...(prompt
      ? { prompt: prompt.length > 160 ? `${prompt.slice(0, 157)}...` : prompt }
      : {}),
  };
}

export function registerPredictionTools(server: McpServer): void {
  server.registerTool(
    "atlas_list_predictions",
    {
      title: "List Predictions",
      description: `List the authenticated account's recent generation tasks (image, video, audio), newest first.

Use this to find a task ID the user lost, to see what was generated earlier in a session, or to review which recent runs failed. It reads history only — nothing is submitted or billed.

Each entry gives prediction_id, model, status, created_at, the output URLs (when finished), the error text (when failed) and a prompt snippet. For the full record of one task, call atlas_get_prediction with its prediction_id.

Args:
  - page (integer, optional, default 1): page number, newest first
  - size (integer, optional, default 10, max 50): entries per page
  - state (string, optional): "running" | "succeeded" | "failed" — the reliable three-way filter
  - model (string, optional): exact model ID, e.g. "bytedance/seedream-v4.7/text-to-image"
  - model_prefix (string, optional): a whole family, e.g. "google/nano-banana-2"

Returns:
  total, page, size, has_more and the predictions on this page.

Notes:
  - Status values are the platform's own ("completed", "failed", "processing", ...); filter with "state" rather than matching status strings yourself.
  - A task in status "failed" was not billed.`,
      inputSchema: {
        page: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(1)
          .describe("Page number, newest first"),
        size: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Entries per page (max 50)"),
        state: z
          .enum(["running", "succeeded", "failed"])
          .optional()
          .describe("Three-way state filter"),
        model: z.string().regex(modelIdPattern).optional().describe("Exact model ID"),
        model_prefix: z
          .string()
          .regex(modelIdPattern)
          .optional()
          .describe("Model ID prefix selecting a whole family"),
      },
      outputSchema: {
        total: z.number().int().nonnegative(),
        page: z.number().int().positive(),
        size: z.number().int().positive(),
        has_more: z.boolean(),
        predictions: z.array(
          z.object({
            prediction_id: z.string(),
            model: z.string(),
            status: z.string(),
            created_at: z.string().optional(),
            outputs: z.array(z.string()),
            error: z.string().optional(),
            prompt: z.string().optional(),
          })
        ),
      },
      annotations: toolAnnotations("atlas_list_predictions"),
    },
    async ({ page, size, state, model, model_prefix }) => {
      try {
        // /model/history 由 kubedl 的 console backend 提供，走 api()（ATLASCLOUD_API_BASE_URL）。
        // 后端的分页参数叫 no/size，不是 page/pageSize；传错不报错，只是静默按默认值分页。
        const result = await api<HistoryResponse>("/model/history", {
          params: { no: page, size, state, model, modelPrefix: model_prefix },
          responseSchema: historyResponseSchema,
        });
        const predictions = result.data.items.map(summarizeHistoryItem);
        const total = result.data.total;
        const hasMore = page * size < total;

        const lines = [`# Predictions (page ${page}, ${predictions.length} of ${total})`, ""];
        if (predictions.length === 0) lines.push("No tasks match these filters.");
        predictions.forEach((prediction, index) => {
          lines.push(
            `${index + 1}. \`${prediction.prediction_id}\` — ${prediction.model} — **${prediction.status}**` +
              (prediction.created_at ? ` — ${prediction.created_at}` : "")
          );
          if (prediction.prompt) lines.push(`   prompt: ${prediction.prompt}`);
          if (prediction.outputs.length > 0) {
            lines.push(
              `   outputs: ${prediction.outputs.length} → ${prediction.outputs[0]}` +
                (prediction.outputs.length > 1 ? " …" : "")
            );
          }
          if (prediction.error) lines.push(`   error: ${prediction.error}`);
        });
        lines.push("");
        lines.push(
          hasMore
            ? `More pages available: call again with page=${page + 1}.`
            : "This is the last page."
        );
        lines.push(
          "Use atlas_get_prediction with a prediction_id for the full record. Failed tasks were not billed."
        );

        return {
          structuredContent: { total, page, size, has_more: hasMore, predictions },
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );
}
