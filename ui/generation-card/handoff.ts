// 把卡片里准备好的文件交给模型（上传卡的「Use files」和资产库卡的「Use selected」共用）：
// 先放进模型上下文，再替用户发一句话。上下文进得去时消息里只写短的那句，免得对话里一长串链接；
// 进不去就把全文写进消息。

import type { App } from "@modelcontextprotocol/ext-apps";

/** sent：消息发出去了；context：只进了上下文；failed：两样都没成；unsupported：宿主两样都不支持。 */
export type HandOffResult = "sent" | "context" | "failed" | "unsupported";

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
    const message = inContext ? text.short : `${forModel}\n\n${text.ask}`;
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
