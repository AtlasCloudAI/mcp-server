// 11-18 ChatGPT regression H10: Reuse settings on a workflow job said its two Asset Library inputs
// had expired, although both assets still existed. The URL → asset ID record had aged out (7 days);
// the asset ID is in the signed URL's path all along.
import assert from "node:assert/strict";
import test from "node:test";
import { reusableInputs } from "../src/apps/history-card.js";
import { withAssetLibraryReferences } from "../src/services/library-references.js";
import { assetIdFromLibraryUrl } from "../src/services/media-names.js";
import type { HistoryItem } from "../src/types.js";

const signed = (id: string, file = "original/photo.jpg") =>
  `https://atlas-asset-dev.oss-us-west-1.aliyuncs.com/assetd/test/30d/${id}/${file}` +
  "?x-oss-credential=LTAI%2F20261118&x-oss-date=20261118T111455Z&x-oss-expires=2705&x-oss-signature=f359";

test("asset ID is read from an Asset Library URL path", () => {
  assert.equal(assetIdFromLibraryUrl(signed("asset_0e3519c46209d5d8a0bf181104cb5f35")), "asset_0e3519c46209d5d8a0bf181104cb5f35");
  assert.equal(assetIdFromLibraryUrl(signed("asset_26791a187e1cfe4604627c8595d69b18", "thumbnail.png")), "asset_26791a187e1cfe4604627c8595d69b18");
  // Not an /assetd/ path, plain http, or a host that is not ours: no ID.
  assert.equal(assetIdFromLibraryUrl("https://atlas-asset.oss-us-west-1.aliyuncs.com/a/2?x-oss-signature=ghi"), undefined);
  assert.equal(assetIdFromLibraryUrl(signed("asset_abc").replace("https:", "http:")), undefined);
  assert.equal(assetIdFromLibraryUrl("https://evil.example/assetd/test/30d/asset_abc/x.png"), undefined);
  assert.equal(assetIdFromLibraryUrl("not a url"), undefined);
});

test("H10: Reuse settings keeps library inputs whose URL record has expired", async () => {
  const a = "asset_6ed1681600000000000000000000000a";
  const b = "asset_b71abafb00000000000000000000000b";
  const item = {
    ID: "e7ab4155",
    model: "atlascloud/studio/image-clone",
    status: "completed",
    requestBody: JSON.stringify({ reference_image: signed(a), product_images: [signed(b)] }),
  } as unknown as HistoryItem;
  const { inputs, unavailable } = await reusableInputs(item);
  assert.equal(unavailable, 0);
  assert.deepEqual(
    inputs.map((input) => input.ref).sort(),
    [`asset://${a}`, `asset://${b}`].sort()
  );
});

test("H10: submission swaps an unremembered library URL for its assetd:// reference", async () => {
  const id = "asset_0c9e745b5f221158aa3d24de4d7ba7a8";
  const body = await withAssetLibraryReferences({ model: "m", images: [signed(id)], prompt: "x" });
  assert.deepEqual(body.images, [`assetd://${id}`]);
});
