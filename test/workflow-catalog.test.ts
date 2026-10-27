import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWorkflowList,
  modelIdFromTemplateId,
  toWorkflowTemplate,
} from "../src/services/workflow-catalog.js";

const item = {
  templateId: "wf-ugc-ad",
  name: "Ugc ads",
  modality: "video",
  categoryCode: "lifestyle",
  i18n: { zh: { name: "UGC 广告", intro: "描述这条广告…" } },
};

const detail = {
  templateId: "wf-ugc-ad",
  model: "atlascloud/studio/ugc-ad",
  intro: "Describe this ad",
  isDraft: false,
  showcaseUrl: "https://static.example/ugc.mp4",
  slots: [
    { key: "product_image", type: "image", required: true, placeholder: { en: "Product shot", zh: "商品图" } },
    { key: "model_image", type: "portrait", required: false, multiple: true },
    { key: "user_prompt", type: "text", required: true },
  ],
  params: [
    { key: "ad_type", label: { en: "Ad type" }, options: [{ value: "a" }, { value: "b" }, { value: "c" }] },
    { key: "duration" },
  ],
};

test("工作流目录：列表项和详情合成一条，必填素材和可选项分开", () => {
  const t = toWorkflowTemplate(item, detail);
  assert.ok(t);
  assert.equal(t.model, "atlascloud/studio/ugc-ad");
  assert.equal(t.nameZh, "UGC 广告");
  assert.deepEqual(t.requiredInputs.map((i) => i.key), ["product_image", "user_prompt"]);
  assert.deepEqual(t.optionalInputs.map((i) => i.key), ["model_image"]);
  assert.deepEqual(t.options, [{ key: "ad_type", label: "Ad type", choices: 3 }, { key: "duration" }]);
});

test("工作流目录：详情拿不到时按模板 ID 推出模型 ID；草稿不列", () => {
  assert.equal(modelIdFromTemplateId("wf-trend-remix"), "atlascloud/studio/trend-remix");
  assert.equal(modelIdFromTemplateId("studio-product-visuals"), "atlascloud/studio/product-visuals");
  assert.equal(modelIdFromTemplateId("other"), undefined);
  assert.equal(toWorkflowTemplate(item, null)?.model, "atlascloud/studio/ugc-ad");
  assert.equal(toWorkflowTemplate(item, { ...detail, isDraft: true }), null);
  assert.equal(toWorkflowTemplate({ ...item, templateId: "x" }, null), null);
});

test("工作流目录：文字列表写出模型 ID、中文名、必填素材和怎么跑", () => {
  const t = toWorkflowTemplate(item, detail);
  assert.ok(t);
  const text = formatWorkflowList([t], 8, 0);
  assert.match(text, /8 of 8|1 of 8/);
  assert.match(text, /Ugc ads \(UGC 广告\)/);
  assert.match(text, /`atlascloud\/studio\/ugc-ad`/);
  assert.match(text, /Required: product_image \(image\), user_prompt \(text\)/);
  assert.match(text, /ad_type \(3 choices\)/);
  assert.match(text, /Optional inputs: model_image \(portrait, list\)/);
  assert.match(text, /atlas_generate_video/);
});

test("工作流目录：分类和模态相同时只写一遍", () => {
  const t = toWorkflowTemplate({ ...item, categoryCode: "video" }, detail);
  assert.ok(t);
  assert.equal(t.category, undefined);
  assert.match(formatWorkflowList([t], 1, 0), /· video\n/);
});
