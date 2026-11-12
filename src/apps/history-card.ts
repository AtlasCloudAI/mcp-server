import { getModels } from "../services/doc-fetcher.js";
import type { HistoryItem } from "../response-schemas.js";
import { asRecord } from "../services/json-record.js";
import { rememberedMedia } from "../services/media-names.js";
import { inputsOf } from "./card-params.js";
import type { PredictionSummary } from "../tools/predictions.js";
import {
  type CardMedia,
  type CardState,
  MODEL_LOOKUP_TIMEOUT_MS,
  cardMediaKind,
  cardStateOf,
  priceOf,
  settleWithin,
} from "./generation-card.js";

// 历史列表卡（设计稿「全屏视图」里的「历史列表 prediction.list」）：用户问「我之前生成了什么」时，
// atlas_list_predictions 的结果显示成一张列表卡，能展开成全屏、按状态筛选、点开看单条的作品卡。
// 数据放在结果的 _meta["atlascloud/history"]，和生成卡共用同一个卡片页面。

export const HISTORY_META_KEY = "atlascloud/history";

export type HistoryFilter = "running" | "succeeded" | "failed";

export interface HistoryCardItem {
  prediction_id: string;
  model_id: string;
  model_name?: string;
  model_type?: string;
  state: CardState;
  created_at?: string;
  /** 第一个产物，做缩略图。 */
  thumb?: CardMedia;
  /** 产物个数（多张图时列表上标「4」）。 */
  outputs: number;
  /** 实际扣费，来自历史接口的 billing.amount。 */
  price_usd?: number;
  error?: string;
  /** 这一单的提示词，单条详情的「Reuse prompt」用（设计 11-10 第 11 项）。完整原文，最长 2000 字。 */
  prompt?: string;
  /**
   * 这一单的输入素材，「Reuse prompt」一起交回去（11-12 ChatGPT 回归：编辑类任务只带提示词，模型自己去
   * 资产库挑了一张图当输入）。ref 是模型能直接填进参数的引用：资产库素材写 asset://编号，公开链接写链接。
   */
  inputs?: HistoryCardInput[];
  /** 输入里有几个文件的链接已经用不了（资产库临时地址过期、又认不出编号），Reuse 时请用户重新选。 */
  inputs_unavailable?: number;
}

export interface HistoryCardInput {
  name: string;
  ref: string;
  /** 参数里的字段名（image、images、video……），告诉模型原来填在哪儿。 */
  field?: string;
}

export interface HistoryCardData {
  view: "history";
  page: number;
  size: number;
  total: number;
  has_more: boolean;
  /** 这一页用的筛选；没有就是全部。 */
  state?: HistoryFilter;
  items: HistoryCardItem[];
  /** 测试卡片的样例列表。 */
  sample?: boolean;
}

/** 「Reuse prompt」发回对话的提示词上限：够放下常见的长提示词，又不让卡片数据过大。 */
const REUSE_PROMPT_MAX = 2000;

/** 历史条目的完整提示词（「Reuse prompt」用），没有或不是字符串时为空。 */
export function fullPrompt(item: HistoryItem): string | undefined {
  // 线上 requestBody 是 JSON 字符串：原来只认对象，真实数据里一条提示词都取不到（11-12 Jia 第二轮）。
  const prompt = asRecord((item as Record<string, unknown>).requestBody)?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) return undefined;
  const text = prompt.trim();
  return text.length > REUSE_PROMPT_MAX ? `${text.slice(0, REUSE_PROMPT_MAX - 1)}…` : text;
}

/**
 * 带签名的临时地址（资产库给的 15 分钟地址）：交给模型没用，过一会儿就打不开；ChatGPT 还把这类参数当成
 * 「访问凭证」拦下整个调用（11-03 第 9 轮）。只有认得出资产编号时才换成 asset://编号交回去。
 */
const SIGNED_URL = /[?&](?:x-oss-credential|x-oss-signature|ossaccesskeyid|signature|x-amz-signature|x-amz-credential)=/i;

/** 历史条目的输入素材 → 能交回给模型的引用。认不出编号的签名地址只计数。 */
export async function reusableInputs(
  item: HistoryItem
): Promise<{ inputs: HistoryCardInput[]; unavailable: number }> {
  const params = asRecord((item as Record<string, unknown>).requestBody);
  const found = inputsOf(params);
  if (found.length === 0) return { inputs: [], unavailable: 0 };
  const remembered = await rememberedMedia(found.map((input) => input.url));
  const inputs: HistoryCardInput[] = [];
  let unavailable = 0;
  for (const input of found) {
    const media = remembered.get(input.url);
    const name = media?.name ?? input.name;
    const field = input.field ? { field: input.field } : {};
    if (media?.assetId) inputs.push({ name, ref: `asset://${media.assetId}`, ...field });
    else if (!SIGNED_URL.test(input.url)) inputs.push({ name, ref: input.url, ...field });
    else unavailable += 1;
  }
  return { inputs, unavailable };
}

function billingAmount(item: HistoryItem): number | undefined {
  return priceOf(asRecord((item as Record<string, unknown>).billing)?.amount);
}

/** 历史接口的原始条目 + 已整理好的摘要 → 卡片数据。模型名查不到就只显示模型 ID。 */
export async function historyCardData(
  raw: HistoryItem[],
  summaries: PredictionSummary[],
  page: { page: number; size: number; total: number; hasMore: boolean; state?: HistoryFilter }
): Promise<HistoryCardData> {
  const models = await settleWithin(getModels(), MODEL_LOOKUP_TIMEOUT_MS);
  const byId = new Map((models ?? []).map((model) => [model.model, model]));
  // 输入素材只有带提示词的条目才用得上（Reuse prompt），没有提示词的不查。
  const reuse = await Promise.all(
    raw.map((item) => (fullPrompt(item) ? reusableInputs(item) : Promise.resolve({ inputs: [], unavailable: 0 })))
  );
  const items = summaries.map((summary, index): HistoryCardItem => {
    const model = byId.get(summary.model);
    const first = summary.outputs[0];
    const price = billingAmount(raw[index]!);
    const prompt = fullPrompt(raw[index]!);
    const { inputs, unavailable } = reuse[index] ?? { inputs: [], unavailable: 0 };
    return {
      prediction_id: summary.prediction_id,
      model_id: summary.model,
      ...(model?.displayName ? { model_name: model.displayName } : {}),
      ...(model?.type ? { model_type: model.type } : {}),
      state: cardStateOf(summary.status, false),
      ...(summary.created_at ? { created_at: summary.created_at } : {}),
      ...(first ? { thumb: { url: first, kind: cardMediaKind(first) } } : {}),
      outputs: summary.outputs.length,
      ...(price !== undefined ? { price_usd: price } : {}),
      ...(summary.error ? { error: summary.error } : {}),
      ...(prompt ? { prompt } : {}),
      ...(prompt && inputs.length > 0 ? { inputs } : {}),
      ...(prompt && unavailable > 0 ? { inputs_unavailable: unavailable } : {}),
    };
  });
  return {
    view: "history",
    page: page.page,
    size: page.size,
    total: page.total,
    has_more: page.hasMore,
    ...(page.state ? { state: page.state } : {}),
    items,
  };
}
