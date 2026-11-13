// 卡片替用户说的话：发到对话里（或填进输入框）的那一句。
//
// 验收问题 21（ChatGPT，11-03）：中文对话里卡片发出一句英文。宿主界面是中文（hostContext.locale，没有就看
// 浏览器语言）时说中文，其余照旧说英文。写给模型看的那段（文件地址、编号）还是英文，那是给模型的说明。
//
// 验收问题 3（Claude，11-03）：Claude 不替卡片发消息，只把它填进输入框，要用户自己点发送。卡片在 Claude 里
// 发完提示一句，不然用户以为点了没反应。

import type { App } from "@modelcontextprotocol/ext-apps";
import { noteMessageFailed, withTimeout } from "./handoff.js";

export type Lang = "zh" | "en";

export function userLang(app: App): Lang {
  const locale = app.getHostContext()?.locale || (typeof navigator !== "undefined" ? navigator.language : "");
  return /^zh/i.test(locale ?? "") ? "zh" : "en";
}

/** 宿主只把卡片的消息填进输入框、等用户点发送（Claude 网页版 11-03 实测）。 */
export function hostPrefills(app: App): boolean {
  return (app.getHostVersion()?.name?.toLowerCase() ?? "").includes("claude");
}

// 卡片看不到输入框后来被清空（11-11 Claude C3：清空了卡上还写着「It's in your message box」），
// 所以说成已经发生的事，用户删了也不算说错。
export const PREFILLED_NOTE = "Added to your message box. Send it when you're ready.";
/** 输入框里已经有字时，Claude 先问要不要替换，卡片这边拿到的是「没放进去」（11-03 实测）。 */
export const PREFILL_ASK_NOTE = "Your message box already has text. If Claude asks to replace it, accept, then press send.";
export const SEND_FAILED_NOTE = "Couldn't send that. Type it in the chat instead.";
/** 这两句要用户去输入框里动手，停久一点（别的提示 4 秒），但别一直挂着。 */
export const PREFILL_NOTE_MS = 8_000;
export function isPrefillNote(text: string | undefined): boolean {
  return text === PREFILLED_NOTE || text === PREFILL_ASK_NOTE;
}

/**
 * 卡片把文件交给模型之后，在 Claude 里该提示什么：放进输入框了就请用户点发送；没放进去（输入框里有字，
 * Claude 在问要不要替换）就请用户接受替换。写进上下文在 Claude 里不算数（模型看不到），不能说「已经好了」。
 * 不是 Claude 返回 undefined，照各自原来的提示。
 */
export function prefillNote(app: App, outcome: "sent" | "context" | "failed" | "unsupported"): string | undefined {
  if (!hostPrefills(app)) return undefined;
  if (outcome === "sent") return PREFILLED_NOTE;
  if (outcome === "context") return PREFILL_ASK_NOTE;
  return undefined;
}

const it = (lang: Lang, count: number) => (lang === "zh" ? (count === 1 ? "它" : "它们") : count === 1 ? "it" : "them");
const files = (lang: Lang, count: number) => (lang === "zh" ? `${count} 个文件` : count === 1 ? "1 file" : `${count} files`);

/** 交给模型时的两种说法：short 只写名字（地址已进了模型上下文），ask 接在写给模型的说明后面。 */
export interface HandOffText {
  short: string;
  ask: string;
  /**
   * 模型看不到上下文的宿主（Claude）里，消息写成「lead + 文件编号清单」，不再把写给模型的整段英文说明
   * 塞进输入框（11-13 Jia D05/U02：一大段英文 asset:// 说明，Claude 还弹红色「运行此提示词前请谨慎」）。
   * asset:// 的用法生成工具的描述里已经写了。
   */
  lead?: string;
}

export const say = {
  pickedFromLibrary(lang: Lang, count: number, labels: string): HandOffText {
    return lang === "zh"
      ? {
          short: `我在 Atlas 卡片里从资产库选了 ${files(lang, count)}（${labels}），请用${it(lang, count)}。`,
          ask: `请用${it(lang, count)}。`,
          lead: `请用我在 Atlas 资产库里选的${count === 1 ? "这个文件" : `这 ${count} 个文件`}：`,
        }
      : {
          short: `I've picked ${files(lang, count)} from my Asset Library in the Atlas card (${labels}). Please use ${it(lang, count)}.`,
          ask: `Please use ${it(lang, count)}.`,
          lead: `Please use ${count === 1 ? "this file" : `these ${count} files`} from my Atlas Asset Library:`,
        };
  },
  addedInCard(lang: Lang, count: number, names: string): HandOffText {
    return lang === "zh"
      ? {
          short: `我在 Atlas 卡片里添加了 ${files(lang, count)}（${names}），请用${it(lang, count)}。`,
          ask: `请用${it(lang, count)}。`,
          lead: `我在 Atlas 卡片里传好了${count === 1 ? "这个文件" : `这 ${count} 个文件`}，请用${it(lang, count)}（已经传好，不用再传）：`,
        }
      : {
          short: `I've added ${files(lang, count)} in the Atlas card (${names}). Please use ${it(lang, count)}.`,
          ask: `Please use ${it(lang, count)}.`,
          lead: `I've uploaded ${count === 1 ? "this file" : `these ${count} files`} in the Atlas card. Please use ${it(lang, count)} (already uploaded):`,
        };
  },
  replacedDeleted(lang: Lang, count: number, labels: string, gone: string[]): HandOffText {
    if (lang === "zh") {
      const was = gone.length > 0 ? gone.join("、") : "被删的文件";
      return { short: `我选了 ${labels} 替换 ${was}，请用${it(lang, count)}重新报价。`, ask: "请用新文件重新报价。" };
    }
    const was = gone.length > 0 ? gone.join(", ") : "the deleted file";
    return { short: `I picked ${labels} to replace ${was}. Please quote again with ${it(lang, count)}.`, ask: "Please quote again with the new file." };
  },
  changeRequest(lang: Lang): string {
    return lang === "zh" ? "生成之前，我想改一下需求。" : "Before generating, I'd like to change the request.";
  },
  switchModel(lang: Lang, model: string): string {
    return lang === "zh"
      ? `${model} 现在用不了，请换一个模型做同样的需求。`
      : `${model} is unavailable right now. Please suggest a different model for the same request.`;
  },
  missingFromLibrary(lang: Lang, missing: string[]): string {
    return lang === "zh"
      ? `${missing.length > 0 ? missing.join("、") : "有一个文件"}已经不在我的资产库里了。请打开我的资产库，我重新选一个文件。`
      : `${missing.length > 0 ? missing.join(", ") : "One of my files"} is no longer in my Asset Library. Show me my Asset Library so I can choose another file.`;
  },
  failedRequote(lang: Lang): string {
    return lang === "zh"
      ? "刚才的生成失败了。请重新给我报个价，我可能想先改点东西。"
      : "That generation failed. Please give me a new quote for it; I may want to change something first.";
  },
  /**
   * 「Reuse prompt」：提示词连同原来的输入素材一起交回去。编辑、图生视频这类任务只给提示词时，模型会自己
   * 去资产库挑一张当输入（11-12 ChatGPT 回归）。素材写成 asset://编号或公开链接，模型直接填进参数；
   * 链接已经用不了的，请模型先让用户重新选。
   */
  reusePrompt(
    lang: Lang,
    model: string,
    prompt: string,
    inputs: { name: string; ref: string; field?: string }[] = [],
    unavailable = 0,
    settings: Record<string, string | number | boolean> = {},
    modelId?: string
  ): string {
    const list = inputs.map((input) => `- ${input.name}${input.field ? ` (${input.field})` : ""}: ${input.ref}`).join("\n");
    // 原来的参数照抄（11-13 Jia H05），模型 ID 也写上，免得换成同名的别的版本。
    const params = Object.entries(settings).map(([key, value]) => `${key}: ${value}`).join(", ");
    const modelLine = modelId && modelId !== model ? `${model}（${modelId}）` : model;
    if (lang === "zh") {
      const head =
        inputs.length > 0 || unavailable > 0
          ? `用同样的模型、提示词、参数和输入素材再生成一次（上次用的是 ${modelLine}），先给我报价：`
          : `用同样的模型、提示词和参数再生成一次（上次用的是 ${modelLine}），先给我报价：`;
      const files = inputs.length > 0 ? `\n\n输入素材（照原来的字段填）：\n${list}` : "";
      const same = params ? `\n\n参数（照原来的填）：${params}` : "";
      const missing = unavailable > 0 ? `\n\n还有 ${unavailable} 个输入文件的链接已经失效，请先让我重新选一下。` : "";
      return `${head}\n\n${prompt}${same}${files}${missing}`;
    }
    const head =
      inputs.length > 0 || unavailable > 0
        ? `Generate this again with the same model, prompt, settings and input files (last time it was ${modelId && modelId !== model ? `${model} (${modelId})` : model}), and quote it first:`
        : `Generate this again with the same model, prompt and settings (last time it was ${modelId && modelId !== model ? `${model} (${modelId})` : model}), and quote it first:`;
    const sameEn = params ? `\n\nSettings (use the same values): ${params}` : "";
    const files = inputs.length > 0 ? `\n\nInput files (use them in the same fields):\n${list}` : "";
    const missing =
      unavailable > 0
        ? `\n\n${unavailable === 1 ? "One input file's link has" : `${unavailable} input files' links have`} expired: ask me to pick ${unavailable === 1 ? "it" : "them"} again first.`
        : "";
    return `${head}\n\n${prompt}${sameEn}${files}${missing}`;
  },
  failedSwitchModel(lang: Lang): string {
    return lang === "zh"
      ? "刚才的生成失败了。请换一个模型做同样的需求。"
      : "That generation failed. Please suggest a different model for the same request.";
  },
};

/** 替用户发一句话。宿主拒绝时提示自己去聊天里说；在 Claude 里发完提示点发送。 */
export function sendForUser(app: App, text: string, notice: (text: string) => void): void {
  // 宿主没声明也照样试（Cursor 不声明但能发，2026-11-11）；没声明的加超时。
  withTimeout(app.sendMessage({ role: "user", content: [{ type: "text", text }] }), app.getHostCapabilities?.()?.message !== undefined)
    .then((res) => {
      if (res.isError) {
        noteMessageFailed(app);
        notice(hostPrefills(app) ? PREFILL_ASK_NOTE : SEND_FAILED_NOTE);
      } else if (hostPrefills(app)) notice(PREFILLED_NOTE);
    })
    .catch(() => {
      noteMessageFailed(app);
      notice(SEND_FAILED_NOTE);
    });
}

