import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 11-14 Jia：1:3 竖图的上传缩略图被裁成方形。原因是 .upload-thumb 是 grid、里面的 img 用 100% 宽高，
// 竖图的 img 元素被按自身比例撑成 40×120，object-fit: contain 管不到元素外面，方框 overflow 一裁就只剩
// 中间一块方形。img 必须绝对定位铺满方框，元素本身才永远是方框大小。
test("upload thumbnail image fills its box instead of growing with the picture", () => {
  const css = readFileSync(new URL("../ui/generation-card/styles.css", import.meta.url), "utf8");
  const box = /\.upload-thumb\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  const img = /\.upload-thumb img\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.match(box, /position:\s*relative/);
  assert.match(img, /position:\s*absolute/);
  assert.match(img, /inset:\s*0/);
  assert.match(css, /\.upload-thumb img\.upload-fit\s*\{[^}]*object-fit:\s*contain/);
});
