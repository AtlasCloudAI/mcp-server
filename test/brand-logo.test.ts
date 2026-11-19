// 报价卡模型行的厂商图标改用官网模型卡那套品牌图标（11-12 Mike：映射在 homepage-v2 src/utils/brandLogo.ts）。
import assert from "node:assert/strict";
import test from "node:test";
import { brandIconUrl } from "../src/services/brand-logo.js";

test("按模型全名取官网品牌图标：目录 logo 404 的那些（MiniMax 语音、ElevenLabs、Suno、Kling Flash）也有图标", () => {
  const icon = (id: string) => brandIconUrl(id)?.replace("https://www.atlascloud.ai", "");
  assert.equal(icon("minimax/speech-2.8-turbo"), "/icons/brands/minimax-color.png");
  assert.equal(icon("elevenlabs/v4/text-to-speech"), "/icons/brands/elevenlabs.svg");
  assert.equal(icon("suno/chirp-v6"), "/icons/brands/suno.svg");
  assert.equal(icon("kwaivgi/kling-v4.0-flash/image-to-video"), "/icons/brands/kling-color.svg");
  assert.equal(icon("bytedance/seedream-v5.0-flash/text-to-image"), "/icons/brands/bytedance-color.svg");
  // 和官网一样先看斜杠后面的模型名：alibaba/wan-3.0 归 Wan（qwen 图标），z-image/turbo 归阿里。
  assert.equal(icon("alibaba/wan-3.0/text-to-video"), "/icons/brands/qwen-color.svg");
  assert.equal(icon("z-image/turbo"), "/icons/brands/alibaba-color.svg");
  // 长的先匹配：veed/lipsync 不被 lipsync-v3 抢，lipsync-v3 自己匹配到 sync。
  assert.equal(icon("veed/lipsync"), "/icons/brands/veed-color.svg");
  assert.equal(icon("sync/lipsync-v3"), "/icons/brands/sync.svg");
  assert.equal(brandIconUrl("someone/unknown-model"), undefined);
  assert.equal(brandIconUrl(""), undefined);
});

test("卡片放行官网图标的来源，并且放行的来源算进卡片地址的哈希（只改 CSP 时宿主也会换新卡）", async () => {
  const { cardMediaDomains, DEFAULT_MEDIA_DOMAINS } = await import("../src/apps/generation-card.js");
  assert.ok(cardMediaDomains({}).includes("https://www.atlascloud.ai"));
  assert.ok(DEFAULT_MEDIA_DOMAINS.includes("https://www.atlascloud.ai"));
});
