import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyOutput,
  playbackGuidance,
  withResizeParams,
  buildImagePreview,
  buildImagePreviews,
} from "../src/services/media-preview.js";

// 产出 URL 是签名过的，带 Expires/Signature 一串 query。早先按 endsWith(".png")
// 判类型的写法在这里会全判成 other，图片一张都预览不出来——所以判类型必须先剥
// query，这几条就是钉住这一点。
test("判定输出类型时忽略 query 与 fragment", () => {
  const signed =
    "https://atlas-media-dev.oss-us-west-1.aliyuncs.com/images/a.png" +
    "?Expires=1789000000&OSSAccessKeyId=x&Signature=abc%2Fdef";
  assert.equal(classifyOutput(signed), "image");
  assert.equal(classifyOutput("https://h.example/videos/b.MP4?x=1"), "video");
  assert.equal(classifyOutput("https://h.example/audio/c.wav#t=3"), "audio");
  assert.equal(classifyOutput("https://h.example/models/d.glb"), "other");
  assert.equal(classifyOutput("https://h.example/no-extension"), "other");
  assert.equal(classifyOutput("not a url"), "other");
});

test("缩略参数保留原有 query，且不覆盖已有的 x-oss-process", () => {
  const url = "https://b.oss-us-west-1.aliyuncs.com/i/a.png?Expires=1&Signature=s";
  const resized = withResizeParams(url);
  assert.ok(resized);
  const parsed = new URL(resized);
  // 签名参数必须原样带上，掉了就 403。
  assert.equal(parsed.searchParams.get("Signature"), "s");
  assert.equal(parsed.searchParams.get("Expires"), "1");
  assert.match(parsed.searchParams.get("x-oss-process") ?? "", /^image\/resize,l_\d+\//);

  // 已经指定过处理参数的 URL 不再套一层，否则会互相打架。
  assert.equal(
    withResizeParams("https://b.oss-us-west-1.aliyuncs.com/i/a.png?x-oss-process=image/info"),
    null
  );
});

test("视频给的是下载指引，不是「在浏览器里打开」", () => {
  const text = playbackGuidance(new Set(["video" as const]));
  assert.ok(text);
  // Codex 没有 video 内容类型，链接点开又是下载，所以唯一有用的建议是存到本地。
  assert.match(text, /curl -L -o/);
  assert.match(text, /cannot be displayed/i);

  assert.equal(playbackGuidance(new Set(["image" as const])), null);
  assert.equal(playbackGuidance(new Set()), null);
});

test("3D 等非视听产出也走下载指引", () => {
  const text = playbackGuidance(new Set(["other" as const]));
  assert.ok(text);
  assert.match(text, /GLB/);
});

// 预览是锦上添花：取不到就应当安静地退回只有文本的结果，绝不能把一次成功的
// 生成变成失败的工具调用。
test("取图失败时返回 null 而不是抛出", async (t) => {
  const previewHosts = process.env.MCP_MEDIA_PREVIEW_HOSTS;
  t.after(() => {
    if (previewHosts === undefined) delete process.env.MCP_MEDIA_PREVIEW_HOSTS;
    else process.env.MCP_MEDIA_PREVIEW_HOSTS = previewHosts;
  });

  // 主机不在白名单里，两次尝试都会被守卫拦下。
  process.env.MCP_MEDIA_PREVIEW_HOSTS = "static.atlascloud.ai";
  assert.equal(await buildImagePreview("https://evil.example/a.png"), null);

  // 内网地址同理，SSRF 那条路要堵死。
  assert.equal(await buildImagePreview("https://169.254.169.254/latest/a.png"), null);
  // 非 https 也不行。
  assert.equal(await buildImagePreview("http://static.atlascloud.ai/a.png"), null);
});

test("关掉开关或把上限设为 0 时不产生任何图片块", async (t) => {
  const enabled = process.env.MCP_MEDIA_PREVIEW_ENABLED;
  const max = process.env.MCP_MEDIA_PREVIEW_MAX;
  t.after(() => {
    if (enabled === undefined) delete process.env.MCP_MEDIA_PREVIEW_ENABLED;
    else process.env.MCP_MEDIA_PREVIEW_ENABLED = enabled;
    if (max === undefined) delete process.env.MCP_MEDIA_PREVIEW_MAX;
    else process.env.MCP_MEDIA_PREVIEW_MAX = max;
  });

  const urls = ["https://static.atlascloud.ai/a.png"];

  process.env.MCP_MEDIA_PREVIEW_ENABLED = "false";
  assert.deepEqual(await buildImagePreviews(urls), []);

  process.env.MCP_MEDIA_PREVIEW_ENABLED = "true";
  process.env.MCP_MEDIA_PREVIEW_MAX = "0";
  assert.deepEqual(await buildImagePreviews(urls), []);
});

test("只对图片类输出取预览", async (t) => {
  const previewHosts = process.env.MCP_MEDIA_PREVIEW_HOSTS;
  t.after(() => {
    if (previewHosts === undefined) delete process.env.MCP_MEDIA_PREVIEW_HOSTS;
    else process.env.MCP_MEDIA_PREVIEW_HOSTS = previewHosts;
  });
  // 白名单留空，任何取图都失败；这里断言的是「视频不会被尝试」这件事本身
  // 不依赖网络——结果为空且不抛错即可。
  process.env.MCP_MEDIA_PREVIEW_HOSTS = "nothing.invalid";
  const blocks = await buildImagePreviews([
    "https://h.example/videos/a.mp4",
    "https://h.example/models/b.glb",
  ]);
  assert.deepEqual(blocks, []);
});
