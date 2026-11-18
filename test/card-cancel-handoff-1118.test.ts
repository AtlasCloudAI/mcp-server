// 11-18 上线前审查（卡片前端）：
// M10 宿主取消工具调用（审批框拒绝）、工具结果读不出来时，卡片一直转圈；
// M11 上传卡「Use N files」等宿主回答期间能连点，发出两条消息、两张报价卡；
// 顺手：宿主重放同一个工具结果时，生成卡不被打回待确认。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { cancelledCall } from "../ui/generation-card/card.js";
import { createReplayGuard } from "../ui/generation-card/display.js";
import { createUploader, useButtonState } from "../ui/generation-card/upload.js";
import { cancelledCopy } from "../ui/generation-card/view.js";
import { say } from "../ui/generation-card/voice.js";

const MAIN = readFileSync(new URL("../ui/generation-card/main.ts", import.meta.url), "utf8");

// ---------- M10：取消 ----------

test("M10 取消：报价调用算没提交；确认提交、或不知道参数的算结果未知", () => {
  const quoteArgs = { model: "bytedance/seedream-v5.0-pro", params: { prompt: "cat" }, idempotency_key: "k1" };
  for (const tool of ["atlas_generate_image", "atlas_generate_video", "atlas_generate_audio", "atlas_quick_generate"]) {
    assert.equal(cancelledCall({ tool, args: quoteArgs }), "not_submitted", tool);
    assert.equal(cancelledCall({ tool, args: { ...quoteArgs, confirmed: true, confirmation_token: "c2.1.x" } }), "unknown", tool);
    // 只带 token 没带 confirmed、confirmed 写成别的样子：都不敢说没提交。
    assert.equal(cancelledCall({ tool, args: { ...quoteArgs, confirmation_token: "c2.1.x" } }), "unknown", tool);
    assert.equal(cancelledCall({ tool, args: { ...quoteArgs, confirmed: "true" } }), "unknown", tool);
    // 宿主没给参数（取消先于 tool-input 到）：不知道是不是确认那一次。
    assert.equal(cancelledCall({ tool }), "unknown", tool);
  }
  // 明确 confirmed: false、空 token：还是报价调用。
  assert.equal(cancelledCall({ tool: "atlas_generate_image", args: { ...quoteArgs, confirmed: false, confirmation_token: " " } }), "not_submitted");
});

test("M10 取消：查任务状态单独一类；宿主没给工具名时按参数认；别的工具不说扣费", () => {
  assert.equal(cancelledCall({ tool: "atlas_get_prediction", args: { prediction_id: "p1" } }), "lookup");
  assert.equal(cancelledCall({ tool: "atlas_card_status", args: { prediction_id: "p1" } }), "lookup");
  assert.equal(cancelledCall({ args: { prediction_id: "p1" } }), "lookup");
  assert.equal(cancelledCall({ args: { model: "x/y", params: {} } }), "not_submitted");
  assert.equal(cancelledCall({ args: { model: "x/y", confirmed: true } }), "unknown");
  assert.equal(cancelledCall({ tool: "atlas_open_upload_card", args: {} }), "other");
  assert.equal(cancelledCall({ tool: "atlas_list_predictions" }), "other");
  assert.equal(cancelledCall({}), "other");
});

test("M10 取消卡的话：只有报价调用说没提交、没扣费；结果未知的提醒先查历史，不说没扣费", () => {
  const notSubmitted = cancelledCopy("not_submitted").lines.join(" ");
  assert.match(notSubmitted, /nothing was submitted and nothing was charged/);

  const unknown = cancelledCopy("unknown");
  assert.equal(unknown.badge, "Result unknown");
  assert.equal(unknown.warn, true);
  const unknownText = unknown.lines.join(" ");
  assert.match(unknownText, /can't tell whether it had already been submitted/);
  assert.match(unknownText, /Check your recent generations/);
  assert.doesNotMatch(unknownText, /nothing was (?:submitted|charged)|not charged|wasn't charged/i);

  const lookup = cancelledCopy("lookup").lines.join(" ");
  assert.match(lookup, /status check was canceled/);
  assert.match(lookup, /generation itself isn't affected/);

  assert.doesNotMatch(cancelledCopy("other").lines.join(" "), /charged/);

  // 「Check history」替用户发的话：请模型先查，别重新生成。
  assert.match(say.checkAfterCancel("en"), /check my recent generations/i);
  assert.match(say.checkAfterCancel("en"), /don't start it again/);
  assert.match(say.checkAfterCancel("zh"), /先别重新生成/);
});

test("M10 卡片接上了宿主的取消通知，结果读不出来时显示加载失败而不是一直转圈", () => {
  // main.ts 一加载就连宿主、动 DOM，测不了整页；这里确认几处接线在。
  assert.match(MAIN, /app\.ontoolcancelled = \(\) => \{[\s\S]*?cancelled = cancelledCall\(\{ tool: app\.getHostContext\(\)\?\.toolInfo\?\.tool\.name, args: toolArgs \}\);/);
  // 已经画出卡片的不动。
  assert.match(MAIN, /app\.ontoolcancelled = \(\) => \{\s*if \(card \|\| history \|\| uploader \|\| library \|\| notStarted !== undefined \|\| loadError\) return;/);
  // 取消卡在加载卡之前画出来。
  const renderBody = MAIN.slice(MAIN.indexOf("function render("), MAIN.indexOf("function renderCancelled("));
  assert.ok(renderBody.indexOf("renderCancelled(cancelled)") > 0);
  assert.ok(renderBody.indexOf("renderCancelled(cancelled)") < renderBody.indexOf("loadingCard(pendingId);\n  // 全屏"));
  // ontoolresult 里 accept 失败不再静默 return。
  assert.doesNotMatch(MAIN, /if \(!accept\(params\)\) return;/);
  assert.match(MAIN, /if \(!accept\(params\)\) \{\s*\/\/[^\n]*\n\s*loadError = UNREADABLE_RESULT;\s*render\(\);\s*return;/);
});

// ---------- 顺手：重放 ----------

test("重放：已经画出卡片后又收到一模一样的工具结果算重放；第一次、内容不同的都照常处理", () => {
  const seen = createReplayGuard();
  const quote = { structuredContent: { status: "confirmation_required", confirmation_token: "c2.1.a" }, _meta: { "atlascloud/card": { state: "quote" } } };
  // 第一次（还没有卡片）。
  assert.equal(seen(quote, false), false);
  // 用户点了确认、卡片在提交中：宿主（WorkBuddy）把报价结果又发了一次。
  assert.equal(seen(JSON.parse(JSON.stringify(quote)), true), true);
  assert.equal(seen(quote, true), true);
  // 新的结果（重新报价、出结果）照常。
  const fresh = { ...quote, structuredContent: { status: "confirmation_required", confirmation_token: "c2.1.b" } };
  assert.equal(seen(fresh, true), false);
  // 还没有卡片时（上一次没读出来）同样的结果再来一次，照常处理。
  const other = createReplayGuard();
  assert.equal(other(quote, false), false);
  assert.equal(other(quote, false), false);
  // main.ts 在 accept 之前问它。
  assert.match(MAIN, /if \(isReplayedResult\(params, card !== undefined\)\) return;\s*if \(!accept\(params\)\)/);
});

// ---------- M11：上传卡「Use N files」 ----------

test("M11 「Use N files」按钮：交给模型期间显示 Sending… 并禁用，交出去后 Added to chat", () => {
  assert.deepEqual(useButtonState(2, false, false), { label: "Use 2 files", disabled: false });
  assert.deepEqual(useButtonState(1, false, false), { label: "Use 1 file", disabled: false });
  assert.deepEqual(useButtonState(2, false, true), { label: "Sending…", disabled: true });
  assert.deepEqual(useButtonState(2, true, false), { label: "Added to chat", disabled: true });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** createUploader 只在 body 上挂一个文件选择框：给它一个最小的 document。 */
function withFakeDocument<T>(run: () => Promise<T>): Promise<T> {
  const g = globalThis as { document?: unknown };
  const saved = g.document;
  g.document = {
    createElement: () => ({ addEventListener() {}, click() {}, style: {}, dataset: {} }),
    body: { append() {} },
  };
  return run().finally(() => {
    if (saved === undefined) delete g.document;
    else g.document = saved;
  });
}

function fakeApp(sendMessage: () => Promise<{ isError?: boolean }>, contextOk = true) {
  const calls = { context: 0, message: 0 };
  const app = {
    getHostCapabilities: () => ({ message: {}, updateModelContext: {} }),
    getHostVersion: () => ({ name: "test-host", version: "1" }),
    getHostContext: () => ({ locale: "en-US" }),
    updateModelContext: async () => {
      calls.context += 1;
      if (!contextOk) throw new Error("context refused");
      return {};
    },
    sendMessage: () => {
      calls.message += 1;
      return sendMessage();
    },
  } as unknown as App;
  return { app, calls };
}

const UPLOAD = { view: "upload" as const, upload_url: "https://mcp.test/upload/abc", expires_at: "2099-01-01T00:00:00.000Z", max_bytes: 32_000_000, max_files: 10 };
const PICKED = [
  { asset_id: "a1", label: "cat.png", kind: "image" as const, url: "https://cdn.test/cat.png" },
  { asset_id: "a2", label: "dog.png", kind: "image" as const, url: "https://cdn.test/dog.png" },
];

test("M11 连点「Use N files」：宿主没回答前只发一条消息，期间 sending；回答后恢复、记成已交", async () => {
  await withFakeDocument(async () => {
    const reply = deferred<{ isError?: boolean }>();
    const { app, calls } = fakeApp(() => reply.promise);
    let renders = 0;
    const uploader = createUploader(UPLOAD, { app, render: () => void (renders += 1), notice: () => undefined, noticeText: () => undefined });
    uploader.addPicked(PICKED);
    assert.equal(uploader.sending, false);

    const first = uploader.useFiles();
    const second = uploader.useFiles();
    const third = uploader.useFiles();
    // 等 updateModelContext 那一步过去，sendMessage 发出去。
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(uploader.sending, true);
    assert.equal(calls.context, 1);
    assert.equal(calls.message, 1);
    await Promise.all([second, third]);
    assert.equal(calls.message, 1, "连点不重发");

    reply.resolve({});
    await first;
    assert.equal(uploader.sending, false);
    assert.ok(renders > 0);
    assert.equal(calls.message, 1);
  });
});

test("M11 交给模型失败：按钮恢复，可以再点一次", async () => {
  await withFakeDocument(async () => {
    const replies = [deferred<{ isError?: boolean }>(), deferred<{ isError?: boolean }>()];
    let n = 0;
    // 上下文、消息都没成：算真失败（宿主声明过能发）。
    const { app, calls } = fakeApp(() => replies[n++].promise, false);
    const notices: string[] = [];
    const uploader = createUploader(UPLOAD, { app, render: () => undefined, notice: (t) => void notices.push(t), noticeText: () => undefined });
    uploader.addPicked(PICKED);

    const first = uploader.useFiles();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(uploader.sending, true);
    replies[0].reject(new Error("host said no"));
    await first;
    assert.equal(uploader.sending, false);
    assert.ok(notices.includes("Couldn't send the files to the chat. Try again."));

    const retry = uploader.useFiles();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.message, 2);
    replies[1].resolve({});
    await retry;
    assert.equal(uploader.sending, false);
  });
});
