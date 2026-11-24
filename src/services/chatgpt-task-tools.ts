import { isChatGptClient } from "./client-profile.js";
import { DEFAULT_MODEL_ROUTES, type DefaultRouteTask, type DefaultRouteType } from "./default-models.js";

/**
 * ChatGPT 的「一个任务一个工具」（开关 MCP_CHATGPT_TASK_TOOLS，默认关）。
 *
 * OpenAI 的自动检查一直拦 atlas_generate_image / video / quick_generate（"This tool appears to execute
 * operations that are not individually exposed"）：11-20 两次、11-23 精简版一次、11-23 19:41 完整版一次，
 * 描述怎么改都拦。同一批扫描里 atlas_generate_audio、atlas_transcribe_audio、atlas_chat 也是
 * 「model 字符串 + 自由参数」，却过了（音频 11-23 14:59 被拦一次、19:41 又过了）。区别在一个工具背后
 * 有几种操作：转写、聊天只有一种；音频是配音 + 音乐两种，时过时不过；图片工具写着文生图、改图、3D，
 * 视频工具是文生、图生、参考生、对口型、视频编辑……几十种任务，快速生成更是全包。
 *
 * 所以给 ChatGPT 另加 5 个工具，每个只做一种任务，模型从固定的几个里选（枚举），参数是固定的字段，
 * 服务端换算成各模型自己的字段名，再走和 atlas_generate_* 同一套报价 → 确认 → 提交。
 *
 * 只加不减：原来的生成工具照旧注册。ChatGPT 副本里它们停在已发布的旧版本，新工具被拦也不影响现在能用的；
 * 新工具过了再决定要不要对 ChatGPT 撤掉旧的。其他客户端、本地 npm 版一个字不变。
 */
export function chatGptTaskToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // 和 MCP_UI_CARDS 等开关同一个写法：没设或空着算关，0 / false / no / off 算关，其余算开。
  const raw = env.MCP_CHATGPT_TASK_TOOLS?.trim().toLowerCase();
  if (!raw) return false;
  return !["0", "false", "no", "off"].includes(raw);
}

/** 这个客户端拿任务工具吗：开关打开，且是 ChatGPT（OpenAI 平台的插件扫描也算）。 */
export function usesTaskTools(clientId: string | undefined): boolean {
  return chatGptTaskToolsEnabled() && isChatGptClient(clientId);
}

export type TaskToolName =
  | "atlas_text_to_image"
  | "atlas_edit_image"
  | "atlas_text_to_video"
  | "atlas_image_to_video"
  | "atlas_reference_to_video";

export const TASK_TOOL_NAMES: readonly TaskToolName[] = [
  "atlas_text_to_image",
  "atlas_edit_image",
  "atlas_text_to_video",
  "atlas_image_to_video",
  "atlas_reference_to_video",
];

/** 工具 → 默认路由里的任务变体和类型。 */
export const TASK_OF_TOOL: Record<TaskToolName, { type: DefaultRouteType; task: DefaultRouteTask }> = {
  atlas_text_to_image: { type: "Image", task: "text-to-image" },
  atlas_edit_image: { type: "Image", task: "edit" },
  atlas_text_to_video: { type: "Video", task: "text-to-video" },
  atlas_image_to_video: { type: "Video", task: "image-to-video" },
  atlas_reference_to_video: { type: "Video", task: "reference-to-video" },
};

/**
 * 工具里 model 参数能选的值（枚举），顺序同默认路由：第一个是默认。值是短名，不是模型 ID：
 * 审核看到的是「这个工具能用这几个模型」，不是「填任意模型 ID」。
 */
export const IMAGE_MODEL_CHOICES = ["seedream-5.0-pro", "gpt-image-2.5", "nano-banana-2.1", "gpt-image-2"] as const;
export const VIDEO_MODEL_CHOICES = ["seedance-2.5", "kling-4.0", "wan-3.0", "seedance-2.0"] as const;
export type ImageModelChoice = (typeof IMAGE_MODEL_CHOICES)[number];
export type VideoModelChoice = (typeof VIDEO_MODEL_CHOICES)[number];
export type ModelChoice = ImageModelChoice | VideoModelChoice;

/** 短名 → 默认路由里的模型家族（DEFAULT_MODEL_ROUTES 的名字）。测试核对两边一一对应。 */
export const CHOICE_ROUTE_NAME: Record<ModelChoice, string> = {
  "seedream-5.0-pro": "Seedream 5.0 Pro",
  "gpt-image-2.5": "GPT Image 2.5 Sunburst",
  "nano-banana-2.1": "Nano Banana 2.1",
  "gpt-image-2": "GPT Image 2",
  "seedance-2.5": "Seedance 2.5",
  "kling-4.0": "Kling 4.0",
  "wan-3.0": "Wan 3.0",
  "seedance-2.0": "Seedance 2.0",
};

/** 这个短名在这个任务上的模型 ID（来自默认路由表，不另写一份）。 */
export function modelIdFor(choice: ModelChoice, tool: TaskToolName): string | undefined {
  const { type, task } = TASK_OF_TOOL[tool];
  const entry = DEFAULT_MODEL_ROUTES[type].find((route) => route.name === CHOICE_ROUTE_NAME[choice]);
  return entry?.models[task];
}

export const IMAGE_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"] as const;
export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

// 比例 → 各家的 size 档位（取自 11-24 上游 schema 的枚举；测试里有快照核对）。
const SEEDREAM_SIZE: Record<ImageAspectRatio, string> = {
  "1:1": "2048*2048",
  "4:3": "2368*1776",
  "3:4": "1776*2368",
  "16:9": "2816*1584",
  "9:16": "1584*2816",
  "3:2": "2496*1664",
  "2:3": "1664*2496",
  "21:9": "3136*1344",
};
const GPT_IMAGE_SIZE: Record<ImageAspectRatio, string> = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "16:9": "2048x1152",
  "9:16": "1152x2048",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "21:9": "2560x1088",
};

export interface ImageTaskArgs {
  prompt: string;
  images?: string[];
  aspect_ratio?: ImageAspectRatio;
}

/** 图片任务的固定字段 → 这个模型的上游参数。 */
export function imageParams(choice: ImageModelChoice, args: ImageTaskArgs): Record<string, unknown> {
  const params: Record<string, unknown> = { prompt: args.prompt };
  if (args.images) {
    // Nano Banana 的输入图字段叫 reference_images，其余三个叫 images。
    params[choice === "nano-banana-2.1" ? "reference_images" : "images"] = args.images;
  }
  if (args.aspect_ratio) {
    if (choice === "seedream-5.0-pro") params.size = SEEDREAM_SIZE[args.aspect_ratio];
    else if (choice === "nano-banana-2.1") params.aspect_ratio = args.aspect_ratio;
    else params.size = GPT_IMAGE_SIZE[args.aspect_ratio];
  }
  return params;
}

export interface VideoTaskArgs {
  prompt?: string;
  image?: string;
  last_image?: string;
  reference_images?: string[];
  reference_videos?: string[];
  reference_audios?: string[];
  duration?: number;
  resolution?: (typeof VIDEO_RESOLUTIONS)[number];
  aspect_ratio?: (typeof VIDEO_ASPECT_RATIOS)[number];
  with_audio?: boolean;
}

export type VideoParamsResult = { ok: true; params: Record<string, unknown> } | { ok: false; message: string };

/** 视频任务的固定字段 → 这个模型的上游参数。这个模型做不到的组合直接说明，不去报价。 */
export function videoParams(choice: VideoModelChoice, args: VideoTaskArgs): VideoParamsResult {
  const params: Record<string, unknown> = {};
  if (args.prompt !== undefined) params.prompt = args.prompt;
  if (args.image !== undefined) params.image = args.image;
  if (args.last_image !== undefined) params.last_image = args.last_image;
  if (args.duration !== undefined) params.duration = args.duration;
  if (args.resolution !== undefined) params.resolution = args.resolution;
  // 比例字段：Seedance、Wan 叫 ratio，Kling 叫 aspect_ratio（和默认路由表同一个约定）。
  if (args.aspect_ratio !== undefined) params[choice === "kling-4.0" ? "aspect_ratio" : "ratio"] = args.aspect_ratio;
  if (args.with_audio !== undefined) {
    if (choice === "kling-4.0") {
      return { ok: false, message: "Kling 4.0 has no setting for generated audio. Leave with_audio out, or choose seedance-2.5, wan-3.0 or seedance-2.0." };
    }
    params[choice === "wan-3.0" ? "audio" : "generate_audio"] = args.with_audio;
  }
  const images = args.reference_images ?? [];
  const videos = args.reference_videos ?? [];
  const audios = args.reference_audios ?? [];
  if (images.length + videos.length + audios.length > 0) {
    if (choice === "wan-3.0") {
      // Wan 3.0 的参考素材是一个列表，每项写明类型。
      params.refers = [
        ...images.map((url) => ({ url, type: "image" })),
        ...videos.map((url) => ({ url, type: "video" })),
        ...audios.map((url) => ({ url, type: "audio" })),
      ];
    } else {
      if (audios.length > 0 && choice === "kling-4.0") {
        return { ok: false, message: "Kling 4.0 does not take reference audio. Remove reference_audios, or choose seedance-2.5, wan-3.0 or seedance-2.0." };
      }
      if (images.length > 0) params.reference_images = images;
      if (videos.length > 0) params.reference_videos = videos;
      if (audios.length > 0) params.reference_audios = audios;
    }
  }
  return { ok: true, params };
}
