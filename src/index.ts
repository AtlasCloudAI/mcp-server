#!/usr/bin/env node

/**
 * Atlas Cloud MCP Server
 *
 * Provides tools for AI assistants to interact with Atlas Cloud platform:
 * - Search documentation and model info
 * - List and explore available models
 * - Generate images, video, 3D, speech, music, and transcribe audio
 * - Chat with LLM models across chat-completions / responses / messages / gemini protocols
 * - Check generation results and browse generation history
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerModelTools } from "./tools/models.js";
import { registerImageTools } from "./tools/image.js";
import { registerVideoTools } from "./tools/video.js";
import { registerAudioTools } from "./tools/audio.js";
import { registerLLMTools } from "./tools/llm.js";
import { registerPredictionTools } from "./tools/prediction.js";
import { registerQuickGenerateTools } from "./tools/quick-generate.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerAccountTools } from "./tools/account.js";
import { Telemetry } from "./telemetry/telemetry.js";
import { publicApi } from "./services/api-client.js";
import type { BalanceResponse } from "./types.js";

// Read the version from package.json so it never drifts from the published one
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const server = new McpServer({
  name: "atlascloud-mcp",
  version,
});

// Anonymous usage telemetry (README "Telemetry"; ATLASCLOUD_TELEMETRY=0 turns it off).
// It wraps registerTool, so it has to be in place before the tools register.
const telemetry = Telemetry.start();
telemetry?.instrument(server);
telemetry?.setAccountLookup(async () => {
  const res = await publicApi<BalanceResponse>("/balance", { maxRetries: 0, timeout: 5000 });
  return res.account?.id;
});

// Register all tools
registerDocsTools(server);
registerModelTools(server);
registerImageTools(server);
registerVideoTools(server);
registerAudioTools(server);
registerLLMTools(server);
registerPredictionTools(server);
registerQuickGenerateTools(server);
registerUploadTools(server);
registerAccountTools(server);

// Start stdio transport
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (telemetry) {
    telemetry.observeTransport(transport);
    // Report the session end before the process goes away. The client closing
    // stdin is the normal end of a stdio session; signals cover the rest.
    let exiting = false;
    const finish = (reason: string, code: number) => {
      if (exiting) return;
      exiting = true;
      void telemetry.shutdown(reason).finally(() => process.exit(code));
    };
    process.stdin.once("end", () => finish("stdin_closed", 0));
    process.stdin.once("close", () => finish("stdin_closed", 0));
    process.once("SIGINT", () => finish("sigint", 130));
    process.once("SIGTERM", () => finish("sigterm", 143));
    process.once("SIGHUP", () => finish("sighup", 129));
  }
  console.error("Atlas Cloud MCP Server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
