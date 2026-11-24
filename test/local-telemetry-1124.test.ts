import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { annotateToolCall, recordToolCallError } from "../src/services/tool-call-telemetry.js";
import { Telemetry } from "../src/telemetry/telemetry.js";

// npm 本地版埋点搬到生产线后：生成流程（和托管共用的代码）回填的报价、确认字段要进 mcp_local_tool_call，
// 会话结束事件要数出报价和确认次数。不连真 PostHog，起一个本地假接收端。

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test("quote / confirm fields from the shared generation code reach mcp_local_tool_call", async () => {
  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const receiver = createServer(async (req, res) => {
    const parsed = JSON.parse(await body(req)) as { batch: typeof events };
    events.push(...parsed.batch);
    res.end("{}");
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const port = (receiver.address() as { port: number }).port;

  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "atlas-mcp-telemetry-"));
  process.env.ATLASCLOUD_TELEMETRY_KEY = "phc_test";
  process.env.ATLASCLOUD_TELEMETRY_HOST = `http://127.0.0.1:${port}`;
  delete process.env.ATLASCLOUD_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[name];

  const telemetry = Telemetry.start();
  assert.ok(telemetry, "telemetry starts with a key");
  const server = new McpServer({ name: "t", version: "0" });
  telemetry.instrument(server);
  server.registerTool(
    "atlas_generate_image",
    { inputSchema: { model: z.string(), confirmed: z.boolean().optional(), confirmation_token: z.string().optional() } },
    async ({ confirmed }) => {
      if (!confirmed) {
        annotateToolCall({ execution_mode: "estimate", stage: "quote", estimated_cost_usd: 0.25, quote_hash: "q1" });
        return { content: [{ type: "text" as const, text: "confirmation_required" }] };
      }
      annotateToolCall({ execution_mode: "submit", stage: "submit", quote_hash: "q1", confirm_resolution: "exact" });
      return { content: [{ type: "text" as const, text: "submitted" }] };
    }
  );
  server.registerTool("atlas_cancel_quote", { inputSchema: { reason: z.string() } }, async () => {
    recordToolCallError({ code: "idempotency_conflict" });
    return { isError: true, content: [{ type: "text" as const, text: "conflict" }] };
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  telemetry.observeTransport(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await client.connect(clientSide);

  await client.callTool({ name: "atlas_generate_image", arguments: { model: "a/b" } });
  await client.callTool({
    name: "atlas_generate_image",
    arguments: { model: "a/b", confirmed: true, confirmation_token: "secret-token" },
  });
  // 同一份报价再确认一次（幂等重放）：不算第二次确认。
  await client.callTool({
    name: "atlas_generate_image",
    arguments: { model: "a/b", confirmed: true, confirmation_token: "secret-token" },
  });
  await client.callTool({ name: "atlas_cancel_quote", arguments: { reason: "declined" } });
  await telemetry.shutdown("test");
  receiver.close();

  const calls = events.filter((e) => e.event === "mcp_local_tool_call");
  assert.equal(calls.length, 4);
  const [quote, confirm, , cancel] = calls.map((e) => e.properties);
  assert.equal(quote.execution_mode, "estimate");
  assert.equal(quote.stage, "quote");
  assert.equal(quote.estimated_cost_usd, 0.25);
  assert.equal(quote.quote_hash, "q1");
  assert.equal(confirm.confirm_resolution, "exact");
  assert.equal(confirm.confirmed, true);
  assert.equal(confirm.has_confirmation_token, true);
  assert.ok(!JSON.stringify(confirm).includes("secret-token"), "token value never sent");
  assert.equal(cancel.is_error, true);
  assert.equal(cancel.error_code, "idempotency_conflict");
  assert.equal(cancel.error_category, "idempotency");
  assert.equal(cancel.exit_class, "user");

  const end = events.find((e) => e.event === "mcp_local_session_end")?.properties;
  assert.equal(end?.quotes_shown, 1);
  assert.equal(end?.quotes_confirmed, 1);
});
