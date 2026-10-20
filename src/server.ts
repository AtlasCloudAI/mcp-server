import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./tools/account.js";
import { registerAudioTools } from "./tools/audio.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerImageTools } from "./tools/image.js";
import { registerLLMTools } from "./tools/llm.js";
import { registerModelTools } from "./tools/models.js";
import { registerPredictionTools } from "./tools/predictions.js";
import { registerQuickGenerateTools } from "./tools/quick-generate.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerUploadUrlTool } from "./tools/upload-url.js";
import { registerVideoTools } from "./tools/video.js";
import { TOOL_POLICIES } from "./tool-policy.js";
import { SERVER_VERSION } from "./version.js";

export type ServerProfile = "stdio" | "remote";

export function createAtlasCloudServer(
  profile: ServerProfile = "stdio"
): McpServer {
  const server = new McpServer(
    {
      name: "atlascloud-ai-media",
      version: SERVER_VERSION,
    },
    {
      instructions:
        "Use model discovery before generation when the model ID or parameters are uncertain. " +
        "Pick the model and parameters yourself from the user's request and the live catalog; ask only when something material is genuinely ambiguous. " +
        "Generation tools quote before anything runs. Call once without confirmation_token. If the result is confirmation_required, nothing was spent: show the user that exact model and cost and stop. " +
        "Only after a new user message explicitly confirms it, call again with unchanged arguments, confirmed: true, the same idempotency_key, and the returned confirmation_token; if the token was lost or mistyped, the server finds the quote from the unchanged arguments. " +
        "Send the token back even if you think it may have lapsed: the server checks expiry itself and says so if it has (only then quote again), so do not judge expiry from a clock. " +
        "If a call submits straight away instead (a charge under a configured auto-submit limit), tell the user the amount. " +
        "Words such as continue, stuck, retry, try again, or keep going never authorize a new quote or another generation submission. After submission, poll the returned prediction_id instead of calling a generation tool again. " +
        "Never invent a model ID or submit if its live schema cannot be loaded and validated.",
    }
  );

  registerDocsTools(server);
  registerModelTools(server);
  registerImageTools(server);
  registerVideoTools(server);
  registerAudioTools(server);
  registerLLMTools(server, { includeChat: profile === "stdio" || TOOL_POLICIES.atlas_chat.remote });
  registerQuickGenerateTools(server);
  registerAccountTools(server);
  registerPredictionTools(server);
  // 两种形态都注册：stdio 下它只会告诉调用方去用 atlas_upload_media。
  // 保持「stdio 暴露全部工具」这条契约不变，契约测试就不用为它开特例。
  registerUploadUrlTool(server);
  if (profile === "stdio") {
    registerUploadTools(server);
  }

  return server;
}
