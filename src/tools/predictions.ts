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
import { generationCardEnabled } from "../apps/generation-card.js";
import { HISTORY_META_KEY, historyCardData } from "../apps/history-card.js";
import { generationToolCardMeta } from "../apps/generation-quote.js";
import { describeNotStarted, recentNotStarted } from "../services/not-started.js";
import { formatUsd } from "../services/spend-policy.js";
import { asRecord } from "../services/json-record.js";

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
  source?: string;
  /** 这一单实际扣了多少（历史接口的 billing.amount）；还没结算或没扣时没有。 */
  charged_usd?: number;
}

/** 历史接口的 billing.amount：字符串或数字，读不出就当没有。 */
function chargedUsd(item: HistoryItem): number | undefined {
  const billing = asRecord((item as Record<string, unknown>).billing);
  const raw = billing?.amount;
  const value = typeof raw === "string" ? Number.parseFloat(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
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

/**
 * 这一单从哪儿发起的，写法和控制台使用记录的「来源」一样：MCP · ChatGPT、Website……
 * 同一个账号常常同时连着好几个应用，模型要靠它分出哪几单是这个对话的（11-04 问题 40）。
 * 老记录没有来源，就不写。
 */
export function sourceLabel(item: HistoryItem): string | undefined {
  const name = typeof item.sourceName === "string" ? item.sourceName.trim() : "";
  switch (item.source) {
    case "mcp":
      return name ? `MCP · ${name}` : "MCP";
    case "website":
      return "Website";
    case "api":
      return "API";
    case "cli":
      return "Atlas CLI";
    default:
      return undefined;
  }
}

export function summarizeHistoryItem(item: HistoryItem): PredictionSummary {
  const result = asRecord(item.result);
  const request = asRecord(item.requestBody);
  const prompt = typeof request?.prompt === "string" ? request.prompt : undefined;
  const error =
    typeof result?.error === "string" && result.error !== "" ? result.error : undefined;
  const createdAt = toIsoTimestamp(item.createdAt);
  const source = sourceLabel(item);
  const charged = chargedUsd(item);
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
    ...(source ? { source } : {}),
    ...(charged !== undefined ? { charged_usd: charged } : {}),
  };
}

export function registerPredictionTools(server: McpServer): void {
  server.registerTool(
    "atlas_list_predictions",
    {
      title: "List Predictions",
      description: `List the authenticated account's recent generation tasks (image, video, audio), newest first.

Use this to find a task ID the user lost, to see what was generated earlier in a session, or to review which recent runs failed. It reads history only — nothing is submitted or billed.

Each entry gives prediction_id, model, status, created_at, where it was started (source, e.g. "MCP · ChatGPT", "MCP · Claude Code", "Website", "API"), the amount actually charged (charged_usd, once the task is billed), the output URLs (when finished), the error text (when failed) and a prompt snippet. When the user asks what a task cost, answer from charged_usd, not from the earlier quote. For the full record of one task, call atlas_get_prediction with its prediction_id.

One account is often used from several apps at the same time, so the list can include tasks started elsewhere. When the user asks what this conversation generated or spent, count the tasks whose source is this app and mention any others separately.

Args:
  - page (integer, optional, default 1): page number, newest first
  - size (integer, optional, default 10, max 50): entries per page
  - state (string, optional): "running" | "succeeded" | "failed" — the reliable three-way filter
  - model (string, optional): exact model ID, e.g. "bytedance/seedream-v4.7/text-to-image"
  - model_prefix (string, optional): a whole family, e.g. "google/nano-banana-2"

Returns:
  total, page, size, has_more, charged_total_usd (the sum of charged_usd over the predictions on this page) and the predictions on this page. When the user asks what several tasks cost together, quote charged_total_usd (or add up charged_usd exactly) rather than estimating.

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
        // 这一页实扣合计：11-12 Claude（Jia P4）自己把 $0.0011 + $0.018 + $0.018 加成了 $0.0191。
        charged_total_usd: z.number().nonnegative(),
        predictions: z.array(
          z.object({
            prediction_id: z.string(),
            model: z.string(),
            status: z.string(),
            created_at: z.string().optional(),
            outputs: z.array(z.string()),
            error: z.string().optional(),
            prompt: z.string().optional(),
            source: z.string().optional(),
            charged_usd: z.number().optional(),
          })
        ),
      },
      annotations: toolAnnotations("atlas_list_predictions"),
      ...generationToolCardMeta(),
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
        // 按分以下的精度累加再四舍五入到 6 位，免得浮点误差带出一串尾数。
        const chargedTotal =
          Math.round(predictions.reduce((sum, prediction) => sum + (prediction.charged_usd ?? 0), 0) * 1e6) / 1e6;

        const lines = [`# Predictions (page ${page}, ${predictions.length} of ${total})`, ""];
        if (predictions.length === 0) lines.push("No tasks match these filters.");
        predictions.forEach((prediction, index) => {
          lines.push(
            `${index + 1}. \`${prediction.prediction_id}\` — ${prediction.model} — **${prediction.status}**` +
              (prediction.created_at ? ` — ${prediction.created_at}` : "") +
              (prediction.source ? ` — via ${prediction.source}` : "")
          );
          if (prediction.charged_usd !== undefined) lines.push(`   charged: ${formatUsd(prediction.charged_usd)}`);
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
        if (predictions.some((prediction) => prediction.charged_usd !== undefined)) {
          lines.push(`Charged on this page in total: ${formatUsd(chargedTotal)}.`);
        }
        lines.push(
          hasMore
            ? `More pages available: call again with page=${page + 1}.`
            : "This is the last page."
        );
        lines.push(
          "Use atlas_get_prediction with a prediction_id for the full record. Failed tasks were not billed."
        );
        // 确认了却没开始的不会进历史：附在第一页后面，模型才不会猜「卡片没收到点击」。
        const notStarted = page === 1 ? describeNotStarted(await recentNotStarted()) : undefined;
        if (notStarted) lines.push("", notStarted);

        // 卡片打开时，结果显示成历史列表卡（能展开全屏、筛选、点开单条）。
        const history = generationCardEnabled()
          ? await historyCardData(result.data.items, predictions, { page, size, total, hasMore, state })
          : undefined;

        return {
          ...(history ? { _meta: { [HISTORY_META_KEY]: history } } : {}),
          structuredContent: { total, page, size, has_more: hasMore, charged_total_usd: chargedTotal, predictions },
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
