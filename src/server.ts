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
        "All generation tools use a mandatory two-call billing flow. The first call must omit confirmation_token and returns only a live quote; show the exact resolved model, validated parameters, and current pricing, then stop. " +
        "Only after a new user message explicitly confirms that exact quote may you make the second call with the returned confirmation_token, the same idempotency_key, and unchanged arguments. " +
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
