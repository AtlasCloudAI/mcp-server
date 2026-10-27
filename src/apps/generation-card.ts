import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RESOURCE_MIME_TYPE,
  getUiCapability,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { generationApi, headStillServes } from "../services/api-client.js";
import { findModelByExactId, getModels } from "../services/doc-fetcher.js";
import { classifyOutput, type OutputKind } from "../services/media-preview.js";
import {
  completedAtOf,
  createdAtOf,
  hasUntransferredMedia,
  isFinished,
  predictionOutputUrls,
  secondsSince,
  waitForPrediction,
} from "../services/prediction-wait.js";
import {
  predictionResponseSchema,
  type PredictionResponse,
} from "../response-schemas.js";
import { predictionIdSchema } from "../tool-contracts.js";
import { CARD_TOOL_POLICIES } from "../tool-policy.js";
import { handleError } from "../utils/error-handler.js";

// 对话内的「生成卡」（MCP Apps 标准）：同一张卡按 state 显示进度、作品、失败等样子，
// ChatGPT 和 Claude 都按 _meta.ui.resourceUri 认它。设计稿见 Figma「MCP 对话内组件 · 跟随宿主」
// 的「生成进度」「作品图库」「报价确认」，以及全屏视图里的历史列表。上传还没接。

/**
 * 卡片页面的地址带上页面内容的哈希。ChatGPT 按地址缓存卡片页面：2026-10-27 在 test 上换了新镜像、
 * 点了「刷新工具」，新对话里仍是旧页面。页面一变地址就变，挂在工具上的地址也跟着变，宿主只能去拉新的。
 */
export const GENERATION_CARD_URI = `ui://atlascloud/generation-card-${createHash("sha256")
  .update(loadCardHtml())
  .digest("hex")
  .slice(0, 12)}.html`;

/** 结果里给卡片的数据放在这个 _meta 键下：不进模型上下文，卡片拿不到时再从 structuredContent 推。 */
export const CARD_META_KEY = "atlascloud/card";

/** 卡片刷新自己用的工具，只给卡片调（visibility: app），模型看不到。 */
export const CARD_STATUS_TOOL = "atlas_card_status";

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/**
 * 卡片默认关：工具上挂了 ui 元数据，ChatGPT 里已上架的应用就会换一种展示，
 * 所以按环境逐个打开（先 dev、test，验收后再开生产）。
 */
export function generationCardEnabled(): boolean {
  return boolEnv("MCP_UI_CARDS", false);
}

/**
 * 客户端在 initialize 里声明了能渲染 MCP Apps 卡片。只有这时才改模型的轮询指引：
 * 卡片会自己刷新到出结果，模型再查一次就会在对话里多出一张卡。
 * 没声明的客户端（包括声明方式不同的宿主）照旧让模型自己轮询，最坏是多几张卡。
 */
export function clientRendersCards(server: McpServer): boolean {
  if (!generationCardEnabled()) return false;
  const capabilities = server.server.getClientCapabilities() as Parameters<
    typeof getUiCapability
  >[0];
  return getUiCapability(capabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false;
}

// 卡片在宿主的沙箱 iframe 里运行，只能加载这里声明过的来源。
// 生成结果在 atlas-media 桶，用户上传和工作流素材在 atlas-img 桶，示例素材在 static。
const DEFAULT_MEDIA_DOMAINS = [
  "https://atlas-media.oss-us-west-1.aliyuncs.com",
  "https://atlas-img.oss-accelerate-overseas.aliyuncs.com",
  "https://static.atlascloud.ai",
];

/**
 * 卡片能加载的媒体来源。别的环境存储桶不一样（test 是 atlas-media-dev / atlas-img-dev），
 * 用 MCP_UI_MEDIA_DOMAINS（逗号分隔，可不写 https://）追加；生产不用配。
 */
export function cardMediaDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.MCP_UI_MEDIA_DOMAINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((value) => (/^https:\/\//i.test(value) ? value : `https://${value}`))
    .map((value) => value.replace(/\/+$/, ""));
  return [...new Set([...DEFAULT_MEDIA_DOMAINS, ...extra])];
}

const SITE_URL = "https://www.atlascloud.ai";

function loadCardHtml(): string {
  // 构建产物：tsc 之后 scripts/build-ui.mjs 把 ui/generation-card 打成一个 HTML 放到 dist/ui/。
  // 从 dist/apps/ 运行时它在 ../ui/；直接跑源码（测试）时没有这个文件，给一个能看出原因的占位页。
  try {
    return readFileSync(
      fileURLToPath(new URL("../ui/generation-card.html", import.meta.url)),
      "utf8"
    );
  } catch {
    return "<!doctype html><meta charset=utf-8><p>Atlas Cloud card bundle is not built.</p>";
  }
}

function resourceUiMeta(): Record<string, unknown> {
  const domains = cardMediaDomains();
  return {
    ui: { csp: { resourceDomains: domains }, prefersBorder: false },
    // ChatGPT 旧版 Apps SDK 读这几个键；新版和 Claude 读上面的 ui。
    "openai/widgetCSP": { connect_domains: [], resource_domains: domains },
    "openai/widgetPrefersBorder": false,
  };
}

/**
 * 卡片上的模型名来自模型目录，冷启动拉一次要好几秒、超过卡片肯等的 3 秒（第一次查历史就没有名字）。
 * 远端服务启动时在后台预取一次（目录有 5 分钟缓存），失败也无所谓。
 */
export function prefetchCardCatalog(): void {
  if (generationCardEnabled()) void getModels().catch(() => undefined);
}

export function registerGenerationCardResource(server: McpServer): void {
  registerAppResource(
    server,
    "Atlas Cloud generation card",
    GENERATION_CARD_URI,
    {
      description: "Shows the progress and finished media of an Atlas Cloud generation.",
      _meta: resourceUiMeta(),
    },
    async () => ({
      contents: [
        {
          uri: GENERATION_CARD_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: loadCardHtml(),
          _meta: resourceUiMeta(),
        },
      ],
    })
  );
}

/** 挂到工具定义上：两个键都写，老宿主只认 "ui/resourceUri"。 */
export function generationCardToolMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: GENERATION_CARD_URI },
    "ui/resourceUri": GENERATION_CARD_URI,
    // ChatGPT 要这个才允许卡片从里面调工具（刷新、重试）。
    "openai/widgetAccessible": true,
  };
}

export type CardMediaKind = OutputKind | "3d";

export interface CardMedia {
  url: string;
  kind: CardMediaKind;
}

export type CardState =
  | "quote"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "transfer_pending";

/**
 * 报价卡（state = "quote"）确认生成要的全部东西。卡片拿它原样再调一次同一个工具，
 * 加上 confirmed、confirmation_token 和同一个幂等键——和模型在对话里确认走的是同一条路，
 * 服务端照常核对报价；重复确认由幂等存储挡掉，不会多出一单。
 */
export interface QuoteInfo {
  /** 要再调一次的生成工具名。 */
  tool: string;
  /** 这次调用的参数，去掉了确认相关的三个字段。 */
  arguments: Record<string, unknown>;
  idempotency_key: string;
  confirmation_token: string;
  /** 报价失效时间（ISO）。过了就只能重新报价。 */
  expires_at?: string;
  /** 按这次参数实算的预估价；拿不到时卡片显示「无法报价」。 */
  estimated_usd?: number;
  /** 预估不完整（只算了一部分）。 */
  partial?: boolean;
  /** 参数小标签，如 1080p、10 s、16:9、Audio。 */
  settings: string[];
  /** 只在测试卡片上用：直接显示某个问题状态。 */
  problem?: "insufficient_balance";
}

export interface GenerationCardData {
  state: CardState;
  prediction_id: string;
  model_id?: string;
  model_name?: string;
  /** Image / Video / Audio，取模型目录里的类型；进度卡标题开头用它。 */
  model_type?: string;
  /** 实际扣费（美元），来自查结果接口的 price；拿不到就不显示。 */
  price_usd?: number;
  media: CardMedia[];
  error?: string;
  /** 「在 Atlas 打开」：工作流去 /workflow/history，其他模型去模型页。 */
  open_url?: string;
  submitted_at?: string;
  completed_at?: string;
  /** 结果链接已经打不开了（存储过期或被删），卡片显示「链接过期」。 */
  media_expired?: boolean;
  /** 测试卡片的示例数据：卡片不去刷新，也不往对话里发消息。 */
  sample?: boolean;
  /** 只在 state = "quote" 时有。 */
  quote?: QuoteInfo;
  /** 由生成工具提交的任务：失败后卡片用它重新报价（Try again），不必替用户发消息。 */
  retry?: { tool: string; arguments: Record<string, unknown> };
}

const THREE_D_EXTENSIONS = new Set(["glb", "gltf", "obj", "usdz", "fbx", "stl", "ply"]);

export function cardMediaKind(url: string): CardMediaKind {
  const kind = classifyOutput(url);
  if (kind !== "other") return kind;
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
    if (THREE_D_EXTENSIONS.has(ext)) return "3d";
  } catch {
    // 不是合法 URL 就当普通文件
  }
  return "other";
}

const ACTIVE = new Set(["starting", "processing", "running", "pending", "in_progress"]);
const QUEUED = new Set(["queued", "created", "waiting"]);
const DONE = new Set(["completed", "succeeded", "success"]);

export function cardStateOf(status: string, transferPending: boolean): CardState {
  const s = status.toLowerCase();
  if (DONE.has(s)) return transferPending ? "transfer_pending" : "succeeded";
  if (QUEUED.has(s)) return "queued";
  if (ACTIVE.has(s)) return "running";
  if (s === "canceled" || s === "cancelled") return "canceled";
  return "failed";
}

export function openInAtlasUrl(modelId: string | undefined): string {
  if (!modelId) return SITE_URL;
  if (modelId.startsWith("atlascloud/studio/") || modelId.startsWith("atlascloud/workflow/")) {
    return `${SITE_URL}/workflow/history`;
  }
  return `${SITE_URL}/models/${modelId}`;
}

export function priceOf(raw: unknown): number | undefined {
  const value = typeof raw === "string" ? Number.parseFloat(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isoOf(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

export function buildGenerationCardData(input: {
  predictionId: string;
  status: string;
  outputs: readonly string[];
  transferPending: boolean;
  modelId?: string;
  modelName?: string;
  modelType?: string;
  price?: unknown;
  error?: string;
  createdAt?: string;
  completedAt?: string;
  mediaExpired?: boolean;
}): GenerationCardData {
  const state = cardStateOf(input.status, input.transferPending);
  const price = priceOf(input.price);
  return {
    state,
    prediction_id: input.predictionId,
    ...(input.modelId ? { model_id: input.modelId } : {}),
    ...(input.modelName ? { model_name: input.modelName } : {}),
    ...(input.modelType ? { model_type: input.modelType } : {}),
    ...(price !== undefined ? { price_usd: price } : {}),
    media: input.outputs.map((url) => ({ url, kind: cardMediaKind(url) })),
    ...(input.error ? { error: input.error } : {}),
    open_url: openInAtlasUrl(input.modelId),
    ...(input.createdAt ? { submitted_at: input.createdAt } : {}),
    ...(input.completedAt ? { completed_at: input.completedAt } : {}),
    ...(input.mediaExpired ? { media_expired: true } : {}),
  };
}

// 上游临时链接 24 小时过期，Atlas 存储约 15 天。刚完成的结果不用查，
// 放了快一天的才发一次 HEAD 确认还能打开，打不开就让卡片显示「链接过期」。
const EXPIRY_CHECK_AFTER_SECONDS = 20 * 60 * 60;

// 模型目录冷启动要拉整份列表（实测十几秒）。卡片上的模型名只是锦上添花，
// 最多等这么久，拿不到就显示模型 ID，不拖慢查结果本身。
export const MODEL_LOOKUP_TIMEOUT_MS = 3_000;

export async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 从查结果接口的返回拼卡片数据。模型名查不到、HEAD 失败都不影响结果。 */
export async function predictionCardData(
  predictionId: string,
  result: PredictionResponse,
  options: { checkExpiry?: (url: string) => Promise<boolean | null> } = {}
): Promise<GenerationCardData> {
  const data = (result.data ?? {}) as Record<string, unknown>;
  const status = result.data?.status || "unknown";
  const outputs = predictionOutputUrls(result);
  const transferPending =
    isFinished(status) && hasUntransferredMedia(outputs, completedAtOf(result));
  const modelId = typeof data.model === "string" ? data.model : undefined;
  const completedAt = isoOf(completedAtOf(result));
  const age = secondsSince(completedAt);
  const checkExpiry =
    isFinished(status) && !transferPending && outputs.length > 0 && age !== null && age > EXPIRY_CHECK_AFTER_SECONDS;
  const [model, stillServes] = await Promise.all([
    // 查不到名字时卡片退回显示模型 ID。
    modelId ? settleWithin(findModelByExactId(modelId), MODEL_LOOKUP_TIMEOUT_MS) : undefined,
    checkExpiry ? (options.checkExpiry ?? ((url: string) => headStillServes(url)))(outputs[0]) : null,
  ]);
  const mediaExpired = stillServes === false;
  return buildGenerationCardData({
    predictionId,
    status,
    outputs,
    transferPending,
    modelId,
    modelName: model?.displayName,
    modelType: model?.type,
    price: data.price,
    error: result.data?.error || undefined,
    createdAt: isoOf(createdAtOf(result)),
    completedAt,
    mediaExpired,
  });
}

/**
 * 卡片自己刷新用。和 atlas_get_prediction 读同一个接口、同样在服务端等一会儿，
 * 但只回卡片数据：不附图片预览块、不写给模型的指引，轮询起来轻。
 */
export function registerCardStatusTool(server: McpServer): void {
  server.registerTool(
    CARD_STATUS_TOOL,
    {
      title: "Refresh Generation Card",
      description:
        "Used by the Atlas Cloud generation card to refresh itself. Not for direct use: call atlas_get_prediction instead.",
      inputSchema: {
        prediction_id: predictionIdSchema.describe("Prediction ID shown on the card"),
      },
      annotations: { ...CARD_TOOL_POLICIES.atlas_card_status.annotations },
      // 只给卡片调，不挂 resourceUri：它自己不渲染卡片（ChatGPT 对挂了的私有工具会提示
      // 「无法渲染其小组件」）。
      _meta: {
        ui: { visibility: ["app"] },
        "openai/widgetAccessible": true,
        "openai/visibility": "private",
      },
    },
    async ({ prediction_id }) => {
      try {
        const { result } = await waitForPrediction((budget) =>
          generationApi<PredictionResponse>(
            `/model/prediction/${encodeURIComponent(prediction_id)}`,
            {
              responseSchema: predictionResponseSchema,
              timeout: budget.timeoutMs,
              maxRetries: budget.maxRetries,
            }
          )
        );
        const card = await predictionCardData(prediction_id, result);
        return {
          _meta: { [CARD_META_KEY]: card },
          structuredContent: { card },
          content: [{ type: "text", text: `Prediction ${prediction_id}: ${card.state}` }],
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleError(error) }] };
      }
    }
  );
}
