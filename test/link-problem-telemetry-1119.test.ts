import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { prepareWithSchema } from "../src/services/generation.js";
import { inputLinkProblemCause, inputLinkProblemParam } from "../src/services/input-link-check.js";
import { runWithRequestContext } from "../src/services/request-context.js";
import { ToolCallTelemetry } from "../src/services/tool-call-telemetry.js";
import { classifyToolError } from "../src/utils/error-handler.js";
import type { Model } from "../src/types.js";

// 11-19 生产：参考图链接检查没通过时没记错误码，埋点落到兜底的 upstream_failure（9 次），
// 看板上像是服务出了故障。现在记成 invalid_param + 字段名 + 原因枚举。

const EDIT_SCHEMA = {
  components: {
    schemas: {
      Input: {
        type: "object",
        required: ["prompt", "images"],
        properties: {
          model: { type: "string" },
          prompt: { type: "string" },
          images: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

test("a rejected input link is reported as invalid_param with the field and a fixed cause", async () => {
  const previous = process.env.MCP_INPUT_LINK_CHECK;
  delete process.env.MCP_INPUT_LINK_CHECK;
  try {
    const call = new ToolCallTelemetry("atlas_generate_image", 0);
    const model = { model: "bytedance/seedream-v5.0-lite/edit", type: "Image", displayName: "Seedream" } as unknown as Model;
    const out = await runWithRequestContext(
      { authInfo: {} as AuthInfo, subject: "test", atlasApiKey: "k", toolCall: call },
      () =>
        prepareWithSchema(
          model,
          EDIT_SCHEMA,
          { prompt: "watercolor", images: ["http://127.0.0.1/private.png"] },
          { expectedType: "Image", endpoint: "/model/generateImage", typeLabel: "image" }
        )
    );
    assert.equal(out.ok, false);
    call.observeResponse({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "x" }] } });
    const props = call.properties({}, 200, { now: 1 });
    assert.equal(props.error_code, "invalid_param");
    assert.equal(props.error_category, "invalid_request");
    assert.equal(props.error_param, "images");
    assert.equal(props.error_cause, "private_address");
    // 链接本身不进埋点
    assert.equal(JSON.stringify(props).includes("127.0.0.1"), false);
  } finally {
    if (previous === undefined) delete process.env.MCP_INPUT_LINK_CHECK;
    else process.env.MCP_INPUT_LINK_CHECK = previous;
  }
});

test("every input-link reason maps to a fixed cause, never other", () => {
  const reasons: Array<[string, string]> = [
    ["it is not publicly accessible (HTTP 403)", "not_public"],
    ["the file is not there anymore (HTTP 404)", "not_found"],
    ["it could not be opened (HTTP 500)", "unreachable"],
    ["it could not be opened", "unreachable"],
    ["it did not respond in time", "timeout"],
    ["its host name could not be found", "unresolved_host"],
    ["it points to a private or local address, which Atlas cannot reach", "private_address"],
    ["it is a web page (text/html), not a media file", "web_page"],
    ["it is an image file, but video needs a video", "wrong_media_type"],
    ["it redirects too many times", "too_many_redirects"],
    ["only http and https links can be used", "bad_scheme"],
    ["it is a file path, not a link; upload the file first", "local_path"],
    ["it is not a valid link", "malformed_link"],
    ["it is not a complete link; write it as https://… with two forward slashes", "malformed_link"],
    ["it has an invisible character (a control character, no-break space or zero-width space) at its start or end", "malformed_link"],
    ["it contains a backslash, which link parsers read differently", "malformed_link"],
    ["the inputs are nested more than 8 levels deep, which can't be checked; flatten them", "too_many_links"],
    ["the request has more than 64 input links, which can't all be checked; split it into smaller requests", "too_many_links"],
  ];
  for (const [reason, cause] of reasons) assert.equal(inputLinkProblemCause(reason), cause, reason);
  assert.equal(inputLinkProblemCause("something new"), "other");
});

test("error_param from a link problem is only a top-level field name", () => {
  assert.equal(inputLinkProblemParam("images"), "images");
  assert.equal(inputLinkProblemParam("reference.image_url"), "reference");
  assert.equal(inputLinkProblemParam("params"), "params");
  assert.equal(inputLinkProblemParam("https://evil/x"), undefined);
  assert.equal(inputLinkProblemParam("有空格 的键"), undefined);
});

test("quote and submit stages are told apart from schema", () => {
  const call = new ToolCallTelemetry("atlas_generate_image", 0);
  call.annotate({ stage: "schema" });
  call.annotate({ stage: "quote" });
  call.recordError({ code: "upstream_failure" });
  call.observeResponse({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } });
  assert.equal(call.properties({}, 200, { now: 1 }).failure_stage, "quote");
});

test("an unrecognised exception carries only its class name as the cause", () => {
  assert.deepEqual(classifyToolError(new SyntaxError("Unexpected token < in JSON at https://x/secret")), {
    code: "upstream_failure",
    cause: "SyntaxError",
  });
  // 普通 Error 没信息量，不带 cause；类名不像标识符的也不带
  assert.deepEqual(classifyToolError(new Error("weird")), { code: "upstream_failure" });
  class Odd extends Error {}
  Object.defineProperty(Odd.prototype, "name", { value: "has space" });
  assert.deepEqual(classifyToolError(new Odd("x")), { code: "upstream_failure" });
});
