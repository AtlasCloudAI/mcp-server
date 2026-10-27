import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CARD_META_KEY,
  type GenerationCardData,
  buildGenerationCardData,
  clientRendersCards,
  generationCardEnabled,
  generationCardToolMeta,
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

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 参数里挑几个用户关心的做成小标签（设计稿：1080p · 10 s · 16:9 · Audio）。
 * 只认常见字段名，认不出来就不显示，不去猜。
 */
export function settingsChips(params: Record<string, unknown> | undefined): string[] {
  if (!params) return [];
  const chips: string[] = [];
  const resolution = params.resolution;
  if (typeof resolution === "string" && resolution.trim()) chips.push(resolution.trim());
  else if (typeof resolution === "number") chips.push(`${resolution}p`);

  for (const key of ["size", "image_size"]) {
    const size = params[key];
    if (typeof size === "string" && size.trim()) {
      chips.push(size.trim().replace(/^(\d+)\s*[*xX×]\s*(\d+)$/, "$1×$2"));
      break;
    }
    const box = record(size);
    if (box && positiveNumber(box.width) && positiveNumber(box.height)) {
      chips.push(`${box.width}×${box.height}`);
      break;
    }
  }

  // 顺序照设计稿：1080p · 10 s · 16:9 · Audio
  const duration = positiveNumber(params.duration);
  if (duration !== undefined) chips.push(`${duration} s`);

  // Kling、Veo 叫 aspect_ratio，Seedance、Wan 叫 ratio。
  const aspect = params.aspect_ratio ?? params.ratio;
  if (typeof aspect === "string" && aspect.trim()) chips.push(aspect.trim());

  for (const key of ["num_images", "max_images", "n", "count"]) {
    const n = positiveNumber(params[key]);
    if (n !== undefined && n > 1) {
      chips.push(`${n} images`);
      break;
    }
  }

  // 只认布尔 true：Wan 的 audio 也可能是一条音频链接。
  if ([params.generate_audio, params.audio, params.enable_audio, params.sound].some((v) => v === true)) {
    chips.push("Audio");
  }
  return chips.slice(0, 5);
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
    // 图片、视频、音频工具的参数在 params 里；快速生成直接平铺在参数上。
    const params = record(args.params) ?? callArgs;
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
        ...(validSeconds ? { expires_at: new Date(Date.now() + validSeconds * 1000).toISOString() } : {}),
        ...(estimate !== undefined ? { estimated_usd: estimate } : {}),
        ...(content.estimate_partial === true ? { partial: true } : {}),
        settings: settingsChips(params),
      },
    };
  }

  if (content.status === "submitted" || content.status === "completed") {
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
      }),
      retry: { tool, arguments: callArgs },
    };
  }
  return undefined;
}

const QUOTE_CARD_NOTE =
  "The Atlas card shows this quote with a Generate button. If the user approves it there, the " +
  "card submits this exact job and tracks it: do not call a generation tool for it again. If " +
  "they confirm in the chat instead, call again as described above; the same idempotency_key " +
  "returns the job the card already started rather than a second one.";

/**
 * 给生成工具的处理函数套一层：结果里带上卡片数据。卡片没打开时原样返回。
 * 客户端声明能渲染卡片时，报价结果再多一句话，告诉模型卡片上能直接确认。
 */
export function withGenerationCard<Args extends Record<string, unknown>, Extra>(
  server: McpServer,
  tool: (typeof CARD_GENERATION_TOOLS)[number],
  handler: (args: Args, extra: Extra) => Promise<CallToolResult>
): (args: Args, extra: Extra) => Promise<CallToolResult> {
  return async (args, extra) => {
    const result = await handler(args, extra);
    if (!generationCardEnabled() || result.isError) return result;
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
