import assert from "node:assert/strict";
import test from "node:test";
import { rfc5987Value, uploadStreamToAssetLibrary } from "../src/services/api-client.js";

// RFC 5987 attr-char：filename*= 的值里除了 %XX 只能出现这些字符。
const ATTR_CHARS = /^(?:[A-Za-z0-9!#$&+\-.^_`|~]|%[0-9A-F]{2})*$/;

// 11-17 Jia D8：「<img src=x onerror=alert(1)><b>bold<:b>.png」（正常 PNG）传不进资产库，
// 实测是括号：encodeURIComponent 不编码 ( )，AssetD 解析 filename* 失败、跳过文件，回 400。
test("filename* is a valid RFC 5987 value for names with parentheses and quotes", () => {
  for (const name of ["photo (1).png", "f(1).png", "a'b.png", "a*b.png", "<img src=x onerror=alert(1)>.png", "纸飞机 (2).jpg"]) {
    const value = rfc5987Value(name);
    assert.match(value, ATTR_CHARS, `${name} -> ${value}`);
    assert.equal(decodeURIComponent(value), name);
  }
});

test("the Asset Library upload carries a parsable file name for photo (1).png", async () => {
  let sent: { body: Buffer; contentType: string } | undefined;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const chunks: Buffer[] = [];
    for await (const chunk of init!.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    sent = { body: Buffer.concat(chunks), contentType: new Headers(init!.headers).get("content-type")! };
    return new Response(JSON.stringify({ data: { asset_id: "asset_1", mime_type: "image/png" } }), { status: 201 });
  }) as typeof fetch;
  async function* body(): AsyncGenerator<Uint8Array> {
    yield new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  }

  const result = await uploadStreamToAssetLibrary(
    body(),
    { filename: "photo (1).png", contentType: "image/png", maxBytes: 1_000, apiKey: "k" },
    { fetcher }
  );
  assert.equal(result.assetId, "asset_1");
  const head = sent!.body.toString("utf8");
  const ext = /filename\*=UTF-8''([^\r\n;]*)/.exec(head)?.[1];
  assert.equal(ext, "photo%20%281%29.png");
  assert.match(ext!, ATTR_CHARS);
  // 按标准解析得出原名（Node 的表单解析器和 AssetD 一样读 Content-Disposition）。
  const form = await new Request("http://x/", { method: "POST", body: sent!.body, headers: { "content-type": sent!.contentType } }).formData();
  const file = form.get("file") as File;
  assert.equal(file.name, "photo (1).png");
});
