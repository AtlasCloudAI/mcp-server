// 2026-11-12 WorkBuddy：宿主把卡片发出的消息原样弹回来，卡片对弹回的 tools/call 回 -32601，
// 这条回复再被弹回、冒充了工具结果。回声过滤之后，卡片拿到的是宿主的真结果，也不再回 -32601。
import assert from "node:assert/strict";
import test from "node:test";
import { App } from "@modelcontextprotocol/ext-apps";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { EchoFilteringTransport, canonical } from "../ui/generation-card/echo-transport.js";

/** 像 WorkBuddy 那样的宿主：卡片发的每条消息先原样弹回去，再（慢一点）给真回复。 */
class EchoingHost implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  fromCard: JSONRPCMessage[] = [];

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.fromCard.push(message);
    const echo = JSON.parse(JSON.stringify(message)) as JSONRPCMessage;
    setTimeout(() => this.onmessage?.(echo), 1);
    const request = message as { id?: number; method?: string };
    if (request.method === "ui/initialize") {
      setTimeout(
        () =>
          this.onmessage?.({
            jsonrpc: "2.0",
            id: request.id!,
            result: { protocolVersion: "2026-01-26", hostInfo: { name: "WorkBuddy", version: "5.5.6" }, hostCapabilities: { serverTools: {} }, hostContext: {} },
          }),
        5
      );
    }
    if (request.method === "tools/call") {
      // 真回复要等用户点「允许」，比回声晚得多。
      setTimeout(
        () => this.onmessage?.({ jsonrpc: "2.0", id: request.id!, result: { content: [{ type: "text", text: "real result" }] } }),
        40
      );
    }
  }
}

test("canonical 不看键的顺序", () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonical({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
});

test("宿主弹回卡片的消息：回声被丢掉，工具调用拿到真结果，卡片不再回 -32601", async () => {
  const host = new EchoingHost();
  const transport = new EchoFilteringTransport(host);
  const app = new App({ name: "echo-test", version: "1" }, {}, { autoResize: false });
  await app.connect(transport);
  const result = await app.callServerTool({ name: "atlas_use_assets", arguments: { asset_ids: ["a1"] } });
  assert.deepEqual(result.content, [{ type: "text", text: "real result" }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const methodNotFound = host.fromCard.filter((m) => (m as { error?: { code?: number } }).error?.code === -32601);
  assert.equal(methodNotFound.length, 0, "卡片不该对弹回来的请求回 Method not found");
  assert.ok(transport.dropped >= 2, `回声应被丢掉，实际 ${transport.dropped}`);
  await app.close();
});

test("宿主发来的正常消息照常处理", async () => {
  let received: JSONRPCMessage | undefined;
  const inner: Transport = { async start() {}, async close() {}, async send() {} };
  const transport = new EchoFilteringTransport(inner);
  transport.onmessage = (message) => {
    received = message;
  };
  await transport.start();
  await transport.send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: 1, height: 2 } });
  const fromHost: JSONRPCMessage = { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark" } };
  inner.onmessage?.(fromHost);
  assert.deepEqual(received, fromHost);
});
