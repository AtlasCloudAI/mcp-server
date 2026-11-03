// 2026-11-03 Claude 网页版验收发现的几处：卡片交给模型的内容、附件导入工具、图生视频比例、余额取整、确认没开始。
import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { settingsChips } from "../src/apps/card-params.js";
import { formatBalanceUsd, describeBillingAccount } from "../src/services/billing-account.js";
import { passesChatAttachmentLinks } from "../src/services/client-profile.js";
import { describeNotStarted, recentNotStarted, rememberNotStarted } from "../src/services/not-started.js";
import { InMemoryUploadTicketStore } from "../src/services/upload-ticket-store.js";
import { earliestTime, formatBalance } from "../ui/generation-card/card.js";
import { contextReachesModel, handOff } from "../ui/generation-card/handoff.js";

function fakeApp(hostName: string, sent: string[], context: string[]): App {
  return {
    getHostCapabilities: () => ({ updateModelContext: {}, message: {} }),
    getHostVersion: () => ({ name: hostName, version: "1" }),
    updateModelContext: async (params: { content: Array<{ text: string }> }) => {
      context.push(params.content[0]!.text);
      return {};
    },
    sendMessage: async (params: { content: Array<{ text: string }> }) => {
      sent.push(params.content[0]!.text);
      return {};
    },
  } as unknown as App;
}

test("handing files to the model: only ChatGPT gets the short message, other hosts get the IDs and URLs in it", async () => {
  const forModel = "- teapot.jpg (image, from the Asset Library, asset_123): https://atlas-asset/x?Expires=1";
  const text = { short: "I've picked 1 file. Please use it.", ask: "Please use it." };

  const chatgptSent: string[] = [];
  const chatgptContext: string[] = [];
  assert.equal(await handOff(fakeApp("chatgpt", chatgptSent, chatgptContext), forModel, text), "sent");
  assert.deepEqual(chatgptSent, [text.short]);
  assert.deepEqual(chatgptContext, [forModel]);

  // Claude 收下上下文，但模型看不到：消息里要有编号和地址。
  const claudeSent: string[] = [];
  const claudeContext: string[] = [];
  assert.equal(await handOff(fakeApp("Claude", claudeSent, claudeContext), forModel, text), "sent");
  assert.equal(claudeSent.length, 1);
  assert.match(claudeSent[0]!, /asset_123/);
  assert.match(claudeSent[0]!, /https:\/\/atlas-asset\/x/);

  assert.equal(contextReachesModel(fakeApp("openai-chatgpt", [], [])), true);
  assert.equal(contextReachesModel(fakeApp("claude-ai", [], [])), false);
  assert.equal(contextReachesModel(fakeApp("", [], [])), false);
});

test("the chat attachment importer is only for clients that pass attachments as links", () => {
  assert.equal(passesChatAttachmentLinks("https://chatgpt.com/oauth/client.json"), true);
  assert.equal(passesChatAttachmentLinks("https://claude.ai/oauth/mcp-oauth-client-metadata"), false);
  assert.equal(passesChatAttachmentLinks("https://claude.ai/oauth/claude-code-client-metadata"), false);
  assert.equal(passesChatAttachmentLinks("https://chatgpt.com/oauth/codex/client.json"), false);
  // 认不出的（动态注册的客户端等）保留：它们也可能这样传附件。
  assert.equal(passesChatAttachmentLinks("dcr-client-abc"), true);
  assert.equal(passesChatAttachmentLinks(undefined), true);
});

test("an adaptive ratio reads as following the image, other ratios stay as they are", () => {
  assert.ok(settingsChips({ resolution: "720p", duration: 5, ratio: "adaptive" }).includes("Ratio from image"));
  assert.ok(settingsChips({ aspect_ratio: "9:16" }).includes("9:16"));
  assert.ok(!settingsChips({ ratio: "adaptive" }).includes("adaptive"));
});

test("balances are cut to the cent, never rounded up, on the card and in the quote text", () => {
  // 11-03：$45.3967 卡片写 $45.40、官网写 $45.39。
  assert.equal(formatBalanceUsd(45.3967), "$45.39");
  assert.equal(formatBalance(45.3967), "$45.39");
  assert.equal(formatBalanceUsd(8.5), "$8.50");
  assert.equal(formatBalance(45.4), "$45.40");
  assert.equal(formatBalanceUsd(0), "$0.00");
  assert.equal(formatBalanceUsd(-1.234), "-$1.24");
  assert.equal(
    describeBillingAccount({ name: "Lucas Zhu", type: "personal", user_email: "lucas@example.com", available_usd: 45.3967 }),
    "Lucas Zhu (personal account, lucas@example.com) · $45.39 available"
  );
});

test("a confirm that did not start is remembered per user and shown with the history", async () => {
  const store = new InMemoryUploadTicketStore();
  const now = new Date("2026-11-03T08:30:00.000Z");
  await rememberNotStarted(
    "black-forest-labs/flux-schnell",
    "Model black-forest-labs/flux-schnell is temporarily unavailable. Nothing was charged.\nTell the user to pick another model.",
    { store, now }
  );
  const entries = await recentNotStarted({ store, now });
  assert.deepEqual(entries, [
    {
      model: "black-forest-labs/flux-schnell",
      reason: "Model black-forest-labs/flux-schnell is temporarily unavailable. Nothing was charged.",
      at: "2026-11-03T08:30:00.000Z",
    },
  ]);
  const text = describeNotStarted(entries)!;
  assert.match(text, /did not start/);
  assert.match(text, /flux-schnell: Model black-forest-labs\/flux-schnell is temporarily unavailable/);

  // 一小时以后不再提；没有记录时不附任何文字。
  assert.deepEqual(await recentNotStarted({ store, now: new Date("2026-11-03T09:31:00.000Z") }), []);
  assert.equal(describeNotStarted([]), undefined);

  // 最多留最近 3 条，新的在前。
  for (const model of ["a/1", "a/2", "a/3"]) await rememberNotStarted(model, "Insufficient balance.", { store, now });
  assert.deepEqual((await recentNotStarted({ store, now })).map((entry) => entry.model), ["a/3", "a/2", "a/1"]);
});

test("a workflow's later steps don't restart the card's elapsed time (issue 27)", () => {
  const submitted = "2026-11-03T09:46:46.000Z";
  // 工作流每一步的 created_at 都更晚：沿用提交时的。
  assert.equal(earliestTime(submitted, "2026-11-03T09:47:30.000Z"), submitted);
  assert.equal(earliestTime("2026-11-03T09:47:30.000Z", submitted), submitted);
  assert.equal(earliestTime(undefined, submitted), submitted);
  assert.equal(earliestTime(submitted, undefined), submitted);
  assert.equal(earliestTime(submitted, "not a time"), submitted);
  assert.equal(earliestTime(undefined, undefined), undefined);
});
