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
