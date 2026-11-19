import assert from "node:assert/strict";
import test from "node:test";
import { canExpandIn, fullscreenWasRefused, toolResultKey } from "../ui/generation-card/display.js";

// 11-13 WorkBuddy 桌面版回归：资产库卡选不中图、View all 点了没反应。

test("宿主声明了全屏但请求时回 inline：之后按不能全屏显示，资产库改用翻页条", () => {
  const workbuddy = { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] };
  assert.equal(canExpandIn(workbuddy, false), true);
  assert.equal(fullscreenWasRefused({ mode: "inline" }), true);
  assert.equal(canExpandIn(workbuddy, true), false);
  // 真给了全屏、请求出错、没回 mode 三种情况。
  assert.equal(fullscreenWasRefused({ mode: "fullscreen" }), false);
  assert.equal(fullscreenWasRefused("error"), true);
  assert.equal(fullscreenWasRefused({}), false);
  assert.equal(fullscreenWasRefused(undefined), false);
  // 没声明全屏、已经在全屏：本来就不显示 View all。
  assert.equal(canExpandIn({ displayMode: "inline", availableDisplayModes: ["inline"] }, false), false);
  assert.equal(canExpandIn({ displayMode: "fullscreen", availableDisplayModes: ["inline", "fullscreen"] }, false), false);
  assert.equal(canExpandIn(undefined, false), false);
});

test("同一个工具结果发两次认得出来，内容不同的不算重复", () => {
  const result = { structuredContent: { count: 7, assets: [{ id: "a1" }] }, _meta: { "atlascloud/assets": { items: [1] } } };
  assert.equal(toolResultKey(result), toolResultKey(JSON.parse(JSON.stringify(result))));
  assert.notEqual(toolResultKey(result), toolResultKey({ ...result, structuredContent: { count: 8, assets: [] } }));
  assert.notEqual(toolResultKey(result), toolResultKey({ ...result, isError: true }));
});
