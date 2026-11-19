/**
 * 报价卡、进度卡模型行的厂商图标：和官网模型卡（homepage-v2 的 ModelCardV2）用同一套品牌图标。
 * 映射照抄 homepage-v2 `src/utils/brandLogo.ts`（Mike 11-12 给的），图标就是官网 /icons/brands/ 下的文件。
 * 不再用模型目录里每个模型自己的 logo：11-12 查生产目录 602 个带 logo 的模型里 43 个 404（MiniMax 语音、
 * ElevenLabs、Suno、腾讯等），报价卡就没有图标。官网那边改了映射，这里要跟着同步。
 */
export const BRAND_ICON_ORIGIN = "https://www.atlascloud.ai";

const BRAND_LOGO_CONFIG: Record<string, string> = {
  openai: "/icons/brands/openai.svg",
  anthropic: "/icons/brands/anthropic.svg",
  google: "/icons/brands/gemini-color.svg",
  meta: "/icons/brands/meta-color.svg",
  mistral: "/icons/brands/mistral-color.svg",
  deepseek: "/icons/brands/deepseek-color.svg",
  "deepseek-ai": "/icons/brands/deepseek-color.svg",
  qwen: "/icons/brands/qwen-color.svg",
  cohere: "/icons/brands/cohere-color.svg",
  xai: "/icons/brands/grok.png",
  moonshot: "/icons/brands/moonshot.png",
  moonshotai: "/icons/brands/moonshot.png",
  zhipu: "/icons/brands/zhipu-color.svg",
  minimax: "/icons/brands/minimax-color.png",
  minimaxai: "/icons/brands/minimax-color.png",
  bytedance: "/icons/brands/bytedance-color.svg",
  alibaba: "/icons/brands/alibaba-color.svg",
  "alibaba-nlp": "/icons/brands/alibaba-color.svg",
  "z-image": "/icons/brands/alibaba-color.svg",
  "qwen-image": "/icons/brands/qwen-color.svg",
  wan: "/icons/brands/qwen-color.svg",
  "black-forest-labs": "/icons/brands/flux.png",
  "ideogram-ai": "/icons/brands/ideogram.png",
  luma: "/icons/brands/luma-color.svg",
  pika: "/icons/brands/pika.png",
  "recraft-ai": "/icons/brands/recraft.png",
  kwaivgi: "/icons/brands/kling-color.svg",
  kwaipilot: "/icons/brands/kwaikat.png",
  baidu: "/icons/brands/baidu-color.svg",
  ernie: "/icons/brands/wenxin-color.png",
  wenxin: "/icons/brands/wenxin-color.png",
  // 新增品牌（与 navbar 家族下拉的 logo 对齐）
  microsoft: "/icons/brands/microsoft-color.svg",
  "mai-image": "/icons/brands/microsoft-color.svg",
  midjourney: "/icons/brands/midjourney.svg",
  hunyuan: "/icons/brands/hunyuan-color.svg",
  // 腾讯厂商本身（官方为文字 logo，缩到图标尺寸会糊，这里用 T 形单色图标；模型仍走 hunyuan 彩色图标）
  tencent: "/icons/brands/tencent.svg",
  doubao: "/icons/brands/doubao-color.svg",
  happyhorse: "/icons/brands/happyhorse.svg",
  elevenlabs: "/icons/brands/elevenlabs.svg",
  // Z.ai（智谱 GLM，厂商 slug=z-ai）；vidu 归属 ShengShu（厂商 slug=shengshu）
  "z-ai": "/icons/brands/zai-light.png",
  glm: "/icons/brands/zai-light.png",
  shengshu: "/icons/brands/vidu-color.svg",
  vidu: "/icons/brands/vidu-color.svg",
  seed3d: "/icons/brands/bytedance-color.svg",
  photon: "/icons/brands/luma-color.svg",
  hidream: "/icons/brands/hidream-color.png",

  // ↓ 以下补齐线上实际存在、但此前匹配不到 logo 的模型前缀。
  // 图标本来就有、只是漏配 key 的三处：
  // - pixverse：表里从来没加过，9 个 pixverse/* 模型一直没 logo
  // - ideogram：原 key 是 "ideogram-ai"，线上模型名却是 ideogram/v4/*，前缀对不上
  // - ltx / lightricks：原 key 只在 navbar 那张表里，且反色列表写的是 "ltx" 而文件名是 lightricks
  pixverse: "/icons/brands/pixverse-color.svg",
  ideogram: "/icons/brands/ideogram.png",
  ltx: "/icons/brands/lightricks.png",
  lightricks: "/icons/brands/lightricks.png",

  // 与 navbar 家族下拉新增的那批对齐
  suno: "/icons/brands/suno.svg",
  krea: "/icons/brands/krea.svg",
  reve: "/icons/brands/reve.svg",
  tripo: "/icons/brands/tripo-color.svg",
  nvidia: "/icons/brands/nvidia-color.svg",
  veed: "/icons/brands/veed-color.svg",
  // Youchuan 是 Midjourney 的中国版本（后端 organization 也标的 MIDJOURNEY）
  youchuan: "/icons/brands/midjourney.svg",

  // Atlas 自家模型（upscaler / photo-cleanup / infinitetalk / studio 模板等）
  atlascloud: "/icons/brands/atlascloud-color.svg",
  // Van 是基于 Wan 2.5/2.6 封装的视频系列，跟 navbar 一样归到 Wan 品牌
  van: "/icons/brands/qwen-color.svg",
  // BytePlus 是字节跳动的海外品牌，沿用 ByteDance 图标
  byteplus: "/icons/brands/bytedance-color.svg",
  xiaomi: "/icons/brands/xiaomi-color.svg",
  // dots-studio：lobehub 没有收录，图取自后端自己给的品牌图
  // static.atlascloud.ai/model/avatar/dots.png（已压缩），薄荷绿底不需要反色
  "dots-studio": "/icons/brands/dots-color.png",
  longcat: "/icons/brands/longcat-color.svg",
  meituan: "/icons/brands/longcat-color.svg",
  // Sync.so：不能用 "sync" 做 key —— veed/lipsync 的模型名里也含 "sync"，
  // 会被抢走，所以锚到它自己的完整模型名
  "lipsync-v3": "/icons/brands/sync.svg"
};

// 长的先匹配：lipsync-v3 要先于 sync 类、deepseek-ai 先于 deepseek。
const SORTED_BRANDS = Object.entries(BRAND_LOGO_CONFIG).sort((a, b) => b[0].length - a[0].length);

/**
 * 按模型全名（vendor/name）取官网品牌图标的完整地址，匹配规则和官网一致：先看斜杠后面的模型名，
 * 再看整条路径。匹配不到返回 undefined。
 */
export function brandIconUrl(modelId: string): string | undefined {
  const name = (modelId || "").toLowerCase();
  const part = name.includes("/") ? name.split("/").slice(1).join("/") : name;
  for (const target of [part, name]) {
    for (const [brand, path] of SORTED_BRANDS) {
      if (target.includes(brand)) return `${BRAND_ICON_ORIGIN}${path}`;
    }
  }
  return undefined;
}
