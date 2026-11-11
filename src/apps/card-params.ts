// 从一单的参数里取卡片要显示的东西：参数小标签、任务内容（提示词）、输入素材。报价卡、
// 进度卡、结果卡共用；参数可能来自工具调用、服务端补过默认值的实际提交，或查结果接口带回的
// 原始请求（?include_input=1）。

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// 这些比例取值出片形状跟着输入图片走（Seedance 的 adaptive 等）。
const FOLLOWS_IMAGE = new Set(["adaptive", "auto", "original", "keep", "match_input", "match_input_image"]);

/** 参数里写明的出片比例；没写，或写的是「跟随原图」，返回 undefined。 */
export function requestedRatio(params: Record<string, unknown> | undefined): string | undefined {
  const aspect = params?.aspect_ratio ?? params?.ratio;
  if (typeof aspect !== "string") return undefined;
  const value = aspect.trim();
  return value && !FOLLOWS_IMAGE.has(value.toLowerCase()) ? value : undefined;
}

/**
 * 参数里挑几个用户关心的做成小标签（设计稿：1080p · 10 s · 16:9 · Audio）。
 * 只认常见字段名，认不出来就不显示，不去猜。
 *
 * 给了输入图片的比例（视频报价读出来的）而参数没写比例时，标出出片会跟着它：「Ratio from image · 4:3」。
 */
export function settingsChips(
  params: Record<string, unknown> | undefined,
  inputShape?: { ratio: string },
  kind?: string
): string[] {
  if (!params) return [];
  const chips: string[] = [];
  const resolution = params.resolution;
  // 「2k」「4k」统一写成「2K」「4K」，和 1080p、720p 这类写法并列时不显得乱。
  if (typeof resolution === "string" && resolution.trim()) chips.push(resolution.trim().replace(/^(\d+(?:\.\d+)?)k$/i, "$1K"));
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
  // adaptive 是「跟着输入图片的比例」，直接写 adaptive 用户看不懂（11-03：要竖屏却拿到横图比例）。
  const aspect = params.aspect_ratio ?? params.ratio;
  const fromImage = inputShape ? `Ratio from image · ${inputShape.ratio}` : "Ratio from image";
  if (typeof aspect === "string" && aspect.trim()) {
    chips.push(FOLLOWS_IMAGE.has(aspect.trim().toLowerCase()) ? fromImage : aspect.trim());
  } else if (inputShape) {
    // 模型根本没有比例参数（Kling 图生视频等）：出片同样跟着图。
    chips.push(fromImage);
  }

  const count = ["num_images", "max_images", "n", "count"]
    .map((key) => positiveNumber(params[key]))
    .find((n) => n !== undefined);

  // 只认布尔 true：Wan 的 audio 也可能是一条音频链接。
  if ([params.generate_audio, params.audio, params.enable_audio, params.sound].some((v) => v === true)) {
    chips.push("Audio");
  }

  // 设计稿（对话内组件 v3，11-10）：参数行最后一个是数量，「1 image」「1 video」，一张也写。
  // 知道是图还是视频时总是带上，并保证不被截掉；不知道时照旧只在多张时写「N images」。
  const noun = kind === "image" || kind === "video" ? kind : undefined;
  if (noun) {
    const n = count ?? 1;
    return [...chips.slice(0, 4), `${n} ${noun}${n === 1 ? "" : "s"}`];
  }
  if (count !== undefined && count > 1) chips.push(`${count} images`);
  return chips.slice(0, 5);
}

// 工作流（Marketing Studio）的需求描述叫 user_prompt。
const PROMPT_FIELDS = ["prompt", "user_prompt", "text", "text_prompt"] as const;
const PROMPT_MAX = 280;

/** 这一单要生成什么（需求文档 6.1「任务内容」）：提示词，过长截断。没有提示词就不显示。 */
export function promptOf(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  for (const key of PROMPT_FIELDS) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      const text = value.trim().replace(/\s+/g, " ");
      return text.length > PROMPT_MAX ? `${text.slice(0, PROMPT_MAX - 1)}…` : text;
    }
  }
  return undefined;
}

export interface ParamInput {
  url: string;
  /** 链接里的文件名；取不到就是「Input N」。 */
  name: string;
  /** 参数里的顶层字段名（image、product_image、video_url……），地址认不出类型时据此判断。 */
  field?: string;
}

const MAX_INPUTS = 8;

// 生成结果存进历史时的文件名：32 位任务号 + 短哈希，比如 6032bfc4…175b7c-713f8561dbef66aa.jpeg。
const GENERATED_NAME = /^[0-9a-f]{32}-[0-9a-f]{8,}\.(\w+)$/i;
// 上传、转存后只剩随机编号的文件名（UUID、长十六进制）：给用户看没有意义。
const RANDOM_NAME = /^[0-9a-f-]{24,}(?:\.\w+)?$/i;
const VIDEO_EXT = /^(mp4|mov|webm|m4v)$/i;
const AUDIO_EXT = /^(mp3|wav|m4a|aac|ogg|flac)$/i;

function fileName(url: string, index: number): string {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    const name = decodeURIComponent(last);
    // 拿上一单的结果当输入（11-11 Claude C8）：名字写成任务号哈希，用户认不出是什么。
    const generated = GENERATED_NAME.exec(name);
    if (generated) {
      const ext = generated[1]!;
      return VIDEO_EXT.test(ext) ? "Generated video" : AUDIO_EXT.test(ext) ? "Generated audio" : "Generated image";
    }
    if (name && name.length <= 80 && !RANDOM_NAME.test(name)) return name;
  } catch {
    // 不是合法链接就用编号
  }
  return `Input ${index + 1}`;
}

/**
 * 这一单引用的素材（需求文档 6.1「输入素材」、5.2「方案中展示素材缩略图和名称」）：参数里所有
 * http(s) 链接，按出现顺序去重，最多 8 个。不认字段名：各模型叫 image、images、reference_images、
 * reference_videos、last_image……都算。
 */
export function inputsOf(params: Record<string, unknown> | undefined): ParamInput[] {
  if (!params) return [];
  const urls: string[] = [];
  const fields = new Map<string, string>();
  let field = "";
  const visit = (value: unknown, depth: number): void => {
    if (urls.length >= MAX_INPUTS || depth > 3) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) && !urls.includes(value)) {
        urls.push(value);
        fields.set(value, field);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else {
      const nested = record(value);
      if (nested) for (const item of Object.values(nested)) visit(item, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(params)) {
    if ((PROMPT_FIELDS as readonly string[]).includes(key) || key === "model") continue;
    field = key;
    visit(value, 0);
  }
  return urls.map((url, i) => ({ url, name: fileName(url, i), ...(fields.get(url) ? { field: fields.get(url) } : {}) }));
}

/**
 * 地址认不出类型时（资产库临时地址没有扩展名，资产又没带 mime），按参数字段名猜：image / product_image /
 * images 是图，video、audio 同理（11-03 第 9 轮问题 37）。服务端拼报价卡和卡片兜底拼报价卡都用它。
 */
export function kindFromField(field: string | undefined): "image" | "video" | "audio" | undefined {
  if (!field) return undefined;
  const name = field.toLowerCase();
  if (/(^|_)(image|images|img|photo|frame)(_|$)|image_url|first_frame|last_frame/.test(name)) return "image";
  if (/(^|_)(video|videos)(_|$)|video_url/.test(name)) return "video";
  if (/(^|_)(audio|audios|voice|music)(_|$)|audio_url/.test(name)) return "audio";
  return undefined;
}
