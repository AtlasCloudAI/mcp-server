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
import { inputsOf, promptOf, settingsChips } from "./card-params.js";
import { HISTORY_META_KEY, type HistoryCardData, type HistoryCardItem } from "./history-card.js";
import { UPLOAD_MAX_FILES, UPLOAD_META_KEY, type UploadCardData, type UploadSampleFile } from "./upload-card.js";
import { ASSETS_MAX_PICK, ASSETS_META_KEY, type AssetCardData, type AssetCardItem } from "./asset-library.js";

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
    price: "1.34",
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
  failed_rate_limited: {
    status: "failed",
    model: "bytedance/seedance-2.5/text-to-video",
    name: "Dreamina Seedance 2.5",
    type: "Video",
    price: undefined,
    outputs: [],
  },
  failed_unavailable: {
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
  // 出了结果、还没结算：卡片写 Charge pending，不写价格也不写 $0。
  charge_pending: {
    status: "completed",
    model: "bytedance/seedream-v4.7",
    name: "Seedream v4.7",
    type: "Image",
    price: undefined,
    outputs: [`${STATIC}/model/example/material/product-shot-01.jpg`],
  },
  // 审核没过但已经扣了一部分：失败卡写清扣了多少。
  failed_partial: {
    status: "failed",
    model: "bytedance/seedance-2.5/text-to-video",
    name: "Dreamina Seedance 2.5",
    type: "Video",
    price: "0.05",
    outputs: [],
  },
  // 网关原样透传的工作流报错（验收问题 33）：卡片应该只写「缺 resolution」，任务号不被挤出卡片。
  failed_gateway: {
    status: "failed",
    model: "atlascloud/studio/product-visuals",
    name: "Image ads",
    type: "Image",
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
  // 5 个以上：卡里摆 4 格，第 4 格写「+2」（设计稿 v2「多张 · 5 张以上」）。
  images_many: {
    status: "completed",
    model: "bytedance/seedream-v4.7",
    name: "Seedream v4.7",
    type: "Image",
    price: "0.18",
    outputs: [1, 2, 3, 4, 5, 6].map((n) => `${STATIC}/model/example/material/product-shot-0${n}.jpg`),
  },
  // 3D：聊天里看不了，只给文件和下载。链接只用来显示文件名。
  model_3d: {
    status: "completed",
    model: "tencent/hunyuan3d-pro/image-to-3d",
    name: "Hunyuan 3D Pro",
    type: "Image",
    price: "0.3",
    outputs: [`${STATIC}/selftest/sneaker-model.glb`],
  },
  // 刷新时 Atlas 登录失效了：卡片请用户重新连接（设计稿 v2「需要重新连接」）。
  signed_out: {
    status: "processing",
    model: "bytedance/seedance-2.5/text-to-video",
    name: "Dreamina Seedance 2.5",
    type: "Video",
    price: "1.34",
    outputs: [],
  },
  // Marketing Studio 模板跑着：进度卡标题写模板名（设计稿 v2「模板执行中」）。
  // 卡片自己等太久还没结果（设计稿 wait_timeout）：「Still generating」+ Keep waiting。
  running_stalled: {
    status: "processing",
    model: "bytedance/seedance-2.5/text-to-video",
    name: "Dreamina Seedance 2.5",
    type: "Video",
    price: "1.34",
    outputs: [],
  },
  // 任务完成但预览加载不出来（设计稿 preview blocked）：Retry preview + Download。地址故意指向不存在的文件。
  preview_failed: {
    status: "completed",
    model: "bytedance/seedream-v4.7",
    name: "Seedream v4.7",
    type: "Image",
    price: "0.03",
    outputs: [`${STATIC}/model/example/material/selftest-missing-preview.jpg`],
  },
  template_running: {
    status: "processing",
    model: "atlascloud/studio/product-visuals",
    name: "Image ads",
    type: "Image",
    price: "0.24",
    outputs: [],
  },
} as const;

// 失败样例的原因：普通失败、上游限流、模型暂时不可用（卡片按原因换样子）。
const FAILED_REASONS: Partial<Record<string, string>> = {
  failed: "Upstream timeout",
  failed_rate_limited: "Too Many Requests (429): the provider rate limit was exceeded",
  failed_unavailable: "The model is temporarily unavailable: ServerOverloaded",
  failed_partial: "Output rejected by content review",
  failed_gateway:
    'unexpected http status code: 502, body: {"code":400,"message":"workflow error: Missing required parameters：\'resolution\'","data":null,"request_id":"7703890691595698176"}',
};

// 网关给的扣费状态（aiproxy#1074）；没列的样例按老网关处理（没有这个字段）。
const CHARGE_SAMPLES: Partial<Record<string, string>> = {
  charge_pending: "pending",
  failed_partial: "partially_charged",
};

// 结果卡、进度卡上的主要参数（示例）。
const SETTINGS_SAMPLES: Record<string, string[]> = {
  Image: ["2048 × 2048"],
  // 和样例媒体一致：样例视频是竖版，样例音频 1:41。
  Video: ["1080p", "10 s", "9:16", "Audio"],
  Audio: ["101 s"],
};

// 报价卡上的扣费账户和余额（需求文档 6.1），示例数字。
// 和真实报价一致：卡片不带邮箱（设计稿 v3，11-10）。
const QUOTE_ACCOUNT = { name: "Ada Lovelace", type: "personal", balance_usd: 24.6 } as const;

// 报价卡样例：参数照一单 Seedance 2.5 文生视频填，价格是示例数字。
const QUOTE_SAMPLE = {
  tool: "atlas_generate_video",
  model: "bytedance/seedance-2.5/image-to-video",
  name: "Dreamina Seedance 2.5",
  params: {
    prompt: "The perfume bottle turns slowly on wet black stone, water splashing around it, macro lens, slow push-in",
    image: `${STATIC}/model/example/material/product-shot-01.jpg`,
    resolution: "1080p",
    duration: 10,
    aspect_ratio: "16:9",
    generate_audio: true,
  },
};

// balance、previous：余额不足、价格变了两个状态里显示的示例数字。
const QUOTE_VARIANTS = {
  quote: { estimated: 1.34, partial: false, expired: false, problem: undefined, balance: undefined, previous: undefined },
  quote_partial: { estimated: 1.34, partial: true, expired: false, problem: undefined, balance: undefined, previous: undefined },
  quote_unpriced: { estimated: undefined, partial: false, expired: false, problem: undefined, balance: undefined, previous: undefined },
  quote_expired: { estimated: 1.34, partial: false, expired: true, problem: undefined, balance: undefined, previous: undefined },
  quote_low_balance: { estimated: 1.34, partial: false, expired: false, problem: "insufficient_balance", balance: 0.42, previous: undefined },
  quote_price_changed: { estimated: 1.52, partial: false, expired: false, problem: "price_changed", balance: undefined, previous: 1.34 },
  quote_settings_changed: { estimated: 1.34, partial: false, expired: false, problem: "settings_changed", balance: undefined, previous: undefined },
  quote_rate_limited: { estimated: 1.34, partial: false, expired: false, problem: "rate_limited", balance: undefined, previous: undefined },
  quote_model_unavailable: { estimated: 1.34, partial: false, expired: false, problem: "model_unavailable", balance: undefined, previous: undefined },
  // Marketing Studio 模板的报价：整套模板一个总价（设计稿 v2「模板方案」）。
  quote_template: { estimated: 0.24, partial: false, expired: false, problem: undefined, balance: undefined, previous: undefined },
  // 确认时发现第二张参考图已从资产库删掉（设计稿 v2「素材失效」）。
  quote_input_missing: { estimated: 1.34, partial: false, expired: false, problem: "input_missing", balance: undefined, previous: undefined },
  // 确认时 Atlas 登录失效了（设计稿 v2「需要重新连接」）。
  quote_signed_out: { estimated: 1.34, partial: false, expired: false, problem: "signed_out", balance: undefined, previous: undefined },
  // 点了确认之后的过渡状态（设计稿 submitting / submission_unknown）：提交中、核实有没有开始、核实不出来。
  quote_submitting: { estimated: 1.34, partial: false, expired: false, problem: "submitting", balance: undefined, previous: undefined },
  quote_checking: { estimated: 1.34, partial: false, expired: false, problem: "verifying", balance: undefined, previous: undefined },
  quote_uncertain: { estimated: 1.34, partial: false, expired: false, problem: "uncertain", balance: undefined, previous: undefined },
  // 同一个请求还在处理（设计稿 idempotency_in_progress）：明确在跑，只给 Refresh。
  quote_in_progress: { estimated: 1.34, partial: false, expired: false, problem: "in_progress", balance: undefined, previous: undefined },
} as const;

// 模板报价样例：Image ads 出 4 张，素材是上传卡传的耳机图。
const TEMPLATE_SAMPLE = {
  tool: "atlas_generate_image",
  model: "atlascloud/studio/product-visuals",
  name: "Image ads",
  params: {
    user_prompt: "Four ad images for my wireless earbuds: clean studio, lifestyle, close-up and a gym scene",
    product_image: [`${STATIC}/model/example/material/product-shot-05.jpg`],
    count: 4,
    ratio: "1:1",
  },
};

type Variant = keyof typeof VARIANTS | keyof typeof QUOTE_VARIANTS | "history" | (typeof ASSET_VARIANTS)[number];

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

// 上传卡的各个状态：文件预先摆好，卡片只显示、不真传（设计稿「上传 · Upload」）。
const MB = 1_048_576;
const FRONT = { name: "sneaker-front.jpg", size_bytes: Math.round(2.4 * MB), kind: "image", url: `${STATIC}/model/example/material/product-shot-01.jpg` } as const;
const SIDE = { name: "sneaker-side.jpg", size_bytes: Math.round(1.8 * MB), kind: "image", url: `${STATIC}/model/example/material/product-shot-02.jpg` } as const;
const UPLOAD_VARIANTS: Record<
  string,
  {
    files: UploadSampleFile[];
    expired?: boolean;
    signedOut?: boolean;
    overflow?: { picked: number; added: number };
    libraryFull?: boolean;
  }
> = {
  upload: { files: [] },
  upload_uploading: {
    files: [
      { ...FRONT, status: "uploading", progress: 0.64 },
      { ...SIDE, status: "done" },
    ],
  },
  upload_done: { files: [{ ...FRONT, status: "done" }, { ...SIDE, status: "done" }] },
  // 格式、大小、像素各不符合一个（设计稿 06 页 11/02「文件不符合」）。
  upload_problem: {
    files: [
      { name: "brand-notes.pdf", size_bytes: Math.round(0.3 * MB), kind: "other", status: "invalid", error: "Format not supported · use an image, video or audio file" },
      { name: "lookbook.png", size_bytes: Math.round(68 * MB), kind: "image", status: "invalid", error: "over the 50 MB limit" },
      { name: "campaign-hero.png", size_bytes: Math.round(31 * MB), kind: "image", status: "invalid", error: "over the 24 MP limit", megapixels: 52 },
    ],
  },
  upload_failed: { files: [{ ...FRONT, status: "failed", error: "Upload failed" }] },
  upload_expired: { files: [{ ...FRONT, status: "uploading", progress: 0 }], expired: true },
  // 传到一半 Atlas 登录失效了：换地址被拒，等用户重新连接（设计稿 v2「需要重新连接」）。
  upload_signed_out: { files: [{ ...FRONT, status: "done" }, { ...SIDE, status: "uploading", progress: 0 }], signedOut: true },
  // 一次选了 12 个：只收前 10 个（设计稿 v2「超出数量上限」）。
  upload_too_many: {
    files: Array.from({ length: 10 }, (_, i) => ({ ...(i % 2 ? SIDE : FRONT), name: `product-${i + 1}.jpg`, status: "done" as const })),
    overflow: { picked: 12, added: 10 },
  },
  // 资产库上传空间满了：文件改走普通上传，照样能用，只是没存进资产库（设计稿 06 页 11/02「上传空间已满」）。
  upload_library_full: { files: [{ ...FRONT, status: "done" }, { ...SIDE, status: "done" }], libraryFull: true },
};

function uploadSample(variant: string): UploadCardData {
  const sample = UPLOAD_VARIANTS[variant]!;
  return {
    view: "upload",
    upload_url: "https://example.invalid/upload/selftest",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    // 资产库二期的上限：上传存进资产库，图片、音频 50 MB，视频 100 MB。
    max_bytes: 50 * MB,
    max_video_bytes: 100 * MB,
    max_image_pixels: 24_000_000,
    library: true,
    max_files: UPLOAD_MAX_FILES,
    sample: true,
    sample_files: sample.files,
    ...(sample.expired ? { sample_expired: true } : {}),
    ...(sample.signedOut ? { sample_signed_out: true } : {}),
    ...(sample.overflow ? { sample_overflow: sample.overflow } : {}),
    ...(sample.libraryFull ? { sample_library_full: { quota_bytes: 2 * 1024 * MB } } : {}),
  };
}

// 资产库卡：设计稿「全屏视图」里的「从资产库选取」和「资产库为空」。示例素材是公开的产品图。
// assets_no_match：搜「red sneaker」没找到；assets_locked：资产库没开通（充值后才能用）；
// assets_signed_out：Atlas 登录失效了，点 Reconnect 后显示样例素材。
const ASSET_VARIANTS = ["assets", "assets_empty", "assets_no_match", "assets_locked", "assets_signed_out"] as const;

function assetsSample(variant: string): AssetCardData {
  const day = 86_400_000;
  if (variant === "assets_locked") return { view: "assets", items: [], max_pick: ASSETS_MAX_PICK, locked: true, sample: true };
  if (variant === "assets_signed_out") return { ...assetsSample("assets"), sample_signed_out: true };
  if (variant === "assets_no_match") return { view: "assets", query: "red sneaker", items: [], max_pick: ASSETS_MAX_PICK, sample: true };
  const items: AssetCardItem[] =
    variant === "assets_empty"
      ? []
      : [
          ...Array.from({ length: 11 }, (_, i): AssetCardItem => ({
            asset_id: `asset_selftest${String(i + 1).padStart(2, "0")}`,
            label: i === 0 ? "sneaker-front.jpg" : `Image · product-shot-${String(i + 1).padStart(2, "0")}`,
            kind: "image",
            origin: i < 4 ? "upload" : "generated",
            thumb_url: `${STATIC}/model/example/material/product-shot-${String(i + 1).padStart(2, "0")}.jpg`,
            created_at: new Date(Date.now() - i * day).toISOString(),
          })),
          {
            asset_id: "asset_selftest_video",
            label: "Video · ugc-ad result",
            kind: "video",
            origin: "generated",
            preview_url: `${STATIC}/model/example/atlascloud-studio-ugc-ad-showcase-v2.mp4`,
            created_at: new Date(Date.now() - 12 * day).toISOString(),
            model: "atlascloud/studio/ugc-ad",
          },
          { asset_id: "asset_selftest_audio", label: "Audio · MiniMax Music 3.0 result", kind: "audio", origin: "generated", created_at: new Date(Date.now() - 13 * day).toISOString() },
          { asset_id: "asset_selftest_3d", label: "sneaker-model.glb", kind: "3d", origin: "upload", created_at: new Date(Date.now() - 14 * day).toISOString() },
        ];
  return { view: "assets", items, max_pick: ASSETS_MAX_PICK, sample: true };
}

function quoteSample(variant: keyof typeof QUOTE_VARIANTS): GenerationCardData {
  const sample = QUOTE_VARIANTS[variant];
  const validMs = sample.expired ? -60_000 : 60 * 60_000;
  const template = variant === "quote_template";
  const missing = variant === "quote_input_missing";
  const base = template
    ? TEMPLATE_SAMPLE
    : missing
      ? { ...QUOTE_SAMPLE, params: { ...QUOTE_SAMPLE.params, reference_images: [QUOTE_SAMPLE.params.image, `${STATIC}/model/example/material/product-shot-02.jpg`] } }
      : QUOTE_SAMPLE;
  // 素材来源：普通样例是从资产库选的，模板样例是上传卡传的。
  const source = template ? ("upload" as const) : ("library" as const);
  return {
    ...buildGenerationCardData({
      predictionId: "",
      status: "quote",
      outputs: [],
      transferPending: false,
      modelId: base.model,
      modelName: base.name,
      modelType: template ? "Image" : "Video",
    }),
    state: "quote",
    quote: {
      tool: base.tool,
      arguments: { model: base.model, params: base.params },
      idempotency_key: `selftest-${variant}`,
      confirmation_token: "selftest",
      expires_at: new Date(Date.now() + validMs).toISOString(),
      ...(sample.estimated !== undefined ? { estimated_usd: sample.estimated } : {}),
      ...(sample.partial ? { partial: true } : {}),
      // Seedance 2.5 按实际用量结算。
      ...(variant === "quote" ? { settles_on_usage: true } : {}),
      ...(variant === "quote_partial" ? { estimate_missing: ["the reference videos' length"] } : {}),
      account: { ...QUOTE_ACCOUNT },
      prompt: promptOf(base.params),
      inputs: inputsOf(base.params).map((input) => ({ ...input, kind: cardMediaKind(input.url), source })),
      settings: settingsChips(base.params, undefined, template ? "image" : "video"),
      // 和真实报价一致：确认令牌 1 小时有效。
      valid_seconds: 3600,
      ...(sample.problem ? { problem: sample.problem } : {}),
      ...(sample.balance !== undefined ? { sample_balance_usd: sample.balance } : {}),
      ...(sample.previous !== undefined ? { sample_previous_usd: sample.previous } : {}),
      ...(missing ? { sample_missing: ["product-shot-02.jpg"] } : {}),
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
          .enum([...Object.keys(VARIANTS), ...Object.keys(QUOTE_VARIANTS), ...Object.keys(UPLOAD_VARIANTS), ...ASSET_VARIANTS, "history"] as string[] as [Variant, ...Variant[]])
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
      if ((ASSET_VARIANTS as readonly string[]).includes(variant)) {
        const assets = assetsSample(variant);
        return {
          _meta: { [ASSETS_META_KEY]: assets },
          structuredContent: { count: assets.items.length, assets: [] },
          content: [{ type: "text", text: `Self-test Asset Library card "${variant}" rendered with sample files. Nothing was read.` }],
        };
      }
      if (variant in UPLOAD_VARIANTS) {
        return {
          _meta: { [UPLOAD_META_KEY]: uploadSample(variant) },
          content: [{ type: "text", text: `Self-test upload card "${variant}" rendered with sample files. Nothing was uploaded.` }],
        };
      }
      if (variant in QUOTE_VARIANTS) {
        const card = quoteSample(variant as keyof typeof QUOTE_VARIANTS);
        return {
          _meta: { [CARD_META_KEY]: { ...card, sample: true } },
          structuredContent: { status: "confirmation_required", model_id: card.model_id, model_name: card.model_name },
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
        chargeStatus: CHARGE_SAMPLES[variant],
        settings: SETTINGS_SAMPLES[sample.type],
        error: FAILED_REASONS[variant],
        createdAt: new Date(Date.now() - 102_000).toISOString(),
        mediaExpired: variant === "expired",
      });
      return {
        _meta: {
          [CARD_META_KEY]: {
            ...card,
            sample: true,
            ...(variant === "signed_out" ? { sample_signed_out: true } : {}),
            ...(variant === "running_stalled" ? { sample_stalled: true } : {}),
          },
        },
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
