#!/usr/bin/env node

/**
 * Atlas Cloud MCP Server
 *
 * Provides tools for AI assistants to interact with Atlas Cloud platform:
 * - Search documentation and model info
 * - List and explore available models
 * - Generate images and videos
 * - Chat with LLM models (OpenAI-compatible)
 * - Check generation results
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerModelTools } from "./tools/models.js";
import { registerImageTools } from "./tools/image.js";
import { registerVideoTools } from "./tools/video.js";
import { registerLLMTools } from "./tools/llm.js";
import { registerQuickGenerateTools } from "./tools/quick-generate.js";

const server = new McpServer({
  name: "atlascloud-mcp",
  version: "1.0.0",
});

// Register all tools
registerDocsTools(server);
registerModelTools(server);
registerImageTools(server);
registerVideoTools(server);
registerLLMTools(server);
registerQuickGenerateTools(server);

// Start stdio transport
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Atlas Cloud MCP Server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
