// 2026-11-11 Cursor：握手里不声明 message / updateModelContext，但实际处理这两个请求
// （Higgsfield 的上传卡在 Cursor 里照样把 media_id 发回了对话）。卡片以前按声明拦，
// 「Use 1 file」点了只显示一段「去对话里说」。现在直接试，真被拒才降级。
import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { handOff, messagingAvailable } from "../ui/generation-card/handoff.js";

type Sent = { method: string; params: unknown };

function fakeHost(opts: { caps?: Record<string, unknown>; acceptMessage: boolean; acceptContext: boolean }): { app: App; sent: Sent[] } {
  const sent: Sent[] = [];
  const app = {
    getHostCapabilities: () => opts.caps,
    getHostVersion: () => ({ name: "Cursor", version: "3.27" }),
    updateModelContext: async (params: unknown) => {
      sent.push({ method: "ui/update-model-context", params });
      if (!opts.acceptContext) throw new Error("Method not found");
      return {};
    },
    sendMessage: async (params: unknown) => {
      sent.push({ method: "ui/message", params });
      if (!opts.acceptMessage) throw new Error("Method not found");
      return {};
    },
  } as unknown as App;
  return { app, sent };
}

const TEXT = { short: "Use these files.", ask: "Use them for my request." };

test("宿主没声明能力也照样试：Cursor 那样能发，就把文件交回对话", async () => {
  const { app, sent } = fakeHost({ caps: { serverTools: {} }, acceptMessage: true, acceptContext: true });
  assert.equal(await handOff(app, "asset_id: a1", TEXT), "sent");
  assert.deepEqual(
    sent.map((s) => s.method),
    ["ui/update-model-context", "ui/message"]
  );
  // 不是 ChatGPT：上下文里的内容模型看不到，消息里要带上文件编号。
  const message = sent[1]!.params as { content: Array<{ text: string }> };
  assert.match(message.content[0]!.text, /asset_id: a1/);
  assert.equal(messagingAvailable(), true);
});

test("没声明、试了也被拒：算不支持，之后不再摆要发消息的按钮", async () => {
  const { app } = fakeHost({ caps: { serverTools: {} }, acceptMessage: false, acceptContext: false });
  assert.equal(await handOff(app, "asset_id: a1", TEXT), "unsupported");
  assert.equal(messagingAvailable(), false);
});

test("声明了却失败：是真失败，提示重试，不当成不支持", async () => {
  const { app } = fakeHost({ caps: { message: {}, updateModelContext: {} }, acceptMessage: false, acceptContext: false });
  assert.equal(await handOff(app, "asset_id: a1", TEXT), "failed");
});
