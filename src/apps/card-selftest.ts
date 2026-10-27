import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CARD_META_KEY,
  buildGenerationCardData,
  generationCardToolMeta,
} from "./generation-card.js";

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

type Variant = keyof typeof VARIANTS;

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
          .enum(Object.keys(VARIANTS) as [Variant, ...Variant[]])
          .default("image")
          .describe("Which card state to show"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
      _meta: generationCardToolMeta(),
    },
    async ({ variant }) => {
      const sample = VARIANTS[variant];
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
