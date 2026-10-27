// 上传卡前端的纯函数：从工具结果取数据、判文件、上传中转的回应怎么算、整张卡处在哪一步、交给模型的文字。
import assert from "node:assert/strict";
import test from "node:test";
import {
  fileKind,
  filesForModel,
  formatBytes,
  outcomeOf,
  uploadFromToolResult,
  uploadPhase,
  validateFile,
} from "../ui/generation-card/upload.js";

const MB = 1_048_576;

test("上传卡数据：优先读 _meta；宿主丢了 _meta 就从 structuredContent 推；别的结果不认", () => {
  const meta = {
    view: "upload",
    upload_url: "https://mcp.test/upload/abc",
    expires_at: "2026-10-27T12:00:00.000Z",
    max_bytes: 32 * MB,
    max_files: 10,
  };
  assert.deepEqual(uploadFromToolResult({ _meta: { "atlascloud/upload": meta } }), meta);

  const derived = uploadFromToolResult({
    structuredContent: {
      upload_url: "https://mcp.test/upload/xyz",
      method: "POST",
      expires_at: "2026-10-27T12:10:00.000Z",
      max_bytes: 8 * MB,
      curl_example: "curl …",
    },
  });
  assert.equal(derived?.upload_url, "https://mcp.test/upload/xyz");
  assert.equal(derived?.max_bytes, 8 * MB);
  assert.equal(derived?.max_files, 10);

  assert.equal(uploadFromToolResult({ structuredContent: { prediction_id: "p", status: "completed" } }), undefined);
  assert.equal(uploadFromToolResult({ _meta: { "atlascloud/card": { state: "running" } } }), undefined);
});

test("文件类型先看 MIME，没有就看扩展名；格式、空文件、超大都在选进来时就拦下", () => {
  assert.equal(fileKind("a.bin", "image/png"), "image");
  assert.equal(fileKind("clip.MOV"), "video");
  assert.equal(fileKind("voice.m4a", ""), "audio");
  assert.equal(fileKind("notes.pdf", "application/pdf"), "other");

  assert.equal(validateFile({ name: "a.jpg", size: MB, type: "image/jpeg" }, 32 * MB), undefined);
  assert.equal(validateFile({ name: "notes.pdf", size: 10, type: "application/pdf" }, 32 * MB), "Use an image, video or audio file");
  assert.equal(validateFile({ name: "a.png", size: 0, type: "image/png" }, 32 * MB), "This file is empty");
  assert.equal(validateFile({ name: "a.mp4", size: 48 * MB, type: "video/mp4" }, 32 * MB), "Over the 32 MB limit");
});

test("文件大小写成 2.4 MB、860 KB", () => {
  assert.equal(formatBytes(Math.round(2.4 * MB)), "2.4 MB");
  assert.equal(formatBytes(32 * MB), "32 MB");
  assert.equal(formatBytes(860 * 1024), "860 KB");
  assert.equal(formatBytes(12), "12 bytes");
});

test("上传中转的回应：成功拿地址，过期和票据无效都去换新地址，413 算文件问题，其余算传失败", () => {
  assert.deepEqual(outcomeOf(200, JSON.stringify({ url: "https://atlas-img/x.png" }), 32 * MB), { kind: "done", url: "https://atlas-img/x.png" });
  assert.deepEqual(outcomeOf(410, "{}", 32 * MB), { kind: "expired" });
  assert.deepEqual(outcomeOf(401, JSON.stringify({ error: "credential_rejected" }), 32 * MB), { kind: "expired" });
  assert.deepEqual(outcomeOf(413, "{}", 32 * MB), { kind: "invalid", message: "Over the 32 MB limit" });
  assert.equal(outcomeOf(429, "{}", 32 * MB).kind, "failed");
  assert.deepEqual(outcomeOf(0, "", 32 * MB), { kind: "failed", message: "Couldn't reach Atlas Cloud" });
  assert.deepEqual(outcomeOf(502, "not json", 32 * MB), { kind: "failed", message: "Upload failed" });
  // 200 却没有地址，不能当成功。
  assert.equal(outcomeOf(200, "{}", 32 * MB).kind, "failed");
});

test("整张卡处在哪一步：链接过期优先，有在传的算上传中，传失败优先于文件问题", () => {
  assert.equal(uploadPhase([], false), "empty");
  assert.equal(uploadPhase([{ status: "done" }], true), "expired");
  assert.equal(uploadPhase([{ status: "done" }, { status: "saving" }], false), "uploading");
  assert.equal(uploadPhase([{ status: "queued" }], false), "uploading");
  assert.equal(uploadPhase([{ status: "invalid" }, { status: "failed" }], false), "failed");
  assert.equal(uploadPhase([{ status: "done" }, { status: "invalid" }], false), "problem");
  assert.equal(uploadPhase([{ status: "done" }, { status: "done" }], false), "done");
});

test("交给模型的文字带文件名、类型和地址，并说明已经传好", () => {
  const text = filesForModel([
    { name: "front.jpg", kind: "image", url: "https://atlas-img/front.jpg" },
    { name: "voice.mp3", kind: "audio", url: "https://atlas-img/voice.mp3" },
  ]);
  assert.match(text, /2 files/);
  assert.match(text, /- front\.jpg \(image\): https:\/\/atlas-img\/front\.jpg/);
  assert.match(text, /- voice\.mp3 \(audio\): https:\/\/atlas-img\/voice\.mp3/);
  assert.match(text, /do not upload them again/);
});
