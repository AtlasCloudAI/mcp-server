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
import { publicApi } from "./services/api-client.js";
import { watchClientInfo } from "./telemetry/identity.js";
import { Telemetry } from "./telemetry/telemetry.js";

// Start stdio transport
async function main(): Promise<void> {
  // 本地版默认也开卡片，和托管版一致（托管版在部署里设 MCP_UI_CARDS=1）。会不会真显示卡片看客户端
  // initialize 时的声明（clientRendersCards）；不想要可以设 MCP_UI_CARDS=0。
  if (process.env.MCP_UI_CARDS === undefined || process.env.MCP_UI_CARDS.trim() === "") process.env.MCP_UI_CARDS = "1";

  // Anonymous usage telemetry (README "Telemetry"; ATLASCLOUD_TELEMETRY=0 turns it off).
  // It wraps registerTool, so it has to be in place before the tools register.
  const telemetry = Telemetry.start();
  telemetry?.setAccountLookup(async () => {
    const res = await publicApi<{ account?: { id?: unknown } }>("/balance", { maxRetries: 0, timeout: 5000 });
    const id = res?.account?.id;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  });

  const server = createAtlasCloudServer("stdio", {}, { beforeTools: (s) => telemetry?.instrument(s) });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Which MCP client this is, for the X-Atlas-MCP-Client header (services/api-client.ts),
  // whether or not telemetry is on.
  watchClientInfo(transport);
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
  prefetchCardCatalog();
  console.error("Atlas Cloud MCP Server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
