// 提交前把资产库素材的临时地址换成 assetd:// 引用（src/services/library-references.ts）。
import assert from "node:assert/strict";
import test from "node:test";
import { rememberAssetNames, rememberAssetUrls } from "../src/services/media-names.js";
import { withAssetLibraryReferences } from "../src/services/library-references.js";
import { InMemoryUploadTicketStore } from "../src/services/upload-ticket-store.js";

const signed = (id: string) =>
  `https://atlas-asset-dev.oss-us-west-1.aliyuncs.com/assetd/test/30d/${id}/source?x-oss-signature=abc&x-oss-expires=900`;

test("资产库的临时地址换成 assetd://，不知道文件名的也换；别的地址原样", async () => {
  const named = signed("asset_1111aaaa");
  const unnamed = signed("asset_2222bbbb");
  // 一个搜索过（知道文件名），一个是模型直接写 asset://asset_… 换出来的（没有名字）
  await rememberAssetNames([{ asset_id: "asset_1111aaaa", name: "apple.png" }]);
  await rememberAssetUrls([
    { asset_id: "asset_1111aaaa", url: named, mime_type: "image/png" },
    { asset_id: "asset_2222bbbb", url: unnamed, mime_type: "image/png" },
  ]);
  const external = "https://example.com/cat.png";
  const body = {
    model: "bytedance/seedance-2.0-mini/reference-to-video",
    prompt: "keep https://example.com/cat.png in the prompt as text",
    image: named,
    reference_images: [unnamed, external],
    nested: { frames: [{ url: named }] },
    duration: 5,
  };
  const out = await withAssetLibraryReferences(body);
  assert.equal(out.image, "assetd://asset_1111aaaa");
  assert.deepEqual(out.reference_images, ["assetd://asset_2222bbbb", external]);
  assert.deepEqual(out.nested, { frames: [{ url: "assetd://asset_1111aaaa" }] });
  assert.equal(out.prompt, body.prompt);
  assert.equal(out.duration, 5);
  // 不改调用方手里的那份：报价、确认核对还用原地址
  assert.equal(body.image, named);
});

test("没有认得出的地址时原样返回同一个对象；编号不像资产编号的不换", async () => {
  const store = new InMemoryUploadTicketStore();
  const body = { prompt: "x", image: "https://example.com/a.png" };
  assert.equal(await withAssetLibraryReferences(body, store), body);
  assert.deepEqual(await withAssetLibraryReferences({}, store), {});
});

test("编号格式不对的不换（网关只认 asset_ 开头、64 个字符以内）", async () => {
  const odd = signed("weird");
  await rememberAssetUrls([{ asset_id: "not-an-asset-id", url: odd }]);
  const out = await withAssetLibraryReferences({ image: odd });
  assert.equal(out.image, odd);
});
