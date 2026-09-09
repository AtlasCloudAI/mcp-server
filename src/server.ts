import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./tools/account.js";
import { registerAudioTools } from "./tools/audio.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerImageTools } from "./tools/image.js";
import { registerLLMTools } from "./tools/llm.js";
import { registerModelTools } from "./tools/models.js";
import { registerQuickGenerateTools } from "./tools/quick-generate.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerVideoTools } from "./tools/video.js";
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
        "Generation tools gate on cost. Call once without confirmation_token: the server quotes the request and, when the charge is under the spend limit, submits it straight away and reports the amount — pass that amount on to the user rather than staying silent about it. " +
        "When the charge reaches the limit, or the platform will not give a firm quote, the same call returns a quote and a confirmation_token and spends nothing; show that exact quote and stop, and only after a new user message explicitly confirms it may you call again with the returned confirmation_token, the same idempotency_key, and unchanged arguments. " +
        "Do not add a confirmation step of your own on top of this: the limit is the product decision about when a charge is worth interrupting someone. " +
        "Words such as continue, stuck, retry, try again, or keep going never authorize a new quote or another generation submission. After submission, poll the returned prediction_id instead of calling a generation tool again. " +
        "Never choose a model or spending level when the user's budget or material parameters are ambiguous; ask first. " +
        "Never invent a model ID or submit if its live schema cannot be loaded and validated.",
    }
  );

  registerDocsTools(server);
  registerModelTools(server);
  registerImageTools(server);
  registerVideoTools(server);
  registerAudioTools(server);
  registerLLMTools(server, { includeChat: profile === "stdio" });
  registerQuickGenerateTools(server);
  registerAccountTools(server);
  if (profile === "stdio") {
    registerUploadTools(server);
  }

  return server;
}
