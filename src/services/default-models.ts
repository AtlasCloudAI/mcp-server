import type { Model } from "../types.js";
import { getModels } from "./doc-fetcher.js";

/**
 * 用户没点名模型时的默认路由（产品 10-28 定）。
 *
 * 每类按顺序排，取第一个「在线上目录里、且有这个任务变体」的；排在前面的下线了
 * 或者做不了这件事，就顺延到下一个。用户点名的模型永远优先。这张表只管文生 / 图生 /
 * 参考生视频和文生图 / 改图，对口型、视频编辑、超分、3D 这类任务不在范围里，
 * 照常从目录里挑。
 *
 * 需求里「seedreamv5」「nano banana」没写档位：按目录自己的 priority 取排最前的
 * 那一档（Seedream v5.0 Flash、Nano Banana 2），产品要换档只改这里。
 */
export type DefaultRouteTask =
  | "text-to-video"
  | "image-to-video"
  | "reference-to-video"
  | "text-to-image"
  | "edit";

export type DefaultRouteType = "Video" | "Image";

interface DefaultRouteEntry {
  name: string;
  models: Partial<Record<DefaultRouteTask, string>>;
}

function videoFamily(name: string, family: string): DefaultRouteEntry {
  return {
    name,
    models: {
      "text-to-video": `${family}/text-to-video`,
      "image-to-video": `${family}/image-to-video`,
      "reference-to-video": `${family}/reference-to-video`,
    },
  };
}

function imageFamily(name: string, family: string): DefaultRouteEntry {
  return {
    name,
    models: { "text-to-image": `${family}/text-to-image`, edit: `${family}/edit` },
  };
}

export const DEFAULT_MODEL_ROUTES: Record<DefaultRouteType, readonly DefaultRouteEntry[]> = {
  Video: [
    videoFamily("Seedance 2.5", "bytedance/seedance-2.5"),
    videoFamily("Kling 4.0", "kwaivgi/kling-v4.0"),
    videoFamily("Wan 3.0", "alibaba/wan-3.0"),
    videoFamily("Seedance 2.0", "bytedance/seedance-2.0"),
  ],
  Image: [
    imageFamily("Seedream v5.0 Flash", "bytedance/seedream-v5.0-flash"),
    imageFamily("GPT Image 2.5 Sunburst", "openai/gpt-image-2.5-sunburst"),
    imageFamily("Nano Banana 2", "google/nano-banana-2"),
    imageFamily("GPT Image 2", "openai/gpt-image-2"),
  ],
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
    "A model the user names takes precedence, and tasks outside these variants are chosen from the catalog."
  );
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
