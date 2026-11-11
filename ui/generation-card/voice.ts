// 卡片替用户说的话：发到对话里（或填进输入框）的那一句。
//
// 验收问题 21（ChatGPT，11-03）：中文对话里卡片发出一句英文。宿主界面是中文（hostContext.locale，没有就看
// 浏览器语言）时说中文，其余照旧说英文。写给模型看的那段（文件地址、编号）还是英文，那是给模型的说明。
//
// 验收问题 3（Claude，11-03）：Claude 不替卡片发消息，只把它填进输入框，要用户自己点发送。卡片在 Claude 里
// 发完提示一句，不然用户以为点了没反应。

import type { App } from "@modelcontextprotocol/ext-apps";

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
}

export const say = {
  pickedFromLibrary(lang: Lang, count: number, labels: string): HandOffText {
    return lang === "zh"
      ? { short: `我在 Atlas 卡片里从资产库选了 ${files(lang, count)}（${labels}），请用${it(lang, count)}。`, ask: `请用${it(lang, count)}。` }
      : {
          short: `I've picked ${files(lang, count)} from my Asset Library in the Atlas card (${labels}). Please use ${it(lang, count)}.`,
          ask: `Please use ${it(lang, count)}.`,
        };
  },
  addedInCard(lang: Lang, count: number, names: string): HandOffText {
    return lang === "zh"
      ? { short: `我在 Atlas 卡片里添加了 ${files(lang, count)}（${names}），请用${it(lang, count)}。`, ask: `请用${it(lang, count)}。` }
      : { short: `I've added ${files(lang, count)} in the Atlas card (${names}). Please use ${it(lang, count)}.`, ask: `Please use ${it(lang, count)}.` };
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
  reusePrompt(lang: Lang, model: string, prompt: string): string {
    return lang === "zh"
      ? `用同样的提示词再生成一次（上次用的是 ${model}），先给我报价：\n\n${prompt}`
      : `Generate this again with the same prompt (last time it was ${model}), and quote it first:\n\n${prompt}`;
  },
  failedSwitchModel(lang: Lang): string {
    return lang === "zh"
      ? "刚才的生成失败了。请换一个模型做同样的需求。"
      : "That generation failed. Please suggest a different model for the same request.";
  },
};

/** 替用户发一句话。宿主拒绝时提示自己去聊天里说；在 Claude 里发完提示点发送。 */
export function sendForUser(app: App, text: string, notice: (text: string) => void): void {
  app
    .sendMessage({ role: "user", content: [{ type: "text", text }] })
    .then((res) => {
      if (res.isError) notice(hostPrefills(app) ? PREFILL_ASK_NOTE : SEND_FAILED_NOTE);
      else if (hostPrefills(app)) notice(PREFILLED_NOTE);
    })
    .catch(() => notice(SEND_FAILED_NOTE));
}
