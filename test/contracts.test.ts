import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasCloudServer } from "../src/server.js";
import {
  ALL_TOOL_NAMES,
  TOOL_POLICIES,
} from "../src/tool-policy.js";
import {
  fillRequiredDefaults,
  validateModelParams,
} from "../src/utils/schema-validator.js";
import {
  modelInfoOutputSchema,
  predictionIdSchema,
} from "../src/tool-contracts.js";
import {
  modelsResponseSchema,
  predictionResponseSchema,
} from "../src/response-schemas.js";
import { buildQuickGenerateParams } from "../src/tools/quick-generate.js";
import { exactModelById } from "../src/services/doc-fetcher.js";
import type { Model } from "../src/types.js";

test("stdio exposes all 14 tools with exact annotations and output schemas", async () => {
  const server = createAtlasCloudServer("stdio");
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const packageManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { version: string };
    assert.equal(client.getServerVersion()?.version, packageManifest.version);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 14);
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...ALL_TOOL_NAMES].sort()
    );
    for (const tool of listed.tools) {
      const name = tool.name as keyof typeof TOOL_POLICIES;
      assert.ok(tool.outputSchema, `${name} must declare outputSchema`);
      assert.deepEqual(tool.annotations, TOOL_POLICIES[name].annotations);
      if (!TOOL_POLICIES[name].annotations.readOnlyHint) {
        assert.ok(
          Array.isArray(tool.inputSchema.required) &&
            tool.inputSchema.required.includes("idempotency_key"),
          `${name} must require idempotency_key`
        );
      }
    }
    for (const toolName of [
      "atlas_generate_image",
      "atlas_generate_video",
      "atlas_generate_audio",
      "atlas_transcribe_audio",
      "atlas_chat",
      "atlas_quick_generate",
    ]) {
      const tool = listed.tools.find((candidate) => candidate.name === toolName);
      assert.ok(tool, `${toolName} must be listed`);
      const inputProperties = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      assert.ok(
        inputProperties.confirmation_token,
        `${toolName} must expose the mandatory two-call confirmation token`
      );
      assert.equal(
        tool.inputSchema.required?.includes("confirmation_token"),
        false,
        `${toolName} first quote-only call must be possible without a token`
      );
    }
    for (const toolName of ["atlas_list_models", "atlas_search_docs"]) {
      const tool = listed.tools.find((candidate) => candidate.name === toolName);
      assert.ok(tool, `${toolName} must be listed`);
      const inputProperties = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      assert.equal(inputProperties.limit.default, 50);
      assert.equal(inputProperties.limit.maximum, 100);
      assert.equal(inputProperties.offset.default, 0);
      const outputRequired = tool.outputSchema?.required;
      assert.ok(Array.isArray(outputRequired));
      for (const field of ["count", "total_count", "offset", "has_more", "models"]) {
        assert.ok(outputRequired.includes(field), `${toolName} output must require ${field}`);
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("OpenAI review annotations distinguish first-party reads from billable writes", () => {
  const billableWrites = new Set([
    "atlas_generate_image",
    "atlas_generate_video",
    "atlas_generate_audio",
    "atlas_transcribe_audio",
    "atlas_chat",
    "atlas_quick_generate",
  ]);
  for (const [name, policy] of Object.entries(TOOL_POLICIES)) {
    if (billableWrites.has(name)) {
      assert.deepEqual(policy.annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    } else if (name === "atlas_upload_media") {
      assert.deepEqual(policy.annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    } else {
      assert.deepEqual(policy.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  }
});

const modelSchema: Record<string, unknown> = {
  components: {
    schemas: {
      Input: {
        type: "object",
        properties: {
          model: { type: "string" },
          prompt: { type: "string", minLength: 2 },
          steps: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          tags: { type: "array", items: { type: "string" }, maxItems: 2 },
        },
        required: ["model", "prompt", "steps"],
      },
    },
  },
};

test("AJV validates defaults, nested array types, ranges and unknown fields", () => {
  const completed = fillRequiredDefaults(modelSchema, { prompt: "hello" });
  assert.deepEqual(completed, { prompt: "hello", steps: 20 });
  assert.equal(
    validateModelParams(modelSchema, "provider/current-model", completed).ok,
    true
  );

  const invalid = validateModelParams(modelSchema, "provider/current-model", {
    prompt: "x",
    steps: 99,
    tags: ["ok", 2],
    unexpected: true,
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes("unexpected")));
  assert.ok(invalid.errors.some((error) => error.includes("prompt")));
  assert.ok(invalid.errors.some((error) => error.includes("steps")));
  assert.ok(invalid.errors.some((error) => error.includes("tags.1")));
});

test("quick generation cannot let extra_params override the selected model", () => {
  const params = buildQuickGenerateParams(
    modelSchema,
    "provider/current-model",
    "hello",
    undefined,
    undefined,
    { model: "attacker/override", steps: 25 }
  );
  assert.equal(params.model, "provider/current-model");
  assert.equal(params.prompt, "hello");
  assert.equal(params.steps, 25);
});

test("billable model selection accepts only the exact catalog ID", () => {
  const model: Model = {
    uuid: "model-1",
    model: "provider/current-model",
    type: "Image",
    displayName: "Current Model",
    profile: "test",
    avatar: "",
    readme: "",
    tags: [],
  };
  assert.equal(exactModelById([model], "provider/current-model"), model);
  assert.equal(exactModelById([model], "Current Model"), undefined);
  assert.equal(exactModelById([model], "provider current model"), undefined);
});

test("model info exposes machine-readable request pricing", () => {
  const parsed = modelInfoOutputSchema.pricing.safeParse({
    discount: "80",
    actual: { base_price: "0.004" },
    origin: { base_price: "0.005" },
  });
  assert.equal(parsed.success, true);
  assert.equal(
    modelInfoOutputSchema.pricing.safeParse({ actual: { base_price: 0.004 } }).success,
    false
  );
});

test("prediction IDs are bounded to one URL-safe path segment", () => {
  for (const value of [
    "pred_abc123",
    "123e4567-e89b-12d3-a456-426614174000",
    "prediction.id~v2",
  ]) {
    assert.equal(predictionIdSchema.safeParse(value).success, true);
  }
  for (const value of ["../models", "id/child", "id?admin=true", "", "a".repeat(257)]) {
    assert.equal(predictionIdSchema.safeParse(value).success, false);
  }
});

test("prediction responses normalize current direct and legacy wrapped shapes", () => {
  assert.deepEqual(
    predictionResponseSchema.parse({
      id: "prediction-direct",
      status: "processing",
      outputs: [],
    }),
    {
      code: 200,
      data: {
        id: "prediction-direct",
        status: "processing",
        outputs: [],
      },
    }
  );
  assert.deepEqual(
    predictionResponseSchema.parse({
      code: 200,
      data: {
        request_id: "prediction-request-alias",
        status: "queued",
        output: null,
        error: null,
        metrics: null,
      },
    }),
    {
      code: 200,
      data: {
        id: "prediction-request-alias",
        status: "queued",
        output: null,
        error: null,
        metrics: null,
      },
    }
  );
  assert.deepEqual(
    predictionResponseSchema.parse({
      prediction_id: "prediction-direct-alias",
      status: "starting",
    }),
    {
      code: 200,
      data: {
        id: "prediction-direct-alias",
        status: "starting",
      },
    }
  );
  assert.deepEqual(
    predictionResponseSchema.parse({
      code: 200,
      data: {
        prediction_id: "prediction-wrapped-alias",
        status: "processing",
      },
    }),
    {
      code: 200,
      data: {
        id: "prediction-wrapped-alias",
        status: "processing",
      },
    }
  );
  assert.deepEqual(
    predictionResponseSchema.parse({
      code: "200",
      data: { id: "prediction-wrapped", status: "completed" },
    }),
    {
      code: "200",
      data: { id: "prediction-wrapped", status: "completed" },
    }
  );
  assert.equal(predictionResponseSchema.safeParse({ id: "../invalid" }).success, false);
  assert.equal(
    predictionResponseSchema.safeParse({
      id: "prediction-one",
      prediction_id: "prediction-two",
    }).success,
    false
  );
  assert.equal(
    predictionResponseSchema.safeParse({
      id: "prediction-one",
      request_id: "prediction-two",
    }).success,
    false
  );
});

test("live catalog null categories normalize to an absent optional field", () => {
  const parsed = modelsResponseSchema.parse({
    code: 200,
    data: [{
      uuid: "model-uuid",
      model: "provider/model",
      type: "Image",
      displayName: "Model",
      categories: null,
    }],
  });
  assert.equal(parsed.data[0].categories, undefined);
});
