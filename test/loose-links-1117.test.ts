import assert from "node:assert/strict";
import test from "node:test";
import { checkInputLinks, localInputValues } from "../src/services/input-link-check.js";

// 11-17 实测：这几种写法不以 "http://" 开头，链接预检不当它是链接，原样出了报价；
// WHATWG URL 解析器（浏览器、Node、不少下载器）却把它们都解析成 169.254.169.254。
const LOOSE = [
  "http:/169.254.169.254/latest/meta-data/",
  "http:\\\\169.254.169.254\\latest\\meta-data\\",
  "http:169.254.169.254/latest/meta-data/",
  "HTTPS:/169.254.169.254/",
  "h\tttp://169.254.169.254/latest/meta-data/",
  "http:\n//169.254.169.254/",
  "\u0000http://169.254.169.254/",
  "//169.254.169.254/latest/meta-data/",
  "\\\\/169.254.169.254/",
  "/\\169.254.169.254/",
  "//2852039166/latest/meta-data/",
  "//backend/latest",
];

test("loose links that URL parsers still resolve are refused before quoting", () => {
  for (const value of LOOSE) {
    const problems = localInputValues({ images: [value] });
    assert.equal(problems.length, 1, `not refused: ${JSON.stringify(value)}`);
    assert.equal(problems[0]!.field, "images");
  }
  for (const value of LOOSE.slice(0, 4)) {
    assert.match(localInputValues({ images: [value] })[0]!.reason, /not a complete link/);
  }
});

test("the WHATWG parser really does read them as the metadata address", () => {
  // 带协议的几种单独解析；没写协议的（//… 和反斜杠）按所在页面的地址补协议。
  for (const value of LOOSE.slice(0, 7)) {
    assert.equal(new URL(value).hostname, "169.254.169.254", JSON.stringify(value));
  }
  for (const value of LOOSE.slice(7, 11)) {
    assert.equal(new URL(value, "https://example.com/").hostname, "169.254.169.254", JSON.stringify(value));
  }
});

test("a malformed http link is refused in any non-text field, not only media fields", () => {
  assert.equal(localInputValues({ style: "http:/169.254.169.254/" }).length, 1);
  assert.equal(localInputValues({ options: { callback: "http:\\\\10.0.0.1\\x" } }).length, 1);
});

test("text fields, plain values and well-formed links are left alone", () => {
  const problems = localInputValues({
    prompt: "see http:/example and //example.com",
    negative_prompt: "//no",
    style: "//minimal",
    images: ["https://cdn.example.com/a.png", "HTTP://cdn.example.com/b.png", "asset://asset_abc"],
    ratio: "16:9",
  });
  assert.deepEqual(problems, []);
});

test("base64 MP3 data that starts with // is still not taken for a link", () => {
  // 0xFF 0xFB 0x90 0x44：MPEG-1 Layer III 128 kbps 44.1 kHz 帧头，base64 后以 "//uQ" 开头。
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, ...Array<number>(60).fill(0)]).toString("base64");
  assert.ok(mp3.startsWith("//"));
  assert.deepEqual(localInputValues({ audio: mp3, reference_audios: [mp3] }), []);
  assert.deepEqual(localInputValues({ audio: "//uQxAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAD" }), []);
});

test("checkInputLinks returns the loose link without contacting anything", async () => {
  const problems = await checkInputLinks({ image: "http:/169.254.169.254/latest/meta-data/" }, { timeoutMs: 500 });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.reason, /not a complete link/);
});
