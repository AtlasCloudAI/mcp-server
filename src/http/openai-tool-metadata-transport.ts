import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import { remoteToolPolicy } from "../tool-policy.js";
import { CHATGPT_PUBLISHED_TOOLS } from "../services/chatgpt-published-tools.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function securitySchemes(name: string): Array<{ type: "oauth2"; scopes: string[] }> | undefined {
  const policy = remoteToolPolicy(name);
  if (!policy?.remote) return undefined;
  const scope = policy.scope;
  // 目录类工具不要求 scope（契约 v3 §4.2），公示成空集而不是编造一个 scope 名。
  return [{ type: "oauth2", scopes: scope === null ? [] : [scope] }];
}

export function withOpenAIToolSecuritySchemes(
  message: JSONRPCMessage
): JSONRPCMessage {
  const record = asRecord(message);
  const result = asRecord(record?.result);
  if (!Array.isArray(result?.tools)) return message;

  const tools = result.tools.map((value) => {
    const tool = asRecord(value);
    if (!tool || typeof tool.name !== "string") return value;
    const schemes = securitySchemes(tool.name);
    if (!schemes) return value;
    const meta = asRecord(tool._meta) ?? {};
    return {
      ...tool,
      securitySchemes: schemes,
      _meta: { ...meta, securitySchemes: schemes },
    };
  });

  return {
    ...record,
    result: { ...result, tools },
  } as unknown as JSONRPCMessage;
}

/** 工具定义上让宿主画卡片的键（generationCardToolMeta 写的那几个）。 */
const CARD_TOOL_META_KEYS = ["ui", "ui/resourceUri", "openai/outputTemplate", "openai/widgetAccessible"];
/** 工具结果里只给卡片读的数据（生成卡、资产库卡、上传卡、历史卡、没开始）。 */
const CARD_RESULT_META_KEYS = [
  "atlascloud/card",
  "atlascloud/assets",
  "atlascloud/upload",
  "atlascloud/history",
  "atlascloud/not_started",
];

function withoutKeys(meta: unknown, keys: string[]): Record<string, unknown> | undefined {
  const record = asRecord(meta);
  if (!record) return undefined;
  const rest = Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function withMeta<T extends Record<string, unknown>>(value: T, meta: Record<string, unknown> | undefined): T {
  const { _meta: _dropped, ...rest } = value;
  return (meta ? { ...rest, _meta: meta } : rest) as T;
}

/**
 * 给不显示卡片的客户端去掉卡片：工具列表上的卡片模板、工具结果里给卡片的数据。
 *
 * WorkBuddy 只看工具上的 `_meta.ui.resourceUri` 就画卡片，但宿主把卡片发出的消息原样弹回、
 * 拦掉卡片发起的工具调用、全屏声明了却给内联（11-12/11-13 实测），卡片按钮点不动。
 * 只藏卡片专用工具不够（e692c58 那样），生成工具挂着模板它照样画。文字结果和给模型的指引不动。
 */
export function withoutCards(message: JSONRPCMessage): JSONRPCMessage {
  const record = asRecord(message);
  const result = asRecord(record?.result);
  if (!record || !result) return message;
  if (Array.isArray(result.tools)) {
    const tools = result.tools.map((value) => {
      const tool = asRecord(value);
      return tool ? withMeta(tool, withoutKeys(tool._meta, CARD_TOOL_META_KEYS)) : value;
    });
    return { ...record, result: { ...result, tools } } as unknown as JSONRPCMessage;
  }
  if (asRecord(result._meta)) {
    return { ...record, result: withMeta(result, withoutKeys(result._meta, CARD_RESULT_META_KEYS)) } as unknown as JSONRPCMessage;
  }
  return message;
}

/**
 * 把工具列表里那几个工具的描述和参数结构换成 ChatGPT 已发布的原文（services/chatgpt-published-tools.ts），
 * 其他字段（标题、标注、_meta 里的卡片模板）不动。只在 MCP_CHATGPT_LEAN_DESCRIPTIONS=published 且是 ChatGPT 时用。
 * 服务端校验仍按当前参数结构：已发布结构只差说明文字、且更严，ChatGPT 生产现在就按它调用。
 */
export function withPublishedToolText(message: JSONRPCMessage): JSONRPCMessage {
  const record = asRecord(message);
  const result = asRecord(record?.result);
  if (!record || !result || !Array.isArray(result.tools)) return message;
  const tools = result.tools.map((value) => {
    const tool = asRecord(value);
    const published = typeof tool?.name === "string" ? CHATGPT_PUBLISHED_TOOLS[tool.name] : undefined;
    return tool && published
      ? { ...tool, description: published.description, inputSchema: structuredClone(published.inputSchema) }
      : value;
  });
  return { ...record, result: { ...result, tools } } as unknown as JSONRPCMessage;
}

export class OpenAIToolMetadataTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo
  ) => void;

  /**
   * onSend 能看到每条发出的消息（改写前的原样），工具调用埋点靠它拿到真实的返回结果。
   * 放在这里是因为这是每个请求唯一的出口，不必为它再套一层传输。
   */
  constructor(
    private readonly inner: Transport,
    private readonly onSend?: (message: JSONRPCMessage) => void,
    /** 这个客户端不显示卡片：发出前去掉卡片模板和卡片数据（withoutCards）。 */
    private readonly noCards = false,
    /** ChatGPT 的三个生成工具用已发布原文（withPublishedToolText）。 */
    private readonly publishedTools = false
  ) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
    await this.inner.start();
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions
  ): Promise<void> {
    this.onSend?.(message);
    let outgoing = this.noCards ? withoutCards(message) : message;
    if (this.publishedTools) outgoing = withPublishedToolText(outgoing);
    await this.inner.send(withOpenAIToolSecuritySchemes(outgoing), options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }
}
