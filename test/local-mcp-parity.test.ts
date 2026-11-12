// 本地（stdio）版向托管版对齐（11-12）：默认开卡片；上传卡没有上传中转，改成分块交给 atlas_card_upload_part。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CARD_UPLOAD_PART_MAX_CHARS,
  LOCAL_CARD_PLAIN_UPLOAD_URL,
  LOCAL_CARD_UPLOAD_URL,
  receiveCardUploadPart,
} from "../src/tools/card-upload.js";

const bytes = Buffer.from("hello local upload card");

test("本地上传卡：分块按顺序收齐后才上传，回复格式和托管版中转一样", async () => {
  const stored: Array<{ name: string; data: string; plain: boolean }> = [];
  const store = async (buffer: Buffer, filename: string, plain: boolean) => {
    stored.push({ name: filename, data: buffer.toString(), plain });
    return { status: 200, body: { url: "https://x/a.png", filename, asset_id: "asset_1" } };
  };
  const parts = [bytes.subarray(0, 10), bytes.subarray(10)];
  const base = { upload_id: "abcdef0123456789", filename: "a.png", total: 2, size: bytes.length };
  const first = await receiveCardUploadPart({ ...base, index: 0, data: parts[0]!.toString("base64") }, store);
  assert.deepEqual(first, { status: 202, body: { received: 10 } });
  assert.equal(stored.length, 0);
  const last = await receiveCardUploadPart({ ...base, index: 1, data: parts[1]!.toString("base64") }, store);
  assert.equal(last.status, 200);
  assert.equal(last.body.asset_id, "asset_1");
  assert.deepEqual(stored, [{ name: "a.png", data: bytes.toString(), plain: false }]);
});

test("本地上传卡：乱序、超出声明大小、没收齐都拒绝，不上传", async () => {
  const store = async () => {
    throw new Error("must not upload");
  };
  const base = { upload_id: "zzzzzzzz00000000", filename: "a.png", total: 2, size: bytes.length };
  // 没有第 0 块就来第 1 块
  assert.equal((await receiveCardUploadPart({ ...base, index: 1, data: bytes.toString("base64") }, store)).status, 400);
  // 一块就超过声明的大小
  const big = await receiveCardUploadPart({ ...base, upload_id: "yyyyyyyy00000000", size: 3, total: 1, index: 0, data: bytes.toString("base64") }, store);
  assert.equal(big.status, 413);
  // 声明 2 块、实际字节不够
  const short = { ...base, upload_id: "xxxxxxxx00000000", size: 100 };
  assert.equal((await receiveCardUploadPart({ ...short, index: 0, data: bytes.toString("base64") }, store)).status, 202);
  assert.equal((await receiveCardUploadPart({ ...short, index: 1, data: "" }, store)).status, 400);
  // 超过视频上限直接拒
  assert.equal((await receiveCardUploadPart({ ...base, upload_id: "wwwwwwww00000000", size: 200 * 1_048_576, index: 0, data: "" }, store)).status, 413);
});

test("本地上传卡：空间满了改走 plain 地址，卡片按托管版的 library_full 流程重传", async () => {
  const { outcomeOf, TOOL_UPLOAD_PREFIX } = await import("../ui/generation-card/upload.js");
  assert.ok(LOCAL_CARD_UPLOAD_URL.startsWith(TOOL_UPLOAD_PREFIX));
  assert.ok(LOCAL_CARD_PLAIN_UPLOAD_URL.startsWith(`${LOCAL_CARD_UPLOAD_URL}?`));
  const full = outcomeOf(
    413,
    JSON.stringify({ error: "upload_quota_exceeded", fallback_upload_url: LOCAL_CARD_PLAIN_UPLOAD_URL, fallback_max_bytes: 104_857_600 }),
    52_428_800
  );
  assert.equal(full.kind, "library_full");
  assert.equal(full.kind === "library_full" ? full.fallback?.upload_url : undefined, LOCAL_CARD_PLAIN_UPLOAD_URL);
  // 卡片每块 1.4MB 原始字节，base64 后不超过服务端每块上限。
  assert.ok(Math.ceil(1_400_000 / 3) * 4 <= CARD_UPLOAD_PART_MAX_CHARS);
});

test("本地版注册了分块上传工具（只给卡片调），托管版没有", async () => {
  process.env.MCP_UI_CARDS = "1";
  const { createAtlasCloudServer } = await import("../src/server.js");
  const names = (profile: "stdio" | "remote") =>
    Object.keys((createAtlasCloudServer(profile) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  assert.ok(names("stdio").includes("atlas_card_upload_part"));
  assert.ok(names("stdio").includes("atlas_open_upload_card"));
  assert.ok(!names("remote").includes("atlas_card_upload_part"));
});
