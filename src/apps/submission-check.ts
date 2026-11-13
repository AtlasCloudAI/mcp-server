import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, generationApi } from "../services/api-client.js";
import { rememberCardClient } from "../services/card-clients.js";
import { type QuoteCancelReason, cancelIdempotent, peekIdempotent } from "../services/idempotency.js";
import {
  historyResponseSchema,
  predictionResponseSchema,
  type HistoryItem,
  type HistoryResponse,
  type PredictionResponse,
} from "../response-schemas.js";
import { idempotencyKeySchema } from "../tool-contracts.js";
import { CARD_TOOL_POLICIES } from "../tool-policy.js";
import { handleError } from "../utils/error-handler.js";
import { CARD_META_KEY, buildGenerationCardData, predictionCardData } from "./generation-card.js";
import { CARD_GENERATION_TOOLS } from "./generation-quote.js";
import { asRecord } from "../services/json-record.js";

// 报价卡点了 Generate 却没拿到确定的回答（超时、断网、宿主把调用掐了）：这一单可能已经在跑，
// 也可能根本没到。卡片调这个工具自己核实，而不是让用户去 Atlas 翻记录、或者再点一次多扣一单。
//
// 先看幂等记录：提交拿到结果的、被上游明确拒收的，记录里就有答案。记录说「不知道」时
// 再翻这个账号最近的任务：同一个模型、同一段提示词、在提交之后建的，就是它。
//
// 卡片重新打开时（ChatGPT 重新渲染对话、换了标签页）也调一次，带 on_load：宿主只给卡片当初
// 报价那次的结果，卡片不知道后来确认过没有（11-04 第 11 轮问题 39）。这时没有幂等记录就是
// 没提交过，不去翻任务：同模型同提示词的另一单不能算到这张报价头上。

export const CARD_CHECK_TOOL = "atlas_card_check_submission";

/** 提交开始后这么久还查不到，就算没开始。写请求 30 秒超时，再给任务落库留足时间。 */
export const NOT_STARTED_AFTER_MS = 90_000;
/** 这台机器和任务库的时钟差。 */
const CLOCK_SLACK_MS = 30_000;
const HISTORY_PAGE_SIZE = 20;

export type SubmissionOutcome =
  | { outcome: "started"; prediction_id: string }
  | { outcome: "not_started"; message: string }
  | { outcome: "checking" }
  /** on_load：这张报价没有提交记录。 */
  | { outcome: "not_submitted" }
  /** 这份报价作废了（atlas_cancel_quote）：卡片改成 Canceled（declined）或 Settings changed（replaced）。 */
  | { outcome: "canceled"; reason: QuoteCancelReason };

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;


/** 幂等记录里存的提交结果：生成工具存 { ok, predictionId }，快速生成存原始响应 { data: { id } }。 */
function storedPredictionId(result: unknown): string | undefined {
  const record = asRecord(result);
  const id = record?.predictionId ?? asRecord(record?.data)?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

function createdAtMs(item: HistoryItem): number | undefined {
  const raw = item.createdAt;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const numeric = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** 认这一单用的文字：提示词，没有就用朗读文本。都没有就只按模型和时间认。 */
function textOf(source: Record<string, unknown> | undefined): string | undefined {
  for (const field of ["prompt", "text"]) {
    const value = source?.[field];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** 卡片发的参数里的提示词：生成工具放在 params 里，快速生成在顶层。 */
function argumentText(args: Record<string, unknown> | undefined): string | undefined {
  return textOf(asRecord(args?.params)) ?? textOf(args);
}

/** 提交之后建的、同模型同提示词的最早一条。 */
export function matchSubmission(
  items: readonly HistoryItem[],
  wanted: { model: string; text?: string; since: number }
): string | undefined {
  let best: { id: string; at: number } | undefined;
  for (const item of items) {
    if (item.model !== wanted.model) continue;
    const at = createdAtMs(item);
    if (at === undefined || at < wanted.since - CLOCK_SLACK_MS) continue;
    if (wanted.text !== undefined && textOf(asRecord(item.requestBody)) !== wanted.text) continue;
    if (!best || at < best.at) best = { id: item.ID, at };
  }
  return best?.id;
}

export async function checkSubmission(input: {
  tool: string;
  idempotency_key: string;
  model?: string;
  arguments?: Record<string, unknown>;
  submitted_at?: string;
  on_load?: boolean;
  now?: number;
}): Promise<SubmissionOutcome> {
  const now = input.now ?? Date.now();
  const record = await peekIdempotent(input.tool, input.idempotency_key);
  const stored = record?.state === "completed" ? storedPredictionId(record.result) : undefined;
  if (stored) return { outcome: "started", prediction_id: stored };
  if (record?.state === "canceled") return { outcome: "canceled", reason: record.reason };
  if (record?.state === "rejected") {
    return { outcome: "not_started", message: "Atlas Cloud turned this request down, so it didn't start." };
  }
  if (input.on_load && !record) return { outcome: "not_submitted" };

  // 还在提交、记录说不准、上游收下了却没给任务号，或者没有记录（过期、工具没跑到）：翻最近的任务。
  // 开始时间优先用服务端记下的那一刻。
  const cardTime = input.submitted_at ? Date.parse(input.submitted_at) : NaN;
  const since = record?.createdAt ?? (Number.isFinite(cardTime) ? cardTime : now);
  if (input.model) {
    const history = await api<HistoryResponse>("/model/history", {
      params: { no: 1, size: HISTORY_PAGE_SIZE, model: input.model },
      responseSchema: historyResponseSchema,
    });
    const id = matchSubmission(history.data.items, {
      model: input.model,
      text: argumentText(input.arguments),
      since,
    });
    if (id) return { outcome: "started", prediction_id: id };
  }
  if (now - since < NOT_STARTED_AFTER_MS) return { outcome: "checking" };
  return { outcome: "not_started", message: "Atlas Cloud has no record of this job, so it didn't start." };
}

/** 找到的任务拼成卡片数据，卡片直接接着显示进度。查不到详情就先给一张排队中的卡。 */
async function startedCard(predictionId: string, model: string | undefined) {
  const result = await generationApi<PredictionResponse>(
    `/model/prediction/${encodeURIComponent(predictionId)}`,
    { responseSchema: predictionResponseSchema, timeout: 10_000, maxRetries: 1 }
  ).catch(() => undefined);
  if (result) return predictionCardData(predictionId, result);
  return buildGenerationCardData({ predictionId, status: "queued", outputs: [], transferPending: false, modelId: model });
}

export function registerCardCheckTool(server: McpServer): void {
  server.registerTool(
    CARD_CHECK_TOOL,
    {
      title: "Check Card Submission",
      description:
        "Used by the Atlas Cloud generation card to find out whether a submission it sent actually started. Not for direct use: call atlas_list_predictions instead.",
      inputSchema: {
        tool: z.enum(CARD_GENERATION_TOOLS).describe("Generation tool the card called"),
        idempotency_key: idempotencyKeySchema,
        model: z.string().regex(modelIdPattern).optional().describe("Model ID on the card"),
        arguments: z.record(z.unknown()).optional().describe("Arguments the card sent, for matching the prompt"),
        submitted_at: z.string().datetime().optional().describe("When the card sent the submission"),
        on_load: z
          .boolean()
          .optional()
          .describe("The card was opened again on an old quote: only report a submission that is on record"),
      },
      annotations: { ...CARD_TOOL_POLICIES.atlas_card_check_submission.annotations },
      // 和 atlas_card_status 一样只给卡片调，不挂 resourceUri。
      _meta: {
        ui: { visibility: ["app"] },
        "openai/widgetAccessible": true,
        "openai/visibility": "private",
      },
    },
    async (args) => {
      void rememberCardClient();
      try {
        const result = await checkSubmission(args);
        if (result.outcome !== "started") {
          return {
            structuredContent: result,
            content: [
              {
                type: "text",
                text:
                  result.outcome === "checking"
                    ? "Still checking whether it started."
                    : result.outcome === "not_submitted"
                      ? "This quote hasn't been submitted."
                      : result.outcome === "canceled"
                        ? `This quote was canceled (${result.reason}).`
                        : `Not started: ${result.message}`,
              },
            ],
          };
        }
        const card = await startedCard(result.prediction_id, args.model);
        return {
          _meta: { [CARD_META_KEY]: card },
          structuredContent: { ...result, card },
          content: [{ type: "text", text: `Started as prediction ${result.prediction_id}: ${card.state}` }],
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleError(error) }] };
      }
    }
  );
}

export const CANCEL_QUOTE_TOOL = "atlas_cancel_quote";

/**
 * 报价作废（11-13 Jia A12 / A14）：一条消息出两张报价卡，用户说「小狗那张不要了」，或者改了时长重新报价，
 * 旧卡还是 Needs confirmation、还能点确认，可能误下单。模型在用户拒绝或改需求时调它：占住旧报价的幂等键，
 * 之后拿它确认一律拒绝，卡片后台核实时看到作废就改成 Canceled / Settings changed。
 */
export function registerCancelQuoteTool(server: McpServer): void {
  server.registerTool(
    CANCEL_QUOTE_TOOL,
    {
      title: "Cancel Quote",
      description:
        "Withdraw a generation quote the user has not confirmed, so its card can no longer submit it. " +
        "Call it when the user declines a quote (\"not that one\", \"never mind\", \"I don't want it\") with reason \"declined\", " +
        "and when the user changes a quoted request (different duration, size, model, prompt...) with reason \"replaced\", for the old quote, before or right after quoting the new one. " +
        "Pass the tool and idempotency_key of the quote being withdrawn. Nothing is charged. A quote that was already submitted cannot be canceled; the result says so.",
      inputSchema: {
        tool: z.enum(CARD_GENERATION_TOOLS).describe("Generation tool that issued the quote"),
        idempotency_key: idempotencyKeySchema.describe("idempotency_key of the quote being withdrawn"),
        reason: z.enum(["declined", "replaced"]).describe("declined: the user doesn't want it; replaced: the request changed and a new quote replaces it"),
      },
      annotations: { ...CARD_TOOL_POLICIES.atlas_cancel_quote.annotations },
    },
    async ({ tool, idempotency_key, reason }) => {
      try {
        const result = await cancelIdempotent(tool, idempotency_key, reason);
        if (result.status === "canceled") {
          return {
            structuredContent: { status: "canceled", reason: result.reason },
            content: [{ type: "text", text: "Quote canceled. Its card can no longer submit it, and nothing was charged." }],
          };
        }
        const id = result.record.state === "completed" ? storedPredictionId(result.record.result) : undefined;
        return {
          structuredContent: { status: "already_submitted", ...(id ? { prediction_id: id } : {}) },
          content: [
            {
              type: "text",
              text: `This quote was already submitted${id ? ` as prediction ${id}` : ""}, so it can't be canceled. Tell the user; check its status with atlas_get_prediction.`,
            },
          ],
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleError(error) }] };
      }
    }
  );
}
