import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CARD_META_KEY,
  type GenerationCardData,
  buildGenerationCardData,
  cardMediaKind,
  cardStateOf,
  generationCardToolMeta,
} from "./generation-card.js";
import { settingsChips } from "./generation-quote.js";
import { HISTORY_META_KEY, type HistoryCardData, type HistoryCardItem } from "./history-card.js";

// 测试卡片：不调接口、不花钱，用官网公开的示例素材把生成卡的各个状态渲染出来，
// 用来在 ChatGPT、Claude 里核对卡片长得对不对。只在 MCP_UI_SELFTEST 打开的环境注册。

const STATIC = "https://static.atlascloud.ai";

const VARIANTS = {
  image: {
    status: "completed",
    model: "bytedance/seedream-v4.7",
    name: "Seedream v4.7",
    type: "Image",
    price: "0.03",
    outputs: [`${STATIC}/model/example/material/product-shot-01.jpg`],
  },
  images: {
    status: "completed",
    model: "bytedance/seedream-v4.7",
    name: "Seedream v4.7",
    type: "Image",
    price: "0.12",
    outputs: [1, 2, 3, 4].map((n) => `${STATIC}/model/example/material/product-shot-0${n}.jpg`),
  },
  video: {
    status: "completed",
    model: "bytedance/seedance-2.5/text-to-video",
    name: "Dreamina Seedance 2.5",
    type: "Video",
    price: "1.34",
    outputs: [`${STATIC}/model/example/atlascloud-studio-ugc-ad-showcase-v2.mp4`],
  },
  audio: {
    status: "completed",
    model: "minimax/music-3.0",
    name: "MiniMax Music 3.0",
    type: "Audio",
    price: "0.15",
    outputs: [`${STATIC}/media/audios/e2dc7a83369471fa682d57647eb0a289.mp3`],
  },
  workflow: {
    status: "completed",
    model: "atlascloud/studio/product-visuals",
    name: "Image ads",
    type: "Image",
    price: "0.2593",
    outputs: [`${STATIC}/marketing-studio/showcase/wf-product-visuals-1.jpg`],
  },
  queued: {
    status: "queued",
    model: "bytedance/seedance-2.5/text-to-video",
    name: "Dreamina Seedance 2.5",
    type: "Video",
    price: "1.34",
    outputs: [],
  },
  running: {
    status: "processing",
    model: "bytedance/seedance-2.5/text-to-video",
    name: "Dreamina Seedance 2.5",
    type: "Video",
    price: undefined,
    outputs: [],
  },
  failed: {
    status: "failed",
    model: "bytedance/seedance-2.5/text-to-video",
    name: "Dreamina Seedance 2.5",
    type: "Video",
    price: undefined,
    outputs: [],
  },
  canceled: {
    status: "canceled",
    model: "bytedance/seedance-2.5/text-to-video",
    name: "Dreamina Seedance 2.5",
    type: "Video",
    price: undefined,
    outputs: [],
  },
  // 故意给一个打不开的链接，看卡片「预览不可用」的样子。
  blocked: {
    status: "completed",
    model: "bytedance/seedream-v4.7",
    name: "Seedream v4.7",
    type: "Image",
    price: "0.03",
    outputs: ["https://www.atlascloud.ai/selftest/preview-unavailable.jpg"],
  },
  expired: {
    status: "completed",
    model: "bytedance/seedream-v4.7",
    name: "Seedream v4.7",
    type: "Image",
    price: "0.03",
    outputs: [`${STATIC}/model/example/material/product-shot-01.jpg`],
  },
} as const;

// 报价卡样例：参数照一单 Seedance 2.5 文生视频填，价格是示例数字。
const QUOTE_SAMPLE = {
  tool: "atlas_generate_video",
  model: "bytedance/seedance-2.5/text-to-video",
  name: "Dreamina Seedance 2.5",
  params: { prompt: "A beer bottle splashing into icy water", resolution: "1080p", duration: 10, aspect_ratio: "16:9", generate_audio: true },
};

const QUOTE_VARIANTS = {
  quote: { estimated: 1.34, partial: false, expired: false, problem: undefined },
  quote_partial: { estimated: 1.34, partial: true, expired: false, problem: undefined },
  quote_unpriced: { estimated: undefined, partial: false, expired: false, problem: undefined },
  quote_expired: { estimated: 1.34, partial: false, expired: true, problem: undefined },
  quote_low_balance: { estimated: 1.34, partial: false, expired: false, problem: "insufficient_balance" as const },
} as const;

type Variant = keyof typeof VARIANTS | keyof typeof QUOTE_VARIANTS | "history";

// 历史列表卡样例：条目号 selftest_<样例名>，卡片点开时打开对应的测试卡片。
function historySample(): HistoryCardData {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const entry = (variant: keyof typeof VARIANTS, minutes: number): HistoryCardItem => {
    const sample = VARIANTS[variant];
    const first = sample.outputs[0];
    const state = cardStateOf(sample.status, false);
    return {
      prediction_id: `selftest_${variant}`,
      model_id: sample.model,
      model_name: sample.name,
      model_type: sample.type,
      state,
      created_at: minutesAgo(minutes),
      ...(first ? { thumb: { url: first, kind: cardMediaKind(first) } } : {}),
      outputs: sample.outputs.length,
      ...(sample.price && state === "succeeded" ? { price_usd: Number.parseFloat(sample.price) } : {}),
      ...(variant === "failed" ? { error: "Upstream timeout" } : {}),
    };
  };
  const items = [
    entry("running", 2),
    entry("video", 25),
    entry("images", 90),
    entry("audio", 60 * 20),
    entry("failed", 60 * 26),
    entry("workflow", 60 * 50),
    entry("image", 60 * 75),
  ];
  return { view: "history", page: 1, size: 10, total: items.length, has_more: false, items, sample: true };
}

function quoteSample(variant: keyof typeof QUOTE_VARIANTS): GenerationCardData {
  const sample = QUOTE_VARIANTS[variant];
  const validMs = sample.expired ? -60_000 : 10 * 60_000;
  return {
    ...buildGenerationCardData({
      predictionId: "",
      status: "quote",
      outputs: [],
      transferPending: false,
      modelId: QUOTE_SAMPLE.model,
      modelName: QUOTE_SAMPLE.name,
      modelType: "Video",
    }),
    state: "quote",
    quote: {
      tool: QUOTE_SAMPLE.tool,
      arguments: { model: QUOTE_SAMPLE.model, params: QUOTE_SAMPLE.params },
      idempotency_key: `selftest-${variant}`,
      confirmation_token: "selftest",
      expires_at: new Date(Date.now() + validMs).toISOString(),
      ...(sample.estimated !== undefined ? { estimated_usd: sample.estimated } : {}),
      ...(sample.partial ? { partial: true } : {}),
      settings: settingsChips(QUOTE_SAMPLE.params),
      ...(sample.problem ? { problem: sample.problem } : {}),
    },
  };
}

export function registerCardSelftestTool(server: McpServer): void {
  server.registerTool(
    "atlas_card_selftest",
    {
      title: "Card Self-test",
      description:
        "Development only. Renders the Atlas Cloud generation card with sample media so the card can be checked in a client. " +
        "It does not call Atlas Cloud and costs nothing.",
      inputSchema: {
        variant: z
          .enum([...Object.keys(VARIANTS), ...Object.keys(QUOTE_VARIANTS), "history"] as string[] as [Variant, ...Variant[]])
          .default("image")
          .describe("Which card state to show"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
      _meta: generationCardToolMeta(),
    },
    async ({ variant }) => {
      if (variant === "history") {
        const history = historySample();
        return {
          _meta: { [HISTORY_META_KEY]: history },
          structuredContent: { total: history.total, page: 1, size: 10, has_more: false, predictions: [] },
          content: [{ type: "text", text: "Self-test history card rendered with sample tasks. Nothing was read or billed." }],
        };
      }
      if (variant in QUOTE_VARIANTS) {
        const card = quoteSample(variant as keyof typeof QUOTE_VARIANTS);
        return {
          _meta: { [CARD_META_KEY]: { ...card, sample: true } },
          structuredContent: { status: "confirmation_required", model_id: QUOTE_SAMPLE.model, model_name: QUOTE_SAMPLE.name },
          content: [
            { type: "text", text: `Self-test quote card "${variant}" rendered with sample data. Nothing was quoted, generated or billed.` },
          ],
        };
      }
      const sample = VARIANTS[variant as keyof typeof VARIANTS];
      const predictionId = `selftest_${variant}`;
      const card = buildGenerationCardData({
        predictionId,
        status: sample.status,
        outputs: sample.outputs,
        transferPending: false,
        modelId: sample.model,
        modelName: sample.name,
        modelType: sample.type,
        price: sample.price,
        error: variant === "failed" ? "Upstream timeout" : undefined,
        createdAt: new Date(Date.now() - 102_000).toISOString(),
        mediaExpired: variant === "expired",
      });
      return {
        _meta: { [CARD_META_KEY]: { ...card, sample: true } },
        structuredContent: { prediction_id: predictionId, status: sample.status, outputs: [...sample.outputs] },
        content: [
          {
            type: "text",
            text: `Self-test card "${variant}" rendered with sample media. Nothing was generated or billed.`,
          },
        ],
      };
    }
  );
}
