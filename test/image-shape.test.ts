// 问题 13（2026-11-03 Claude 验收）：模型拿不到图片宽高、判断不了横竖。读文件头、视频报价和
// 取素材写上形状、卡片交给模型的消息带上尺寸。
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { settingsChips } from "../src/apps/card-params.js";
import { describeImageShape, imageShape, imageSizeFromBytes } from "../src/services/image-size.js";
import { inputImageShapes, readImageShapes } from "../src/services/input-link-check.js";
import { inputShapeNotice } from "../src/tools/video.js";
import { assetsForModel, shapeText, usedFromToolResult } from "../ui/generation-card/assets.js";
import { filesForModel } from "../ui/generation-card/upload.js";

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** 带 EXIF 方向的 JPEG 头：像素按 stored 存，方向 orientation。 */
function jpeg(width: number, height: number, orientation?: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation) {
    const tiff = Buffer.alloc(26);
    tiff.write("II", 0, "ascii");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    tiff.writeUInt32LE(0, 22);
    const data = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
    const head = Buffer.from([0xff, 0xe1, 0, 0]);
    head.writeUInt16BE(data.length + 2, 2);
    parts.push(head, data);
  }
  // 一段无关的 APP0，确认会跳过去。
  parts.push(Buffer.from([0xff, 0xe0, 0x00, 0x07, 0x4a, 0x46, 0x49, 0x46, 0x00]));
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof, Buffer.alloc(9));
  return Buffer.concat(parts);
}

function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function webpVp8l(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8L", 12, "ascii");
  b[20] = 0x2f;
  b.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  return b;
}

test("reads width and height from PNG, JPEG (with EXIF rotation), WebP and GIF headers", () => {
  assert.deepEqual(imageSizeFromBytes(png(1600, 1200)), { width: 1600, height: 1200 });
  assert.deepEqual(imageSizeFromBytes(jpeg(1600, 1200)), { width: 1600, height: 1200 });
  // 手机竖拍：像素横着存，方向 6 表示要转 90°，看到的是竖图。
  assert.deepEqual(imageSizeFromBytes(jpeg(1920, 1080, 6)), { width: 1080, height: 1920 });
  assert.deepEqual(imageSizeFromBytes(jpeg(1920, 1080, 3)), { width: 1920, height: 1080 });
  assert.deepEqual(imageSizeFromBytes(webpVp8x(1080, 1920)), { width: 1080, height: 1920 });
  assert.deepEqual(imageSizeFromBytes(webpVp8l(800, 800)), { width: 800, height: 800 });
  assert.deepEqual(imageSizeFromBytes(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])), { width: 320, height: 240 });
  assert.equal(imageSizeFromBytes(Buffer.from("not an image at all")), undefined);
  // 头部被截断：读不出就不猜。
  assert.equal(imageSizeFromBytes(jpeg(1600, 1200).subarray(0, 12)), undefined);
});

test("shape: orientation and the nearest common ratio", () => {
  assert.equal(describeImageShape(imageShape({ width: 1600, height: 1200 })), "1600×1200, landscape (4:3)");
  assert.equal(describeImageShape(imageShape({ width: 1080, height: 1920 })), "1080×1920, portrait (9:16)");
  assert.equal(describeImageShape(imageShape({ width: 2048, height: 2048 })), "2048×2048, square (1:1)");
  assert.equal(imageShape({ width: 1430, height: 1000 }).ratio, "1.43:1");
  assert.equal(imageShape({ width: 1000, height: 1430 }).ratio, "1:1.43");
});

let server: Server;
let origin = "";
const requests: Array<{ path: string; range?: string }> = [];

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push({ path, ...(req.headers.range ? { range: req.headers.range } : {}) });
    switch (path) {
      case "/wide.png":
        res.writeHead(206, { "content-type": "image/png" });
        return res.end(png(1600, 1200));
      case "/phone.jpg":
        res.writeHead(206, { "content-type": "image/jpeg" });
        return res.end(jpeg(4032, 3024, 6));
      case "/ignores-range.png":
        // 不认 Range、整个大文件往回推：读够 128 KB 就停。
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(Buffer.concat([png(1080, 1920), Buffer.alloc(2 * 1024 * 1024)]));
      case "/moved":
        res.writeHead(302, { location: "/wide.png" });
        return res.end();
      case "/page":
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html></html>");
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const local = { allowPrivateAddresses: true, timeoutMs: 3000 };

test("reads shapes over the network with a ranged request, follows redirects, skips what isn't an image", async () => {
  const shapes = await readImageShapes(
    [`${origin}/wide.png`, `${origin}/phone.jpg`, `${origin}/ignores-range.png`, `${origin}/moved`, `${origin}/page`, `${origin}/gone.png`],
    local
  );
  assert.equal(shapes.get(`${origin}/wide.png`)?.orientation, "landscape");
  assert.equal(describeImageShape(shapes.get(`${origin}/phone.jpg`)!), "3024×4032, portrait (3:4)");
  assert.equal(shapes.get(`${origin}/ignores-range.png`)?.ratio, "9:16");
  // 最多读 4 条：后面两条（网页、404）不读，读了也不会有形状。
  assert.equal(shapes.size, 4);
  assert.ok(requests.filter((r) => r.path === "/wide.png").every((r) => r.range === "bytes=0-131071"));
});

test("private addresses are not read unless allowed (same guard as the link check)", async () => {
  const shapes = await readImageShapes([`${origin}/wide.png`], { timeoutMs: 1000 });
  assert.equal(shapes.size, 0);
});

test("input image shapes come from image fields only", async () => {
  const shapes = await inputImageShapes(
    { prompt: `see ${origin}/wide.png`, image_url: `${origin}/phone.jpg`, audio_url: `${origin}/wide.png` },
    local
  );
  assert.deepEqual(
    shapes.map((s) => [s.field, s.orientation]),
    [["image_url", "portrait"]]
  );
});

test("the video quote says the output follows the image unless a ratio is set", () => {
  const wide = { field: "image", ...imageShape({ width: 1600, height: 1200 }) };
  const follows = inputShapeNotice([wide], { model: "x", image: "u", ratio: "adaptive" });
  assert.match(follows, /Input image\*\*: 1600×1200, landscape \(4:3\)\. The video takes this shape/);
  assert.match(follows, /tell them before they confirm/);
  assert.match(inputShapeNotice([wide], { image: "u" }), /The video takes this shape/);
  assert.match(inputShapeNotice([wide], { image: "u", aspect_ratio: "9:16" }), /set to 9:16, so the model fits the image/);
  assert.equal(inputShapeNotice(undefined, {}), "");
});

test("the quote card chip names the image's ratio when the video follows it", () => {
  assert.ok(settingsChips({ ratio: "adaptive", duration: 5 }, { ratio: "4:3" }).includes("Ratio from image · 4:3"));
  // 模型没有比例参数（Kling 图生视频）：同样标出来。
  assert.ok(settingsChips({ duration: 5 }, { ratio: "4:3" }).includes("Ratio from image · 4:3"));
  assert.deepEqual(settingsChips({ aspect_ratio: "9:16" }, { ratio: "4:3" }), ["9:16"]);
  assert.ok(settingsChips({ ratio: "adaptive" }).includes("Ratio from image"));
});

test("the card hands the image size to the model with library picks and uploads", () => {
  const used = usedFromToolResult({
    structuredContent: {
      assets: [
        { asset_id: "asset_1", url: "https://x/1", width: 1600, height: 1200, orientation: "landscape", ratio: "4:3" },
        { asset_id: "asset_2", url: "https://x/2" },
      ],
      missing: [],
    },
  });
  assert.deepEqual(used?.assets, [
    { asset_id: "asset_1", url: "https://x/1", shape: "1600×1200, landscape (4:3)" },
    { asset_id: "asset_2", url: "https://x/2" },
  ]);
  assert.match(
    assetsForModel([{ asset_id: "asset_1", label: "teapot", kind: "image", url: "https://x/1", shape: "1600×1200, landscape (4:3)" }]),
    /- teapot \(image, 1600×1200, landscape \(4:3\), asset_1\): https:\/\/x\/1/
  );
  assert.equal(shapeText(1080, 1920), "1080×1920, portrait");
  assert.match(
    filesForModel([{ name: "pear.jpg", kind: "image", url: "https://x/p", shape: "1080×1920, portrait" }]),
    /- pear\.jpg \(image, 1080×1920, portrait\): https:\/\/x\/p/
  );
  assert.match(
    filesForModel([{ name: "pear.jpg", kind: "image", url: "https://x/p", asset_id: "asset_9", saved: true, shape: "1080×1920, portrait" }]),
    /\(image, 1080×1920, portrait, saved to the Asset Library, asset_9\)/
  );
});
