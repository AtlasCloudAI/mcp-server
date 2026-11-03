// 把卡片里准备好的文件交给模型（上传卡的「Use files」和资产库卡的「Use selected」共用）：
// 先放进模型上下文，再替用户发一句话。上下文进得去、而且模型确实看得到时，消息里只写短的那句，
// 免得对话里一长串链接；否则把全文写进消息。

import type { App } from "@modelcontextprotocol/ext-apps";

/** sent：消息发出去了；context：只进了上下文；failed：两样都没成；unsupported：宿主两样都不支持。 */
export type HandOffResult = "sent" | "context" | "failed" | "unsupported";

/**
 * 写进上下文的内容模型看得到的宿主。ChatGPT 10-28 实测看得到。Claude 网页版 11-03 实测：写入不报错，
 * 但模型拿不到——从上传卡里选的资产只剩消息里的名字，它又搜了一遍资产库才找到。所以除了 ChatGPT，
 * 都把文件编号和地址写进消息本身。
 */
export function contextReachesModel(app: App): boolean {
  const name = app.getHostVersion()?.name?.toLowerCase() ?? "";
  return name.includes("chatgpt") || name.includes("openai");
}

export async function handOff(app: App, forModel: string, text: { short: string; ask: string }): Promise<HandOffResult> {
  const caps = app.getHostCapabilities() ?? {};
  let inContext = false;
  if (caps.updateModelContext !== undefined) {
    try {
      const res = await app.updateModelContext({ content: [{ type: "text", text: forModel }] });
      inContext = !(res as { isError?: boolean } | undefined)?.isError;
    } catch {
      inContext = false;
    }
  }
  if (caps.message !== undefined) {
    const message = inContext && contextReachesModel(app) ? text.short : `${forModel}\n\n${text.ask}`;
    try {
      const res = await app.sendMessage({ role: "user", content: [{ type: "text", text: message }] });
      if (res.isError) throw new Error("rejected");
      return "sent";
    } catch {
      if (!inContext) return "failed";
    }
  }
  return inContext ? "context" : "unsupported";
}
