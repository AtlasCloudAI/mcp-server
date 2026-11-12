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
