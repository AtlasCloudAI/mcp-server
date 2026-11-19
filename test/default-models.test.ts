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
  routeDefaultParams,
} from "../src/services/default-models.js";
import { fillPreferredDefaults } from "../src/utils/schema-validator.js";

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
  model("bytedance/seedream-v5.0-flash/text-to-image", "Image"),
  model("google/nano-banana-2/text-to-image", "Image"),
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
  assert.equal(pickDefaultModel(CATALOG, "Image", "text-to-image")?.model, "bytedance/seedream-v5.0-pro/text-to-image");
  assert.equal(pickDefaultModel(CATALOG, "Image", "edit")?.model, "bytedance/seedream-v5.0-pro/edit");
});

test("默认路由：前面的下线了就顺延，只顺延缺的那个变体", () => {
  const noSeedanceT2v = without("bytedance/seedance-2.5/text-to-video");
  assert.equal(pickDefaultModel(noSeedanceT2v, "Video", "text-to-video")?.model, "kwaivgi/kling-v4.0/text-to-video");
  assert.equal(pickDefaultModel(noSeedanceT2v, "Video", "image-to-video")?.model, "bytedance/seedance-2.5/image-to-video");

  const onlyLast = CATALOG.filter((m) => m.model.startsWith("bytedance/seedance-2.0/") || m.type === "Image");
  assert.equal(pickDefaultModel(onlyLast, "Video", "text-to-video")?.model, "bytedance/seedance-2.0/text-to-video");

  // 别的档位（Flash）在目录里也不顶替 Pro，直接顺延到下一个家族。
  const noPro = without("bytedance/seedream-v5.0-pro/edit");
  assert.equal(pickDefaultModel(noPro, "Image", "edit")?.model, "openai/gpt-image-2.5-sunburst/edit");
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
  assert.ok(image.includes("bytedance/seedream-v5.0-pro/text-to-image"));
  assert.ok(image.includes("bytedance/seedream-v5.0-pro/edit"));
  assert.match(image, /GPT Image 2\.5 Sunburst .*Nano Banana 2\.1 \(google\/nano-banana-2\.1\/…\).*GPT Image 2 \(openai\/gpt-image-2\/…\)/);
  assert.match(video, /720p, 5 seconds and one video, with 16:9 for text-to-video/);
  assert.match(image, /Seedream 5\.0 Pro 2048\*2048/);
  assert.doesNotMatch(image, /\b(Do not|must|MUST)\b/);

  assert.match(
    defaultRouteSummary(),
    /video: Seedance 2\.5 → Kling 4\.0 → Wan 3\.0 → Seedance 2\.0; image: Seedream 5\.0 Pro → GPT Image 2\.5 Sunburst → Nano Banana 2\.1 → GPT Image 2/
  );
});

test("默认参数：按产品 10-29 的表，文生视频 16:9、图生视频不填比例", () => {
  assert.deepEqual(routeDefaultParams("bytedance/seedance-2.5/text-to-video"), { resolution: "720p", duration: 5, ratio: "16:9" });
  assert.deepEqual(routeDefaultParams("kwaivgi/kling-v4.0/text-to-video"), { resolution: "720p", duration: 5, aspect_ratio: "16:9" });
  assert.deepEqual(routeDefaultParams("alibaba/wan-3.0/image-to-video"), { resolution: "720p", duration: 5 });
  assert.deepEqual(routeDefaultParams("bytedance/seedance-2.0/reference-to-video"), { resolution: "720p", duration: 5 });
  assert.deepEqual(routeDefaultParams("bytedance/seedream-v5.0-pro/edit"), { size: "2048*2048" });
  assert.deepEqual(routeDefaultParams("openai/gpt-image-2.5-sunburst/text-to-image"), { size: "1024x1024", quality: "medium", n: 1 });
  assert.deepEqual(routeDefaultParams("google/nano-banana-2.1/text-to-image"), { resolution: "1k", aspect_ratio: "1:1" });
  assert.deepEqual(routeDefaultParams("google/nano-banana-2.1/edit"), { resolution: "1k" });
  assert.deepEqual(routeDefaultParams("openai/gpt-image-2/edit"), { size: "1024x1024", quality: "medium" });
  // 不在路由里的模型（包括同家族的别的档位）不动，照旧用上游默认。
  assert.deepEqual(routeDefaultParams("alibaba/wan-3.0-prime/text-to-video"), {});
  assert.deepEqual(routeDefaultParams("bytedance/seedream-v5.0-flash/text-to-image"), {});
});

// Kling 4.0 文生视频线上 schema 的节选：上游默认 1080p。
const KLING_T2V_SCHEMA = {
  components: {
    schemas: {
      Input: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          duration: { type: "integer", default: 5, minimum: 3, maximum: 30 },
          aspect_ratio: { type: "string", enum: ["16:9", "9:16", "1:1", "21:9"], default: "16:9" },
          resolution: { type: "string", enum: ["720p", "1080p", "1080p-esr"], default: "1080p" },
        },
      },
    },
  },
};

test("默认参数只补调用方没给的，且只补 schema 认的值", () => {
  const preferred = routeDefaultParams("kwaivgi/kling-v4.0/text-to-video");
  assert.deepEqual(fillPreferredDefaults(KLING_T2V_SCHEMA, { prompt: "a cat" }, preferred), {
    prompt: "a cat",
    resolution: "720p",
    duration: 5,
    aspect_ratio: "16:9",
  });
  // 用户要的值优先。
  assert.deepEqual(
    fillPreferredDefaults(KLING_T2V_SCHEMA, { prompt: "a cat", resolution: "1080p", duration: 10 }, preferred),
    { prompt: "a cat", resolution: "1080p", duration: 10, aspect_ratio: "16:9" }
  );
  // schema 没有的字段、枚举里没有的值都不填，免得把能过的请求弄成校验失败。
  assert.deepEqual(
    fillPreferredDefaults(KLING_T2V_SCHEMA, { prompt: "a cat" }, { ratio: "16:9", resolution: "480p" }),
    { prompt: "a cat" }
  );
  assert.deepEqual(fillPreferredDefaults(null, { prompt: "a cat" }, preferred), { prompt: "a cat" });
});
