import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import {
  isAtlasToolName,
  TOOL_POLICIES,
} from "../tool-policy.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function securitySchemes(name: string): Array<{ type: "oauth2"; scopes: string[] }> | undefined {
  if (!isAtlasToolName(name) || !TOOL_POLICIES[name].remote) return undefined;
  return [{ type: "oauth2", scopes: [TOOL_POLICIES[name].scope] }];
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

export class OpenAIToolMetadataTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo
  ) => void;

  constructor(private readonly inner: Transport) {}

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
    await this.inner.send(withOpenAIToolSecuritySchemes(message), options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }
}
