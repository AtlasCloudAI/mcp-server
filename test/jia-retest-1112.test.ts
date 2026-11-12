// 11-12 Jia 在 Claude 网页版复测发现的几处（《Claude网页版复测报告_1112》）。
import assert from "node:assert/strict";
import test from "node:test";
import { loadSavedUploads, saveUploads } from "../ui/generation-card/upload.js";
import { defaultRouteGuidance, defaultRouteSummary } from "../src/services/default-models.js";

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

test("U3：上传卡传好的文件按上传地址存在本地，切走对话再回来能恢复；过期的记录顺手清掉", () => {
  const store = new MemoryStorage();
  const key = "atlas-upload-card:https://mcp.test.atlascloud.ai/upload/t_abc";
  const now = Date.now();
  saveUploads(
    key,
    {
      at: now,
      items: [{ name: "test-product.jpg", size: 233_000, kind: "image", url: "https://x/a.jpg", asset_id: "asset_1", saved: true }],
      handedOff: "",
    },
    store
  );
  const back = loadSavedUploads(key, now + 60_000, store);
  assert.equal(back?.items.length, 1);
  assert.equal(back?.items[0]?.asset_id, "asset_1");

  // 一天前的记录不恢复，并在下次保存时被清掉。
  const old = "atlas-upload-card:https://mcp.test.atlascloud.ai/upload/t_old";
  store.setItem(old, JSON.stringify({ at: now - 2 * 24 * 60 * 60_000, items: [{ name: "x" }], handedOff: "" }));
  assert.equal(loadSavedUploads(old, now, store), undefined);
  saveUploads(key, { at: now, items: back!.items, handedOff: "https://x/a.jpg" }, store);
  assert.equal(store.getItem(old), null);

  // 删光了就删记录；存储不可用时不报错。
  saveUploads(key, { at: now, items: [], handedOff: "" }, store);
  assert.equal(store.getItem(key), null);
  assert.doesNotThrow(() => saveUploads(key, { at: now, items: [], handedOff: "" }, undefined));
  assert.equal(loadSavedUploads(key, now, undefined), undefined);
});

test("P6 设计 2：自己挑模型时要写 why_this_model，工具说明和服务器说明都写明", () => {
  assert.match(defaultRouteGuidance("Image"), /pick the model yourself[^.]*why_this_model/);
  assert.match(defaultRouteGuidance("Video"), /why_this_model/);
  assert.match(defaultRouteSummary(), /why_this_model/);
});

test("第二轮 G2：打字确认后旧报价卡在后台问几次交过没有——先密后疏，问满 10 分钟停", async () => {
  const { watchGap, WATCH_FOR_MS } = await import("../ui/generation-card/quote.js");
  assert.equal(watchGap(0, 0), 10_000);
  assert.equal(watchGap(1, 10_000), 20_000);
  assert.equal(watchGap(2, 30_000), 30_000);
  assert.equal(watchGap(3, 60_000), 60_000);
  assert.equal(watchGap(12, WATCH_FOR_MS - 60_000), 60_000);
  assert.equal(watchGap(13, WATCH_FOR_MS - 30_000), undefined);
  // 10 分钟内一共问不到 15 次。
  let n = 0;
  let elapsed = 0;
  for (let gap = watchGap(n, elapsed); gap !== undefined; gap = watchGap(++n, elapsed)) elapsed += gap;
  assert.ok(n <= 15, `问了 ${n} 次`);
});

test("第二轮 G2：只在卡上还是一份等确认、没过期的真报价时才问", async () => {
  const { awaitingConfirmation } = await import("../ui/generation-card/quote.js");
  const now = Date.parse("2026-11-12T06:00:00Z");
  const quote = { tool: "atlas_generate_image", idempotency_key: "k", arguments: {}, expires_at: "2026-11-12T06:30:00Z" };
  const card = { state: "quote", quote } as never;
  assert.equal(awaitingConfirmation(card, { phase: "ready" } as never, now), true);
  assert.equal(awaitingConfirmation(card, { phase: "price_changed" } as never, now), true);
  // 用户自己点了确认、正在提交 / 核实，或者重新打开时正在问：都不插手。
  for (const phase of ["submitting", "verifying", "resuming", "expired", "error"]) {
    assert.equal(awaitingConfirmation(card, { phase } as never, now), false, phase);
  }
  // 已经是进度 / 结果、样例卡、报价过期了：不问。
  assert.equal(awaitingConfirmation({ state: "running", quote } as never, { phase: "ready" } as never, now), false);
  assert.equal(awaitingConfirmation({ state: "quote", quote, sample: true } as never, { phase: "ready" } as never, now), false);
  assert.equal(awaitingConfirmation(card, { phase: "ready" } as never, Date.parse("2026-11-12T07:00:00Z")), false);
});
