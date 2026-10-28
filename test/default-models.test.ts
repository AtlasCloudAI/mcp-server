import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "../src/types.js";
import {
  DEFAULT_MODEL_ROUTES,
  defaultRouteGuidance,
  defaultRouteSummary,
  defaultRouteTask,
  formatDefaultRoute,
  pickDefaultModel,
} from "../src/services/default-models.js";

function model(id: string, type: string): Model {
  return {
    uuid: id,
    model: id,
    type,
    displayName: id,
    profile: "",
    avatar: "",
    readme: "",
    tags: [],
  };
}

// 生产目录 10-28 实有的路由模型，外加两个干扰项：同名家族的其他档位，以及更便宜的老模型。
const CATALOG: Model[] = [
  ...DEFAULT_MODEL_ROUTES.Video.flatMap((entry) =>
    Object.values(entry.models).map((id) => model(id, "Video"))
  ),
  ...DEFAULT_MODEL_ROUTES.Image.flatMap((entry) =>
    Object.values(entry.models).map((id) => model(id, "Image"))
  ),
  model("bytedance/seedance-2.0-mini/text-to-video", "Video"),
  model("bytedance/seedream-v5.0-pro/text-to-image", "Image"),
];

const without = (...ids: string[]) => CATALOG.filter((m) => !ids.includes(m.model));

test("默认路由：按输入选变体", () => {
  assert.equal(defaultRouteTask("Video", { hasImage: false }), "text-to-video");
  assert.equal(defaultRouteTask("Video", { hasImage: true }), "image-to-video");
  assert.equal(defaultRouteTask("Image", { hasImage: false }), "text-to-image");
  assert.equal(defaultRouteTask("Image", { hasImage: true }), "edit");
});

test("默认路由：取第一个在目录里的", () => {
  assert.equal(pickDefaultModel(CATALOG, "Video", "text-to-video")?.model, "bytedance/seedance-2.5/text-to-video");
  assert.equal(pickDefaultModel(CATALOG, "Video", "image-to-video")?.model, "bytedance/seedance-2.5/image-to-video");
  assert.equal(pickDefaultModel(CATALOG, "Video", "reference-to-video")?.model, "bytedance/seedance-2.5/reference-to-video");
  assert.equal(pickDefaultModel(CATALOG, "Image", "text-to-image")?.model, "bytedance/seedream-v5.0-flash/text-to-image");
  assert.equal(pickDefaultModel(CATALOG, "Image", "edit")?.model, "bytedance/seedream-v5.0-flash/edit");
});

test("默认路由：前面的下线了就顺延，只顺延缺的那个变体", () => {
  const noSeedanceT2v = without("bytedance/seedance-2.5/text-to-video");
  assert.equal(pickDefaultModel(noSeedanceT2v, "Video", "text-to-video")?.model, "kwaivgi/kling-v4.0/text-to-video");
  assert.equal(pickDefaultModel(noSeedanceT2v, "Video", "image-to-video")?.model, "bytedance/seedance-2.5/image-to-video");

  const onlyLast = CATALOG.filter((m) => m.model.startsWith("bytedance/seedance-2.0/") || m.type === "Image");
  assert.equal(pickDefaultModel(onlyLast, "Video", "text-to-video")?.model, "bytedance/seedance-2.0/text-to-video");

  const noFlash = without("bytedance/seedream-v5.0-flash/edit");
  assert.equal(pickDefaultModel(noFlash, "Image", "edit")?.model, "openai/gpt-image-2.5-sunburst/edit");
});

test("默认路由：整条都不在目录里就不选，也不拿别的家族或类型凑数", () => {
  const routed = new Set(DEFAULT_MODEL_ROUTES.Video.flatMap((entry) => Object.values(entry.models)));
  const noRoute = CATALOG.filter((m) => !routed.has(m.model));
  assert.equal(pickDefaultModel(noRoute, "Video", "text-to-video"), undefined);
  // 同一个 ID 被标成别的类型，不算。
  const mislabelled = [model("bytedance/seedance-2.5/text-to-video", "Image")];
  assert.equal(pickDefaultModel(mislabelled, "Video", "text-to-video"), undefined);
});

test("模型列表顶部只列目录里真有的默认模型", () => {
  const text = formatDefaultRoute(without("kwaivgi/kling-v4.0/text-to-video"), "Video");
  assert.ok(text);
  assert.match(text, /^\*\*Default video models\*\*/);
  assert.match(text, /1\. Seedance 2\.5: `bytedance\/seedance-2\.5\/text-to-video`/);
  assert.match(text, /2\. Kling 4\.0: `kwaivgi\/kling-v4\.0\/image-to-video`/);
  assert.doesNotMatch(text, /kling-v4\.0\/text-to-video/);
  assert.match(text, /4\. Seedance 2\.0/);
  assert.equal(formatDefaultRoute([model("x/y/text-to-video", "Video")], "Video"), null);
});

test("工具描述和服务器说明写出完整的默认路由", () => {
  const video = defaultRouteGuidance("Video");
  for (const id of Object.values(DEFAULT_MODEL_ROUTES.Video[0]!.models)) assert.ok(video.includes(id), id);
  assert.match(video, /Kling 4\.0 \(kwaivgi\/kling-v4\.0\/…\), then Wan 3\.0 \(alibaba\/wan-3\.0\/…\), then Seedance 2\.0/);
  assert.match(video, /the default is Seedance 2\.5/);
  assert.doesNotMatch(video, /\b(Do not|must|MUST)\b/);

  const image = defaultRouteGuidance("Image");
  assert.ok(image.includes("bytedance/seedream-v5.0-flash/text-to-image"));
  assert.ok(image.includes("bytedance/seedream-v5.0-flash/edit"));
  assert.match(image, /GPT Image 2\.5 Sunburst .*Nano Banana 2 .*GPT Image 2 \(openai\/gpt-image-2\/…\)/);

  assert.match(
    defaultRouteSummary(),
    /video: Seedance 2\.5 → Kling 4\.0 → Wan 3\.0 → Seedance 2\.0; image: Seedream v5\.0 Flash → GPT Image 2\.5 Sunburst → Nano Banana 2 → GPT Image 2/
  );
});
