import assert from "node:assert/strict";
import test from "node:test";
import { validateModelParams } from "../src/utils/schema-validator.js";

// openai/gpt-image-2/text-to-image 的真实形状：required 含 model，
// 但 properties 只列业务参数。校验时我们会把 model 注入（validateModelParams
// 内部），若再把它判成「不被接受的额外属性」，这个模型的生成就完全发不出去——
// 实测过一次：报错说 model 不被接受，而它恰恰是 schema 自己要求的必填字段。
const gptImage2Shape = {
  components: {
    schemas: {
      Input: {
        type: "object",
        required: ["model", "prompt"],
        properties: {
          prompt: { type: "string" },
          size: { type: "string" },
          quality: { type: "string" },
        },
      },
    },
  },
};

test("required 里提到但 properties 未定义的字段不被当成额外属性拒绝", () => {
  const result = validateModelParams(gptImage2Shape, "openai/gpt-image-2/text-to-image", {
    prompt: "a red iron man on a rooftop",
  });
  assert.equal(
    result.ok,
    true,
    `注入的 model 必须被接受，实际报错: ${result.errors.join("; ")}`
  );
});

test("补定义只针对 required 提到的字段，真正的拼写错误照样拦住", () => {
  const result = validateModelParams(gptImage2Shape, "openai/gpt-image-2/text-to-image", {
    prompt: "x",
    promt: "typo",
  });
  assert.equal(result.ok, false, "未声明且不在 required 里的参数应当被拒绝");
  assert.ok(
    result.errors.join(" ").includes("promt"),
    `报错应点出拼错的参数名，实际: ${result.errors.join("; ")}`
  );
});

test("required 缺失仍然报缺参数", () => {
  const result = validateModelParams(gptImage2Shape, "openai/gpt-image-2/text-to-image", {});
  assert.equal(result.ok, false, "缺 prompt 应当被拒绝");
  assert.ok(
    result.errors.join(" ").toLowerCase().includes("prompt"),
    `报错应点出缺失的 prompt，实际: ${result.errors.join("; ")}`
  );
});

// atlascloud/studio/a-plus-content 的真实形状：visual_type 是单值 enum + 自定义的 x-multiple，
// 描述写「可多选——用英文逗号分隔」。网页表单多选就提交逗号串，上游按条数计价；
// 校验器之前把整串当一个枚举值比，"hero, feature" 一律被拒。
const aPlusShape = {
  components: {
    schemas: {
      Input: {
        type: "object",
        required: ["model", "visual_type"],
        properties: {
          model: { type: "string", default: "atlascloud/studio/a-plus-content" },
          product_image: { type: "string" },
          visual_type: {
            type: "string",
            enum: ["hero", "feature", "scene", "detail", "spec", "comparison", "brand_story"],
            default: "hero",
            description: "内容模块。可多选——用英文逗号分隔可一次出多张，例如 hero, feature, spec。",
            "x-multiple": true,
          },
          ratio: { type: "string", enum: ["1:1", "3:4"] },
        },
      },
    },
  },
};
const aPlus = (params: Record<string, unknown>) =>
  validateModelParams(aPlusShape, "atlascloud/studio/a-plus-content", {
    product_image: "https://example.com/p.png",
    ...params,
  });

test("x-multiple 字段接受逗号连接的多个枚举值（含空格）", () => {
  for (const visual_type of ["hero", "hero,feature", "hero, feature, spec", " scene ,detail "]) {
    const result = aPlus({ visual_type });
    assert.equal(result.ok, true, `${visual_type} 应当通过，实际报错: ${result.errors.join("; ")}`);
  }
});

test("x-multiple 字段里有一项不在枚举中时拒绝，并点出是哪一项", () => {
  const result = aPlus({ visual_type: "hero, banner" });
  assert.equal(result.ok, false);
  const text = result.errors.join(" ");
  assert.ok(text.includes('"banner"'), `报错应点出非法项 banner，实际: ${text}`);
  assert.ok(!text.includes('"hero" is not'), `合法项不该被点名，实际: ${text}`);
});

test("x-multiple 字段的空项（多余逗号）被拒绝", () => {
  const result = aPlus({ visual_type: "hero,,feature" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.join(" ").includes("empty item"), `实际: ${result.errors.join("; ")}`);
});

test("x-multiple 字段的类型约束仍然生效", () => {
  const result = aPlus({ visual_type: ["hero", "feature"] });
  assert.equal(result.ok, false, "数组不是上游接受的形状，应当被拒绝");
});

test("没有 x-multiple 的枚举字段仍然只认单个值", () => {
  const result = aPlus({ ratio: "1:1, 3:4" });
  assert.equal(result.ok, false, "普通 enum 不应因为多选改动而放宽");
});

test("参数摘要对多选字段说明可以逗号多选", () => {
  const result = aPlus({ visual_type: "nope" });
  assert.ok(
    result.summary.includes("one or more of") && result.summary.includes("comma-separated"),
    `摘要应提示多选，实际: ${result.summary}`
  );
});
