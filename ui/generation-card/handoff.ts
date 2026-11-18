// 把卡片里准备好的文件交给模型（上传卡的「Use files」和资产库卡的「Use selected」共用）：
// 先放进模型上下文，再替用户发一句话。上下文进得去、而且模型确实看得到时，消息里只写短的那句，
// 免得对话里一长串链接；否则把全文写进消息。

import type { App } from "@modelcontextprotocol/ext-apps";

/**
 * sent：消息发出去了；context：只进了上下文；failed：两样都没成；unsupported：宿主两样都不支持；
 * unconfirmed：宿主没声明能发消息，请求超时或回了错，但多半已经发出去了（Cursor，见 sendFailure）。
 */
export type HandOffResult = "sent" | "context" | "failed" | "unsupported" | "unconfirmed";

/** JSON-RPC「没有这个方法」：宿主明说不支持。 */
const METHOD_NOT_FOUND = -32601;

/**
 * 发消息没拿到成功回答时，算哪一种。宿主声明过能发：真失败，可以重试。没声明（Cursor）：
 * 11-18 Cursor 回归，资产库卡、上传卡点 Use 以后消息已经出现在对话里、模型也接着用了，卡上却因为
 * 请求没有成功回答，显示「This app can't take files straight from the card…」、按钮也没变成 Added to chat。
 * 所以没声明的宿主只有明说「没有这个方法」才算不支持；超时、回错都算「多半发出去了」，卡上照已发出处理，
 * 再留一句没看到就怎么说。
 */
export function sendFailure(declared: boolean, error: unknown): "failed" | "unsupported" | "unconfirmed" {
  if (declared) return "failed";
  const code = (error as { code?: unknown } | undefined)?.code;
  const message = error instanceof Error ? error.message : "";
  return code === METHOD_NOT_FOUND || /method not found/i.test(message) ? "unsupported" : "unconfirmed";
}

/**
 * 写进上下文的内容模型看得到的宿主。ChatGPT 10-28 实测看得到。Claude 网页版 11-03 实测：写入不报错，
 * 但模型拿不到——从上传卡里选的资产只剩消息里的名字，它又搜了一遍资产库才找到。所以除了 ChatGPT，
 * 都把文件编号和地址写进消息本身。
 */
export function contextReachesModel(app: App): boolean {
  const name = app.getHostVersion()?.name?.toLowerCase() ?? "";
  return name.includes("chatgpt") || name.includes("openai");
}

/**
 * 宿主没在握手里声明、却未必不支持：2026-11-11 Cursor 不声明 message / updateModelContext，
 * 但 Higgsfield 的上传卡在 Cursor 里照样发出了消息。所以不按声明拦，直接试；没声明的那一边
 * 加个超时，免得宿主既不回结果也不报错时按钮一直转。
 */
const UNDECLARED_TIMEOUT_MS = 8_000;

/** 没声明、试过也失败了：这个宿主确实不能替用户发消息，之后不再摆要发消息的按钮。 */
let messageRefused = false;

export function messagingAvailable(): boolean {
  return !messageRefused;
}

/** 发消息失败时调用：宿主没声明能发消息的，记下来。 */
export function noteMessageFailed(app: App): void {
  if (app.getHostCapabilities?.()?.message === undefined) messageRefused = true;
}

export function withTimeout<T>(promise: Promise<T>, declared: boolean): Promise<T> {
  if (declared) return promise;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("host did not answer")), UNDECLARED_TIMEOUT_MS)),
  ]);
}

/** refs：一行一个文件的编号清单（「- 名字 (image, 1080×1920): asset://…」），配 text.lead 用。 */
export async function handOff(
  app: App,
  forModel: string,
  text: { short: string; ask: string; lead?: string },
  refs?: string
): Promise<HandOffResult> {
  const caps = app.getHostCapabilities() ?? {};
  const contextDeclared = caps.updateModelContext !== undefined;
  const messageDeclared = caps.message !== undefined;
  let inContext = false;
  try {
    const res = await withTimeout(app.updateModelContext({ content: [{ type: "text", text: forModel }] }), contextDeclared);
    inContext = !(res as { isError?: boolean } | undefined)?.isError;
  } catch {
    inContext = false;
  }
  const message =
    inContext && contextReachesModel(app)
      ? text.short
      : text.lead && refs
        ? `${text.lead}\n${refs}`
        : `${forModel}\n\n${text.ask}`;
  try {
    const res = await withTimeout(app.sendMessage({ role: "user", content: [{ type: "text", text: message }] }), messageDeclared);
    if (res.isError) throw new Error("rejected");
    return "sent";
  } catch (error) {
    const failure = sendFailure(messageDeclared, error);
    // 多半已经发出去了：不当成不能发消息，别的按钮照旧摆。
    if (failure === "unconfirmed") return "unconfirmed";
    if (!messageDeclared) messageRefused = true;
    if (inContext) return "context";
    // 声明过却失败是真失败（可以重试）；没声明、宿主又明说没有这个方法，就当宿主不支持。
    return messageDeclared || contextDeclared ? "failed" : "unsupported";
  }
}
