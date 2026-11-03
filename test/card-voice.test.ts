// 卡片替用户说的话（验收问题 3、21）：跟宿主界面语言走；Claude 里只填进输入框，发完提示点发送。
import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { PREFILLED_NOTE, SEND_FAILED_NOTE, hostPrefills, say, sendForUser, userLang } from "../ui/generation-card/voice.js";

function fakeApp(host: string, locale: string | undefined, reply: () => Promise<{ isError?: boolean }>): { app: App; sent: string[] } {
  const sent: string[] = [];
  const app = {
    getHostVersion: () => ({ name: host, version: "1" }),
    getHostContext: () => (locale ? { locale } : {}),
    sendMessage: async (params: { content: Array<{ text: string }> }) => {
      sent.push(params.content[0]!.text);
      return reply();
    },
  } as unknown as App;
  return { app, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("messages follow the host's language: Chinese for a zh locale, English otherwise", () => {
  assert.equal(userLang(fakeApp("chatgpt", "zh-CN", async () => ({})).app), "zh");
  assert.equal(userLang(fakeApp("chatgpt", "zh-Hans", async () => ({})).app), "zh");
  assert.equal(userLang(fakeApp("chatgpt", "en-US", async () => ({})).app), "en");
  assert.equal(say.pickedFromLibrary("zh", 1, "teapot.jpg").short, "我在 Atlas 卡片里从资产库选了 1 个文件（teapot.jpg），请用它。");
  assert.equal(say.addedInCard("zh", 2, "a.jpg, b.jpg").ask, "请用它们。");
  assert.equal(say.addedInCard("en", 1, "a.jpg").short, "I've added 1 file in the Atlas card (a.jpg). Please use it.");
  assert.equal(say.switchModel("zh", "Flux Schnell"), "Flux Schnell 现在用不了，请换一个模型做同样的需求。");
  assert.equal(say.missingFromLibrary("zh", []), "有一个文件已经不在我的资产库里了。请打开我的资产库，我重新选一个文件。");
  assert.match(say.replacedDeleted("zh", 1, "new.jpg", ["old.jpg"]).short, /替换 old\.jpg/);
});

test("in Claude the message only lands in the message box, so the card says to press send", async () => {
  assert.equal(hostPrefills(fakeApp("Claude", undefined, async () => ({})).app), true);
  assert.equal(hostPrefills(fakeApp("chatgpt", undefined, async () => ({})).app), false);

  const notices: string[] = [];
  const claude = fakeApp("claude-ai", "zh-CN", async () => ({}));
  sendForUser(claude.app, say.changeRequest(userLang(claude.app)), (t) => notices.push(t));
  await settle();
  assert.deepEqual(claude.sent, ["生成之前，我想改一下需求。"]);
  assert.deepEqual(notices, [PREFILLED_NOTE]);

  // ChatGPT 直接发出去了，不用提示。
  const chatgpt = fakeApp("chatgpt", "en-US", async () => ({}));
  const quiet: string[] = [];
  sendForUser(chatgpt.app, "hi", (t) => quiet.push(t));
  await settle();
  assert.deepEqual(quiet, []);

  // 宿主拒绝或出错：请用户自己在聊天里说。
  const failed: string[] = [];
  sendForUser(fakeApp("chatgpt", undefined, async () => ({ isError: true })).app, "hi", (t) => failed.push(t));
  sendForUser(fakeApp("chatgpt", undefined, async () => Promise.reject(new Error("no"))).app, "hi", (t) => failed.push(t));
  await settle();
  assert.deepEqual(failed, [SEND_FAILED_NOTE, SEND_FAILED_NOTE]);
});
