// 2026-11-12 WorkBuddy（CodeBuddy 2.137.1 网页界面）实测：宿主把卡片发出的每条消息 65 ms 内原样弹回卡片。
// 卡片对弹回的 tools/call 回「-32601 Method not found」，这条回复又被弹回来，正好对上卡片自己那次调用的 id，
// 于是 callServerTool 当场失败（资产库「Use selected」回到原样，问题 41）。宿主处理得快的请求（发消息、
// 初始化）真结果先到，所以只有要等权限确认的工具调用坏掉。
// 这里在 SDK 的 PostMessageTransport 外包一层：收到和自己刚发出的一模一样的消息就丢掉，既不回 -32601，
// 也不让它冒充结果。宿主不会发出和卡片完全相同的消息（同一个 id 和 method），所以不会误丢。

import { PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const ECHO_WINDOW_MS = 10_000;

/** 键按字母排序的序列化：入站消息经过 SDK 的结构校验，键的顺序可能和发出时不同。 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class EchoFilteringTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  /** 丢掉的回声条数，测试卡的诊断里看得到。 */
  dropped = 0;
  private readonly sent = new Map<string, number>();

  constructor(private readonly inner: Transport) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message) => {
      if (this.isEcho(message)) {
        this.dropped += 1;
        return;
      }
      this.onmessage?.(message);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const now = Date.now();
    for (const [key, at] of this.sent) if (now - at > ECHO_WINDOW_MS) this.sent.delete(key);
    this.sent.set(canonical(message), now);
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  private isEcho(message: JSONRPCMessage): boolean {
    const key = canonical(message);
    const at = this.sent.get(key);
    if (at === undefined || Date.now() - at > ECHO_WINDOW_MS) return false;
    // 一条只认一次回声：万一宿主确实发来一模一样的第二条，照常处理。
    this.sent.delete(key);
    return true;
  }
}

/** 卡片和宿主之间的传输：SDK 默认的 window.parent 通道，外加回声过滤。 */
export function cardTransport(): EchoFilteringTransport {
  return new EchoFilteringTransport(new PostMessageTransport(window.parent, window.parent));
}
