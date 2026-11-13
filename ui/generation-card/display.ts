// 卡片的显示模式判断，纯函数，测试直接引。

interface DisplayContext {
  displayMode?: string;
  availableDisplayModes?: string[];
}

/**
 * 卡片能不能展开成全屏（显示 View all 而不是翻页条）。宿主声明了 fullscreen 但真去请求时回的不是 fullscreen，
 * 就当它不给全屏（11-13 WorkBuddy 5.5.6：声明了 fullscreen，ui/request-display-mode 却回 {mode: "inline"}，
 * 资产库 View all 点了没反应、又没有翻页条，只能看到最新 7 张）。
 */
export function canExpandIn(context: DisplayContext | undefined, fullscreenRefused: boolean): boolean {
  return (
    !fullscreenRefused &&
    (context?.availableDisplayModes ?? []).includes("fullscreen") &&
    context?.displayMode !== "fullscreen"
  );
}

/**
 * 请求全屏后宿主的回答算不算拒绝：明确回了别的 mode，或请求本身报错。没回 mode 的不算（宿主可能只靠
 * host context 通知），免得把真能全屏的宿主（Claude、ChatGPT）误判成不能。
 */
export function fullscreenWasRefused(response: { mode?: unknown } | undefined | "error"): boolean {
  if (response === "error") return true;
  return typeof response?.mode === "string" && response.mode !== "fullscreen";
}

/**
 * 同一个工具结果宿主发了两次（11-13 WorkBuddy 桌面版给资产库卡发了两次相同的 tool-result）：认出来就不重建卡片，
 * 免得新实例顶掉用户已经点过的选择。按结构化结果和 _meta 的内容比较。
 */
export function toolResultKey(result: { structuredContent?: unknown; _meta?: unknown; isError?: boolean }): string {
  try {
    return JSON.stringify([result.isError === true, result.structuredContent ?? null, result._meta ?? null]);
  } catch {
    return `unserializable:${Date.now()}:${Math.random()}`;
  }
}
