import assert from "node:assert/strict";
import test from "node:test";
import { createAtlasCloudServer } from "../src/server.js";
import { describeBillingAccount } from "../src/services/billing-account.js";
import { declaresMcpApps, initializeSummary, rememberUiDeclaration, uiDeclaration } from "../src/services/card-clients.js";
import { InMemoryUploadTicketStore } from "../src/services/upload-ticket-store.js";
import { uploadConcurrency } from "../ui/generation-card/upload.js";

// 11-13 Cursor / GrokBot 回归剩下能修的几条。

const toolsOf = (client: { clientId?: string; noCards?: boolean }): string[] =>
  Object.keys((createAtlasCloudServer("remote", client) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

test("initialize 里有没有声明 MCP Apps：Cursor 声明了，GrokBot 没有；不是 initialize 不算", () => {
  const cursor = {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "cursor-vscode", version: "1.0.0" },
      capabilities: { elicitation: { form: {} }, extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
    },
  };
  assert.equal(declaresMcpApps(cursor), true);
  assert.equal(declaresMcpApps({ ...cursor, params: { clientInfo: { name: "Cursor" }, capabilities: {} } }), false);
  assert.equal(declaresMcpApps({ jsonrpc: "2.0", id: 1, method: "tools/list" }), undefined);
  assert.equal(declaresMcpApps([cursor]), undefined);
});

test("按 client_id 记下声明，之后的请求查得到；没记录是 undefined", async () => {
  const store = new InMemoryUploadTicketStore();
  await rememberUiDeclaration("grokbot-client", false, store);
  await rememberUiDeclaration("cursor-client", true, store);
  assert.equal(await uiDeclaration("grokbot-client", store), false);
  assert.equal(await uiDeclaration("cursor-client", store), true);
  assert.equal(await uiDeclaration("someone-else", store), undefined);
});

// http.ts 暂不按声明拦（WorkBuddy 显示卡片却不声明），server 的 noCards 开关留着，等认得出 GrokBot 再用。
test("server 的 noCards：不列卡片专用工具（上传卡、作废报价…）", () => {
  const saved = process.env.MCP_UI_CARDS;
  process.env.MCP_UI_CARDS = "1";
  try {
    const withCards = toolsOf({ clientId: "dcr-client" });
    assert.ok(withCards.includes("atlas_open_upload_card"));
    assert.ok(withCards.includes("atlas_cancel_quote"));
    const grok = toolsOf({ clientId: "dcr-client", noCards: true });
    for (const name of ["atlas_open_upload_card", "atlas_cancel_quote", "atlas_card_status", "atlas_card_check_submission"]) {
      assert.equal(grok.includes(name), false, name);
    }
    // 上传的默认路径照旧在。
    assert.ok(grok.includes("atlas_get_upload_url"));
  } finally {
    if (saved === undefined) delete process.env.MCP_UI_CARDS;
    else process.env.MCP_UI_CARDS = saved;
  }
});

test("报价文字的扣费账号不带邮箱（GrokBot 照抄给了用户）", () => {
  assert.equal(describeBillingAccount({ name: "Lucas Zhu", type: "personal", available_usd: 37.68 }), "Lucas Zhu (personal account) · $37.68 available");
});

test("上传卡：图片、音频一个个传（资产库顺序等于选的顺序），有视频时两个一起传", () => {
  assert.equal(uploadConcurrency(["image", "image", "audio"]), 1);
  assert.equal(uploadConcurrency(["image", "video"]), 2);
  assert.equal(uploadConcurrency([]), 1);
});

test("initialize 日志摘要：名字、版本、协议、能力，不含别的", () => {
  const line = initializeSummary(
    { method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "cursor-vscode", version: "1.0.0" }, capabilities: { roots: {}, extensions: {} } } },
    true
  );
  assert.equal(line, "client=cursor-vscode version=1.0.0 protocol=2025-06-18 caps=roots,extensions mcp_apps=true");
  assert.equal(initializeSummary({ method: "initialize", params: {} }, false), "client=? version=? protocol=? caps=(none) mcp_apps=false");
});
