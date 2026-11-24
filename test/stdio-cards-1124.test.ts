import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// 本地版和托管版一样按客户端 initialize 时的声明给卡片：没声明 MCP Apps 的（Claude Code、Codex CLI 这类）
// 拿文字版——没有卡片模板、没有卡片专用工具、总说明里没有卡片那句。

process.env.MCP_UI_CARDS = "1";
process.env.ATLASCLOUD_API_KEY = "test-key";

const UI_CAPABILITIES = {
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
};

async function session(capabilities: Record<string, unknown>) {
  const { createAtlasCloudServer } = await import("../src/server.js");
  const { gateStdioCards, CARD_ONLY_TOOLS } = await import("../src/stdio-cards.js");
  const { clientState } = await import("../src/telemetry/state.js");
  const server = createAtlasCloudServer("stdio");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  gateStdioCards(server, serverTransport);
  const client = new Client({ name: "probe", version: "1.0.0" }, { capabilities });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const result = {
    names: tools.map((tool) => tool.name),
    templated: tools.filter((tool) => tool._meta?.ui).map((tool) => tool.name),
    instructions: client.getInstructions() ?? "",
    cardsMode: clientState.cardsMode,
    cardOnly: CARD_ONLY_TOOLS as readonly string[],
    client,
  };
  return result;
}

test("a client that declares MCP Apps gets cards", async () => {
  const s = await session(UI_CAPABILITIES);
  assert.equal(s.cardsMode, "cards");
  assert.ok(s.names.includes("atlas_cancel_quote"));
  assert.ok(s.names.includes("atlas_card_status"));
  assert.ok(s.templated.includes("atlas_generate_image"));
  assert.match(s.instructions, /atlas_cancel_quote/);
  await s.client.close();
});

test("a client that does not declare MCP Apps gets the text version", async () => {
  const s = await session({});
  assert.equal(s.cardsMode, "text");
  for (const name of s.cardOnly) assert.ok(!s.names.includes(name), `${name} hidden`);
  assert.deepEqual(s.templated, [], "no card templates on any tool");
  assert.doesNotMatch(s.instructions, /atlas_cancel_quote/);
  assert.match(s.instructions, /Generation tools quote before anything runs/, "the rest of the instructions stay");
  // 生成工具本身照常可用。
  assert.ok(s.names.includes("atlas_generate_image"));
  const hidden = await s.client.callTool({ name: "atlas_card_status", arguments: { prediction_id: "x" } });
  assert.equal(hidden.isError, true, "a hidden card tool cannot be called");
  await s.client.close();
});
