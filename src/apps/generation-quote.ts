import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { balanceResponseSchema } from "../response-schemas.js";
import { ESTIMATE_SETTLES_ON_USAGE, estimateMissingLabel } from "../services/spend-policy.js";
import { inputsOf, positiveNumber, promptOf, settingsChips } from "./card-params.js";
import { type ApiRequestOptions, publicApi } from "../services/api-client.js";
import { billingAccount, describeBillingAccount } from "../services/billing-account.js";
import type { BalanceResponse } from "../types.js";
import {
  CARD_META_KEY,
  type GenerationCardData,
  buildGenerationCardData,
  clientRendersCards,
  generationCardEnabled,
  generationCardToolMeta,
  cardMediaKind,
  type QuoteInfo,
} from "./generation-card.js";

// 生成工具的报价卡：报价结果显示成「确认生成」卡片，用户在卡里点 Generate，卡片自己
// 带着确认令牌再调一次同一个工具；提交后原地变成进度卡，再自己刷新到出结果。
// 设计稿见 Figma「MCP 对话内组件 · 跟随宿主」的「报价确认」一节。
//
// 不改各个生成工具的逻辑：只在外面包一层，按工具已经返回的 structuredContent
// （confirmation_required / submitted）拼卡片数据，放进 _meta。

/** 挂卡片的生成工具。转写（atlas_transcribe_audio）出的是文字，没有作品卡，不挂。 */
export const CARD_GENERATION_TOOLS = [
  "atlas_generate_image",
  "atlas_generate_video",
  "atlas_generate_audio",
  "atlas_quick_generate",
] as const;

const CONFIRMATION_FIELDS = new Set(["confirmation_token", "confirmed", "idempotency_key"]);

const KIND_TYPE: Record<string, string> = { image: "Image", video: "Video", audio: "Audio" };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export { settingsChips } from "./card-params.js";

/** 报价卡上的「任务内容」和「输入素材」（需求文档 6.1）。 */
function quoteTask(params: Record<string, unknown> | undefined): Pick<QuoteInfo, "prompt" | "inputs"> {
  const prompt = promptOf(params);
  const inputs = inputsOf(params).map((input) => ({ ...input, kind: cardMediaKind(input.url) }));
  return {
    ...(prompt ? { prompt } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
  };
}

/** 由工具结果拼卡片数据；不是报价也不是提交（比如出错）就返回 undefined。 */
export function generationResultCard(
  tool: string,
  args: Record<string, unknown>,
  structured: unknown
): GenerationCardData | undefined {
  const content = record(structured);
  if (!content) return undefined;
  const modelId = typeof content.model_id === "string" ? content.model_id : undefined;
  const modelName = typeof content.model_name === "string" ? content.model_name : undefined;
  const modelType = typeof content.kind === "string" ? KIND_TYPE[content.kind] : undefined;

  const callArgs = Object.fromEntries(
    Object.entries(args).filter(([name]) => !CONFIRMATION_FIELDS.has(name))
  );

  if (content.status === "confirmation_required") {
    const token = content.confirmation_token;
    const key = content.idempotency_key;
    if (typeof token !== "string" || typeof key !== "string") return undefined;
    const validSeconds = positiveNumber(content.confirmation_valid_seconds);
    const estimate = typeof content.estimated_cost_usd === "number" ? content.estimated_cost_usd : undefined;
    // 优先用工具给出的实际提交参数（含服务端补的默认值）；老结构里没有时，图片、视频、
    // 音频工具的参数在 params 里，快速生成直接平铺在参数上。
    const params = record(content.params) ?? record(args.params) ?? callArgs;
    const account = record(content.billing_account);
    const missing = Array.isArray(content.estimate_missing)
      ? content.estimate_missing.filter((code): code is string => typeof code === "string")
      : [];
    return {
      ...buildGenerationCardData({
        predictionId: "",
        status: "quote",
        outputs: [],
        transferPending: false,
        modelId,
        modelName,
        modelType,
      }),
      state: "quote",
      quote: {
        tool,
        arguments: callArgs,
        idempotency_key: key,
        confirmation_token: token,
        ...(validSeconds
          ? { expires_at: new Date(Date.now() + validSeconds * 1000).toISOString(), valid_seconds: validSeconds }
          : {}),
        ...(estimate !== undefined ? { estimated_usd: estimate } : {}),
        ...(content.estimate_partial === true ? { partial: true } : {}),
        ...(content.estimate_reason === ESTIMATE_SETTLES_ON_USAGE ? { settles_on_usage: true } : {}),
        ...(missing.length > 0 ? { estimate_missing: missing.map(estimateMissingLabel) } : {}),
        settings: settingsChips(params),
        ...quoteTask(params),
        ...(account && typeof account.name === "string"
          ? {
              account: {
                name: account.name,
                ...(typeof account.user_email === "string" ? { email: account.user_email } : {}),
                ...(typeof account.available_usd === "number" ? { balance_usd: account.available_usd } : {}),
              },
            }
          : {}),
      },
    };
  }

  if (content.status === "submitted" || content.status === "completed") {
    const submittedParams = record(content.params) ?? record(args.params) ?? callArgs;
    const predictionId = content.prediction_id;
    if (typeof predictionId !== "string" || !predictionId) return undefined;
    const outputs = Array.isArray(content.outputs)
      ? content.outputs.filter((u): u is string => typeof u === "string")
      : [];
    return {
      ...buildGenerationCardData({
        predictionId,
        // 同步出结果的模型直接给作品卡；其余先显示生成中，卡片自己刷新。
        status: outputs.length > 0 ? "completed" : "processing",
        outputs,
        transferPending: false,
        modelId,
        modelName,
        modelType,
        createdAt: new Date().toISOString(),
        settings: settingsChips(submittedParams),
      }),
      retry: { tool, arguments: callArgs },
    };
  }
  return undefined;
}

/** 查余额最多等这么久：报错本身不能被它拖住。 */
const BALANCE_TIMEOUT_MS = 3_000;

/** 可用余额（美元，两位小数）；查不到（没有 billing:read、超时、不是美元）就返回 undefined。 */
async function availableBalance(fetcher?: ApiRequestOptions["fetcher"]): Promise<string | undefined> {
  try {
    const res = await publicApi<BalanceResponse>("/balance", {
      responseSchema: balanceResponseSchema,
      maxRetries: 0,
      timeout: BALANCE_TIMEOUT_MS,
      ...(fetcher ? { fetcher } : {}),
    });
    const value = Number(res.available?.value);
    if (!Number.isFinite(value) || res.available?.currency.toLowerCase() !== "usd") return undefined;
    return value < 0 ? `-$${(-value).toFixed(2)}` : `$${value.toFixed(2)}`;
  } catch {
    return undefined;
  }
}

/**
 * 余额不足时顺带查一次可用余额，接在报错后面（"Available balance: $8.50."）：卡片的余额不足状态
 * 照设计稿显示预估费用和余额，模型也能告诉用户差多少。卡片认这几个词，改措辞要同步
 * ui/generation-card/quote.ts。
 */
export async function withAvailableBalance(
  result: CallToolResult,
  options: { fetcher?: ApiRequestOptions["fetcher"] } = {}
): Promise<CallToolResult> {
  const index = result.content.findIndex((block) => block.type === "text");
  const first = result.content[index];
  if (!first || first.type !== "text" || !/insufficient balance/i.test(first.text)) return result;
  const balance = await availableBalance(options.fetcher);
  if (!balance) return result;
  const content = [...result.content];
  content[index] = { ...first, text: `${first.text.trimEnd()} Available balance: ${balance}.` };
  return { ...result, content };
}

const QUOTE_CARD_NOTE =
  "The Atlas card shows this quote with a Generate button. If the user approves it there, the " +
  "card submits this exact job and tracks it: do not call a generation tool for it again. If " +
  "they confirm in the chat instead, call again as described above; the same idempotency_key " +
  "returns the job the card already started rather than a second one.";

/**
 * 报价结果补上「主要参数」和扣费账户（需求文档 6.1）。不管卡片开没开都补：Codex、
 * Claude Code 这类只看文字的客户端也要能告诉用户从哪个账户扣。查不到账户就只补参数。
 */
export async function withQuoteDetails(
  result: CallToolResult,
  options: { fetcher?: ApiRequestOptions["fetcher"] } = {}
): Promise<CallToolResult> {
  const content = record(result.structuredContent);
  if (result.isError || content?.status !== "confirmation_required") return result;
  const settings = settingsChips(record(content.params));
  const account = await billingAccount(options);
  const lines = [
    settings.length > 0 ? `- **Settings**: ${settings.join(" · ")}` : null,
    account ? `- **Billing account**: ${describeBillingAccount(account)}` : null,
  ].filter((line): line is string => line !== null);
  if (lines.length === 0) return result;
  return {
    ...result,
    structuredContent: { ...content, ...(account ? { billing_account: account } : {}) },
    content: [
      ...result.content,
      {
        type: "text" as const,
        text:
          lines.join("\n") +
          "\nInclude these settings" +
          (account ? " and the billing account the charge goes to" : "") +
          " when showing the quote.",
      },
    ],
  };
}

/**
 * 给生成工具的处理函数套一层：报价补上参数和扣费账户，结果里带上卡片数据。卡片没打开时
 * 只补报价信息。客户端声明能渲染卡片时，报价结果再多一句话，告诉模型卡片上能直接确认。
 */
export function withGenerationCard<Args extends Record<string, unknown>, Extra>(
  server: McpServer,
  tool: (typeof CARD_GENERATION_TOOLS)[number],
  handler: (args: Args, extra: Extra) => Promise<CallToolResult>,
  options: { fetcher?: ApiRequestOptions["fetcher"] } = {}
): (args: Args, extra: Extra) => Promise<CallToolResult> {
  return async (args, extra) => {
    const result = await withQuoteDetails(await handler(args, extra), options);
    if (!generationCardEnabled()) return result;
    if (result.isError) return withAvailableBalance(result);
    const card = generationResultCard(tool, args, result.structuredContent);
    if (!card) return result;
    const note =
      card.state === "quote" && clientRendersCards(server)
        ? [{ type: "text" as const, text: QUOTE_CARD_NOTE }]
        : [];
    return {
      ...result,
      _meta: { ...(result._meta ?? {}), [CARD_META_KEY]: card },
      content: [...result.content, ...note],
    };
  };
}

/** 生成工具定义上要挂的元数据（卡片关着时为空）。 */
export function generationToolCardMeta(): { _meta?: Record<string, unknown> } {
  return generationCardEnabled() ? { _meta: generationCardToolMeta() } : {};
}
