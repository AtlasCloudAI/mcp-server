import assert from "node:assert/strict";
import test from "node:test";
import { checkSubmission } from "../src/apps/submission-check.js";
import { reusableSettings } from "../src/apps/history-card.js";
import { IdempotencyCanceledError, cancelIdempotent, executeIdempotently } from "../src/services/idempotency.js";
import { chargedUsd } from "../src/tools/predictions.js";
import type { HistoryItem } from "../src/response-schemas.js";
import { assetRefLines } from "../ui/generation-card/assets.js";
import { readableReason } from "../ui/generation-card/card.js";
import { canceledState, failureState } from "../ui/generation-card/quote.js";
import { fileRefLines, formatBytes } from "../ui/generation-card/upload.js";
import { failureLead, wasBlocked } from "../ui/generation-card/view.js";
import { say } from "../ui/generation-card/voice.js";

// 11-13 Jia 的 Claude 网页版走查报告。

const item = (billing: unknown, extra: Record<string, unknown> = {}) =>
  ({ ID: "p1", model: "m", status: "failed", billing, ...extra }) as unknown as HistoryItem;

test("H01：退了款的失败单实扣是 0，不是退回去的那笔；没结算的算不出", () => {
  assert.equal(chargedUsd(item({ paymentStatus: 3, amount: "0.0043" })), 0);
  assert.equal(chargedUsd(item({ paymentStatus: 2, amount: "0.0043" })), 0.0043);
  assert.equal(chargedUsd(item({ paymentStatus: 4, amount: "0.8865" })), 0.8865);
  assert.equal(chargedUsd(item({ paymentStatus: 1, amount: "0.02" })), undefined);
  // 老后端不给 paymentStatus：照旧按 amount。
  assert.equal(chargedUsd(item({ amount: "0.018" })), 0.018);
  assert.equal(chargedUsd(item(undefined)), undefined);
});

test("A12/A14：作废的报价不能再确认，卡片核实时看到作废", async () => {
  const declined = "2d3e4f50-0000-4000-8000-000000000001";
  assert.deepEqual(await cancelIdempotent("atlas_generate_image", declined, "declined"), { status: "canceled", reason: "declined" });
  await assert.rejects(
    executeIdempotently("atlas_generate_image", { prompt: "puppy" }, declined, async () => ({ ok: true, predictionId: "x" })),
    (error: unknown) => error instanceof IdempotencyCanceledError && error.reason === "declined"
  );
  assert.deepEqual(await checkSubmission({ tool: "atlas_generate_image", idempotency_key: declined, on_load: true }), {
    outcome: "canceled",
    reason: "declined",
  });
  // 再作废一次：还是作废，原因不变。
  assert.deepEqual(await cancelIdempotent("atlas_generate_image", declined, "replaced"), { status: "canceled", reason: "declined" });

  // 已经提交过的作废不了。
  const done = "2d3e4f50-0000-4000-8000-000000000002";
  await executeIdempotently("atlas_generate_video", { prompt: "x" }, done, async () => ({ ok: true, predictionId: "pred-9" }));
  const result = await cancelIdempotent("atlas_generate_video", done, "replaced");
  assert.equal(result.status, "submitted");
});

test("A12/A14：卡片按作废原因显示；确认被拒的报错也认得出，不再走重新报价", () => {
  assert.deepEqual(canceledState("declined"), { phase: "canceled" });
  assert.deepEqual(canceledState("replaced"), { phase: "canceled", replaced: true });
  assert.deepEqual(failureState(`Error: ${new IdempotencyCanceledError("declined").message}`), { phase: "canceled" });
  assert.deepEqual(failureState(`Error: ${new IdempotencyCanceledError("replaced").message}`), { phase: "canceled", replaced: true });
});

test("B06：连不上上游的原始报错写成人话，失败卡第一句说清是谁的问题", () => {
  const raw = 'Post "https://upstream.example/v1": dial tcp: lookup upstream.example on 10.0.0.2:53: no such host';
  assert.match(readableReason(raw), /couldn't reach the model provider/);
  assert.match(readableReason("context deadline exceeded"), /didn't respond in time/);
  assert.match(failureLead(raw, "this image"), /model provider's side/);
  const gateway =
    'unexpected http status code: 502, body: {"code":400,"message":"workflow error: Missing required parameters：\'resolution\'"}';
  assert.equal(failureLead(gateway, "this image"), "Atlas Cloud didn't accept the settings for this image.");
  assert.equal(failureLead("Output rejected by content review", "this image"), "The model couldn't finish this image.");
});

test("D05/U02：Claude 里交给模型的消息是一句话 + 文件清单，不是整段英文说明", () => {
  const zh = say.pickedFromLibrary("zh", 2, "a.png, b.png");
  assert.equal(zh.lead, "请用我在 Atlas 资产库里选的这 2 个文件：");
  assert.match(say.addedInCard("en", 1, "a.png").lead ?? "", /^I've uploaded this file in the Atlas card/);
  assert.equal(
    assetRefLines([{ asset_id: "asset_1", label: "green.png", kind: "image", shape: "1080×1920" }]),
    "- green.png (image, 1080×1920): asset://asset_1"
  );
  assert.equal(
    fileRefLines([
      { name: "a.jpg", kind: "image", url: "https://x/a.jpg", asset_id: "asset_2" },
      { name: "b.mp3", kind: "audio", url: "https://x/b.mp3" },
    ]),
    "- a.jpg (image): asset://asset_2\n- b.mp3 (audio): https://x/b.mp3"
  );
});

test("H05：Reuse prompt 带上原来的参数和模型 ID", () => {
  const settings = reusableSettings(
    item(undefined, {
      requestBody: JSON.stringify({
        model: "bytedance/seedream-v5.0-flash/text-to-image",
        prompt: "a blue paper airplane",
        size: "2048*2048",
        num_images: 1,
        enable_sync_mode: false,
        image: "https://x/a.png",
        seed: 42,
      }),
    })
  );
  assert.deepEqual(settings, { size: "2048*2048", num_images: 1 });
  const text = say.reusePrompt("zh", "Seedream v5.0 Flash", "a blue paper airplane", [], 0, settings, "bytedance/seedream-v5.0-flash/text-to-image");
  assert.match(text, /参数（照原来的填）：size: 2048\*2048, num_images: 1/);
  assert.match(text, /bytedance\/seedream-v5\.0-flash\/text-to-image/);
  assert.equal(reusableSettings(item(undefined, { requestBody: { prompt: "x" } })), undefined);
});

test("U05：文件大小按 1000 进位，和 Finder 一致", () => {
  assert.equal(formatBytes(60_800_000), "60.8 MB");
  assert.equal(formatBytes(48_000_000), "48 MB");
  assert.equal(formatBytes(45_284), "45 KB");
});

test("S19：被宿主拦下的预览认得出来", () => {
  const blocked = new Set(["https://example.com"]);
  assert.equal(wasBlocked("https://example.com/a.jpg", blocked), true);
  assert.equal(wasBlocked("https://atlas.example/a.jpg", blocked), false);
});
