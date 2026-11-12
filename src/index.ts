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
import { prefetchCardCatalog } from "./apps/generation-card.js";

// Start stdio transport
async function main(): Promise<void> {
  // 本地版默认也开卡片，和托管版一致（托管版在部署里设 MCP_UI_CARDS=1）。会不会真显示卡片看客户端
  // initialize 时的声明（clientRendersCards）；不想要可以设 MCP_UI_CARDS=0。
  if (process.env.MCP_UI_CARDS === undefined || process.env.MCP_UI_CARDS.trim() === "") process.env.MCP_UI_CARDS = "1";
  const server = createAtlasCloudServer("stdio");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  prefetchCardCatalog();
  console.error("Atlas Cloud MCP Server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
