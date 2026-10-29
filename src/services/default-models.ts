import type { Model } from "../types.js";
import { getModels } from "./doc-fetcher.js";

/**
 * 用户没点名模型时的默认路由（产品 10-28 定，10-29 定了档位和默认参数）。
 *
 * 每类按顺序排，取第一个「在线上目录里、且有这个任务变体」的；排在前面的下线了
 * 或者做不了这件事，就顺延到下一个。用户点名的模型永远优先。这张表只管文生 / 图生 /
 * 参考生视频和文生图 / 改图，对口型、视频编辑、超分、3D 这类任务不在范围里，
 * 照常从目录里挑。
 *
 * 「标准版」= 不带 -prime / -fast / -mini / -developer 后缀的那一档。默认参数见
 * routeDefaultParams：上游默认不一定是产品要的（Kling 4.0、Wan 3.0 默认 1080p，
 * Seedance、Wan 文生视频默认 adaptive 比例，Nano Banana 2.1 默认 auto 比例），所以
 * 服务端显式填上，报价和生成按同一组参数走。
 */
export type DefaultRouteTask =
  | "text-to-video"
  | "image-to-video"
  | "reference-to-video"
  | "text-to-image"
  | "edit";

export type DefaultRouteType = "Video" | "Image";

type RouteParams = Readonly<Record<string, unknown>>;

interface DefaultRouteEntry {
  name: string;
  models: Partial<Record<DefaultRouteTask, string>>;
  /** 调用方没给时填的参数，按任务变体分。 */
  params: Partial<Record<DefaultRouteTask, RouteParams>>;
}

// 视频统一 720p、5 秒（每次一条，上游本来就只出一条），不选 -sr / -esr 超分档。
const VIDEO_DEFAULTS: RouteParams = { resolution: "720p", duration: 5 };

/**
 * 文生视频默认 16:9；图生视频跟随输入图片比例，不填比例（Seedance 图生视频只认
 * adaptive，Kling、Wan 图生视频没有比例字段）；参考生视频需求没写，也不填。
 * ratioKey 是这个家族的比例字段名：Seedance、Wan 叫 ratio，Kling 叫 aspect_ratio。
 */
function videoFamily(name: string, family: string, ratioKey: string): DefaultRouteEntry {
  return {
    name,
    models: {
      "text-to-video": `${family}/text-to-video`,
      "image-to-video": `${family}/image-to-video`,
      "reference-to-video": `${family}/reference-to-video`,
    },
    params: {
      "text-to-video": { ...VIDEO_DEFAULTS, [ratioKey]: "16:9" },
      "image-to-video": VIDEO_DEFAULTS,
      "reference-to-video": VIDEO_DEFAULTS,
    },
  };
}

function imageFamily(
  name: string,
  family: string,
  textToImage: RouteParams,
  edit: RouteParams = textToImage
): DefaultRouteEntry {
  return {
    name,
    models: { "text-to-image": `${family}/text-to-image`, edit: `${family}/edit` },
    params: { "text-to-image": textToImage, edit },
  };
}

export const DEFAULT_MODEL_ROUTES: Record<DefaultRouteType, readonly DefaultRouteEntry[]> = {
  Video: [
    videoFamily("Seedance 2.5", "bytedance/seedance-2.5", "ratio"),
    videoFamily("Kling 4.0", "kwaivgi/kling-v4.0", "aspect_ratio"),
    videoFamily("Wan 3.0", "alibaba/wan-3.0", "ratio"),
    videoFamily("Seedance 2.0", "bytedance/seedance-2.0", "ratio"),
  ],
  Image: [
    imageFamily("Seedream 5.0 Pro", "bytedance/seedream-v5.0-pro", { size: "2048*2048" }),
    imageFamily("GPT Image 2.5 Sunburst", "openai/gpt-image-2.5-sunburst", {
      size: "1024x1024",
      quality: "medium",
      n: 1,
    }),
    // 改图跟随输入图片比例（auto），和图生视频同一个原则；文生图按需求 1:1。
    imageFamily(
      "Nano Banana 2.1",
      "google/nano-banana-2.1",
      { resolution: "1k", aspect_ratio: "1:1" },
      { resolution: "1k" }
    ),
    imageFamily("GPT Image 2", "openai/gpt-image-2", { size: "1024x1024", quality: "medium" }),
  ],
};

// 写进工具描述的默认参数，和上面的表一一对应。
const DEFAULT_SETTINGS: Record<DefaultRouteType, string> = {
  Video:
    "Default settings for these models are 720p, 5 seconds and one video, with 16:9 for text-to-video; " +
    "image-to-video keeps the input image's aspect ratio, and upscaled resolutions (-sr / -esr) are off. ",
  Image:
    "Default settings for these models are one image at Seedream 5.0 Pro 2048*2048, " +
    "GPT Image 2.5 Sunburst and GPT Image 2 1024x1024 at medium quality, and Nano Banana 2.1 1k at 1:1 " +
    "(its edit variant keeps the input image's aspect ratio). ",
};

const TASK_LABELS: Record<DefaultRouteTask, string> = {
  "text-to-video": "a prompt only",
  "image-to-video": "a first-frame image",
  "reference-to-video": "reference images, videos or audio",
  "text-to-image": "a prompt only",
  edit: "input images to edit or combine",
};

function familyOf(entry: DefaultRouteEntry): string {
  const first = Object.values(entry.models)[0] ?? "";
  return first.slice(0, first.lastIndexOf("/"));
}

/**
 * 写进生成工具描述的默认路由说明。工具描述是 ChatGPT 这类客户端唯一可靠会读的
 * 地方，所以把完整 ID 写出来，不让模型自己猜变体。只陈述事实、不下命令：ChatGPT
 * 会把指挥模型怎么做的工具描述标成「可疑指令」，「别按价格挑」放在服务器说明里。
 */
export function defaultRouteGuidance(type: DefaultRouteType): string {
  const [first, ...rest] = DEFAULT_MODEL_ROUTES[type];
  const variants = Object.entries(first!.models)
    .map(([task, id]) => `${id} for ${TASK_LABELS[task as DefaultRouteTask]}`)
    .join(", ");
  const fallbacks = rest.map((entry) => `${entry.name} (${familyOf(entry)}/…)`).join(", then ");
  return (
    `Default model: when the user has not named a model, the default is ${first!.name} — ${variants}. ` +
    `When it is missing from atlas_list_models or cannot take the inputs, the same variant of the next model in this order applies: ${fallbacks}. ` +
    DEFAULT_SETTINGS[type] +
    "The server fills in any of these settings the request leaves out; values the user asks for take precedence. " +
    "A model the user names takes precedence, and tasks outside these variants are chosen from the catalog."
  );
}

/**
 * 默认路由模型的默认参数（不管这个模型是用户点名的还是路由选的）。不在路由表里的
 * 模型返回空对象，照旧用上游默认。
 */
export function routeDefaultParams(modelId: string): RouteParams {
  for (const entries of Object.values(DEFAULT_MODEL_ROUTES)) {
    for (const entry of entries) {
      for (const [task, id] of Object.entries(entry.models)) {
        if (id === modelId) return entry.params[task as DefaultRouteTask] ?? {};
      }
    }
  }
  return {};
}

/** 服务器说明里的一句话版本。 */
export function defaultRouteSummary(): string {
  const chain = (type: DefaultRouteType) =>
    DEFAULT_MODEL_ROUTES[type].map((entry) => entry.name).join(" → ");
  return (
    "When the user does not name a model, follow the default route in the generation tool descriptions " +
    `(video: ${chain("Video")}; image: ${chain("Image")}) instead of picking by price. `
  );
}

/** 按输入推断任务变体：带图就是图生视频 / 改图。 */
export function defaultRouteTask(
  type: DefaultRouteType,
  inputs: { hasImage: boolean }
): DefaultRouteTask {
  if (type === "Video") return inputs.hasImage ? "image-to-video" : "text-to-video";
  return inputs.hasImage ? "edit" : "text-to-image";
}

/** 路由里第一个在线上目录里的模型；整条路由都不在目录里时返回 undefined。 */
export function pickDefaultModel(
  models: readonly Model[],
  type: DefaultRouteType,
  task: DefaultRouteTask
): Model | undefined {
  const byId = new Map(models.map((model) => [model.model, model]));
  for (const entry of DEFAULT_MODEL_ROUTES[type]) {
    const id = entry.models[task];
    const found = id ? byId.get(id) : undefined;
    if (found && found.type === type) return found;
  }
  return undefined;
}

/**
 * 模型列表顶部的「默认路由」一段，只列线上目录里真有的。整条都不在目录里时返回
 * null，列表照旧。
 */
export function formatDefaultRoute(models: readonly Model[], type: DefaultRouteType): string | null {
  const byId = new Map(models.map((model) => [model.model, model]));
  const lines: string[] = [];
  for (const entry of DEFAULT_MODEL_ROUTES[type]) {
    const available = Object.values(entry.models).filter((id) => byId.get(id)?.type === type);
    if (available.length === 0) continue;
    lines.push(`${lines.length + 1}. ${entry.name}: ${available.map((id) => `\`${id}\``).join(", ")}`);
  }
  if (lines.length === 0) return null;
  return [
    `**Default ${type.toLowerCase()} models** (use these in order when the user has not named a model):`,
    ...lines,
  ].join("\n");
}

/** atlas_quick_generate 没给 model_keyword 时按默认路由选模型。 */
export async function resolveDefaultModel(
  type: string,
  inputs: { hasImage: boolean }
): Promise<{ model: Model } | { error: string }> {
  if (type !== "Video" && type !== "Image") {
    return {
      error: `There is no default ${type} model. Pass model_keyword; atlas_list_models with type="${type}" lists the choices.`,
    };
  }
  const task = defaultRouteTask(type, inputs);
  const model = pickDefaultModel(await getModels(), type, task);
  if (!model) {
    return {
      error: `None of the default ${type} models offers ${task} right now. Pass model_keyword; atlas_list_models with type="${type}" lists the choices.`,
    };
  }
  return { model };
}
