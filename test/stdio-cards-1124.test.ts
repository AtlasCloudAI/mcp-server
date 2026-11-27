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

// 11-26 Jia：Claude Code 桌面版声明了 MCP Apps、也画卡片，但卡片的按钮和刷新到不了本地（stdio）服务：
// 点 Confirm 没反应、结果卡一直停在 Generating。本地版给它文字版；Codex 的卡片能调本地服务，照旧给卡片。
test("stdio: Claude Code gets the text version even though it declares MCP Apps", async () => {
  const { stdioClientRendersCards } = await import("../src/stdio-cards.js");
  assert.equal(stdioClientRendersCards(true, "claude-code"), false);
  assert.equal(stdioClientRendersCards(true, "Claude Code"), false);
  assert.equal(stdioClientRendersCards(true, "codex-mcp-client"), true);
  assert.equal(stdioClientRendersCards(true, "claude-ai"), true);
  assert.equal(stdioClientRendersCards(false, "codex-mcp-client"), false);

  const { createAtlasCloudServer } = await import("../src/server.js");
  const { gateStdioCards, CARD_ONLY_TOOLS } = await import("../src/stdio-cards.js");
  const { clientState } = await import("../src/telemetry/state.js");
  const { clientRendersCards } = await import("../src/apps/generation-card.js");
  const server = createAtlasCloudServer("stdio");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  gateStdioCards(server, serverTransport);
  const client = new Client({ name: "claude-code", version: "2.1.330" }, { capabilities: UI_CAPABILITIES });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.equal(clientState.cardsMode, "text");
  for (const name of CARD_ONLY_TOOLS) assert.ok(!tools.some((tool) => tool.name === name), `${name} hidden`);
  assert.equal(tools.filter((tool) => tool._meta?.ui).length, 0);
  // 给模型的指引也按文字版写（不说「卡片会自己刷新」），否则它不去查结果。
  assert.equal(clientRendersCards(server), false);
  await client.close();
});
