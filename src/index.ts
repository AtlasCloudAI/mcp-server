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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAtlasCloudServer } from "./server.js";

// Start stdio transport
async function main(): Promise<void> {
  const server = createAtlasCloudServer("stdio");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Atlas Cloud MCP Server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
