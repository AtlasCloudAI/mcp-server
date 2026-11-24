import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { generationCardEnabled } from "./apps/generation-card.js";
import { withoutCards } from "./http/openai-tool-metadata-transport.js";
import { CANCEL_QUOTE_INSTRUCTION } from "./server.js";
import { declaresMcpApps } from "./services/card-clients.js";
import { clientState } from "./telemetry/state.js";

/**
 * Cards on the local (stdio) server follow what the client declares in
 * `initialize`, as on the hosted server.
 *
 * The hosted server gives a client that does not declare MCP Apps the text
 * version: no card templates on the tools, no card data in results, no
 * card-only tools (WorkBuddy, GrokBot, Codex, Claude Code; see http.ts). The
 * stdio server registers its tools before the client says anything, so it used
 * to give every client the card version, and a client that ignores
 * `visibility: ["app"]` would list the card-only tools to its model. Here the
 * declaration is read when `initialize` arrives: without MCP Apps the card-only
 * tools are switched off (silently — no list_changed before the handshake
 * ends), the card sentence leaves the instructions, and every outgoing message
 * goes through the hosted server's `withoutCards`.
 */

export const CARD_ONLY_TOOLS = [
  "atlas_card_status",
  "atlas_card_check_submission",
  "atlas_cancel_quote",
  "atlas_open_upload_card",
  "atlas_card_upload_part",
  "atlas_card_selftest",
] as const;

type RegisteredTools = Record<string, { enabled: boolean }>;

function registeredTools(server: McpServer): RegisteredTools {
  // McpServer keeps its tools here (SDK pinned in package.json; test/stdio-cards-1124 guards it).
  return (server as unknown as { _registeredTools: RegisteredTools })._registeredTools ?? {};
}

function withoutCardInstruction(message: JSONRPCMessage): JSONRPCMessage {
  const result = (message as { result?: { instructions?: unknown; protocolVersion?: unknown } }).result;
  if (!result || typeof result.instructions !== "string" || result.protocolVersion === undefined) return message;
  return {
    ...message,
    result: { ...result, instructions: result.instructions.replace(CANCEL_QUOTE_INSTRUCTION, "") },
  } as JSONRPCMessage;
}

/** Call after server.connect(transport). */
export function gateStdioCards(server: McpServer, transport: Transport): void {
  if (!generationCardEnabled()) {
    clientState.cardsMode = "off";
    return;
  }
  let textOnly = false;
  const receive = transport.onmessage;
  if (receive) {
    transport.onmessage = (message, extra) => {
      const declared = declaresMcpApps(message);
      if (declared !== undefined) {
        textOnly = !declared;
        clientState.cardsMode = declared ? "cards" : "text";
        for (const name of CARD_ONLY_TOOLS) {
          const tool = registeredTools(server)[name];
          if (tool) tool.enabled = declared;
        }
      }
      return receive.call(transport, message, extra);
    };
  }
  const send = transport.send.bind(transport);
  transport.send = (message, options) =>
    send(textOnly ? withoutCardInstruction(withoutCards(message)) : message, options);
}
