import { fetchExternalBinary } from "./api-client.js";

// Why this exists: a generated image is returned to us as a URL on the object
// store's default domain, and that domain forces `Content-Disposition: attachment`
// plus `x-oss-force-download: true` at the gateway. A client that renders the URL
// gets a download, not a picture. Codex also refuses http(s) image URLs outright —
// an image item has to carry a base64 `data:` payload — so even once the platform
// binds a custom domain, showing the result in chat still means sending bytes.
//
// So we fetch the object server-side and hand the client an MCP image block. The
// client never touches the object store, and the response headers stop mattering.
//
// The model sees the block too, which is the part that is not just cosmetic: it
// can look at what it generated and say the hands are wrong.

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "heic", "heif", "tiff",
]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "opus"]);

export type OutputKind = "image" | "video" | "audio" | "other";

type BinaryFetcher = NonNullable<
  Parameters<typeof fetchExternalBinary>[1]
>["fetcher"];

export interface ImagePreviewBlock {
  type: "image";
  data: string;
  mimeType: string;
}

function extensionOf(url: string): string {
  try {
    // Query and fragment first: signed object URLs carry an expiry and a
    // signature, and "…/a.png?Expires=1&Signature=x" has no extension without this.
    const { pathname } = new URL(url);
    const last = pathname.split("/").pop() ?? "";
    const dot = last.lastIndexOf(".");
    return dot === -1 ? "" : last.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
}

export function classifyOutput(url: string): OutputKind {
  const ext = extensionOf(url);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "other";
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function previewsEnabled(): boolean {
  return boolEnv("MCP_MEDIA_PREVIEW_ENABLED", true);
}

export function maxPreviews(): number {
  // A batch of four 1024px JPEGs is already a few thousand tokens of context.
  return intEnv("MCP_MEDIA_PREVIEW_MAX", 4, 0, 8);
}

// Aliyun OSS resizes on read, which is the difference between a 4 MB PNG and a
// ~100 KB JPEG in the response. `l_<n>` bounds the long edge, so portrait and
// landscape both come back bounded without us knowing the aspect ratio.
/**
 * 读时缩放的参数名按存储厂商分派。
 *
 * 两家的图片处理语法相同，但参数名不同：阿里云 OSS 用 `x-oss-process`，
 * 火山引擎 TOS 用 `x-tos-process`。给错了不会报错——对方当成无关查询参数忽略，
 * 于是原图整张下载，2048×2048 的 PNG 轻松超过 1.5MB 的抓取上限，
 * 预览再次静默消失。所以这里必须按主机分派，不能只挑一个发。
 */
function resizeParamName(hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (host.endsWith(".aliyuncs.com")) return "x-oss-process";
  if (host.endsWith(".volces.com")) return "x-tos-process";
  // 我们自己的域名后面可能是任一家，两个都试没有意义——不加参数，
  // 让体积闸去兜底。
  return null;
}

export function withResizeParams(url: string): string | null {
  try {
    const parsed = new URL(url);
    const param = resizeParamName(parsed.hostname);
    if (!param) return null;
    if (parsed.searchParams.has(param)) return null;
    const edge = intEnv("MCP_MEDIA_PREVIEW_EDGE", 1024, 256, 2048);
    parsed.searchParams.set(
      param,
      `image/resize,l_${edge}/format,jpg/quality,q_80`
    );
    return parsed.toString();
  } catch {
    return null;
  }
}

// Diagnostics for a path that fails open. Every failure here is silent by
// design — the generation still succeeds — which is exactly why it has to say
// something: a picture that never appears looks identical to a picture that was
// never attempted, and the difference took a long time to find once.
//
// Object URLs can carry a signature in the query, so only the host and path are
// logged, never the query string.
function redactUrl(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    return `${host}${pathname}`;
  } catch {
    return "<unparseable url>";
  }
}

function logPreview(message: string): void {
  console.error(`[media-preview] ${message}`);
}

function mimeFor(contentType: string | null, url: string): string | null {
  if (contentType) {
    const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (bare.startsWith("image/")) return bare;
  }
  const ext = extensionOf(url);
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

/**
 * Fetch one image and return it as an MCP image block, or null if anything at
 * all goes wrong.
 *
 * Fail-open is deliberate. The prediction result is the answer to the user's
 * question; the picture is a nicety on top. An object store hiccup, a bucket
 * that has image processing switched off, an object larger than the cap — none
 * of those should turn a successful generation into a failed tool call.
 */
export async function buildImagePreview(
  url: string,
  // 测试注入用。生产路径不传，走 fetchExternalBinary 自己的默认实现。
  // 类型从 fetchExternalBinary 推导：那边引的是 undici 的 fetch，
  // 这边直接写 typeof fetch 会解析到全局那个，两者不兼容。
  options: { fetcher?: BinaryFetcher } = {}
): Promise<ImagePreviewBlock | null> {
  // Resized first. If the bucket has no image processing the request 400s, and
  // the original is still worth trying — it just costs more context.
  const candidates = [withResizeParams(url), url].filter(
    (candidate): candidate is string => Boolean(candidate)
  );

  for (const candidate of candidates) {
    const resized = candidate !== url;
    try {
      const { bytes, contentType } = await fetchExternalBinary(candidate, {
        fetcher: options.fetcher,
      });
      const mimeType = mimeFor(contentType, url);
      if (!mimeType) {
        logPreview(
          `skip ${redactUrl(url)}: content-type ${contentType ?? "<none>"} is not an image`
        );
        continue;
      }
      if (bytes.byteLength === 0) {
        logPreview(`skip ${redactUrl(url)}: empty body`);
        continue;
      }
      logPreview(
        `ok ${redactUrl(url)} (${resized ? "resized" : "original"}, ${bytes.byteLength}B, ${mimeType})`
      );
      return {
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType,
      };
    } catch (error) {
      logPreview(
        `fail ${redactUrl(url)} (${resized ? "resized" : "original"}): ` +
          (error instanceof Error ? error.message : String(error))
      );
      continue;
    }
  }
  logPreview(`no preview for ${redactUrl(url)} after ${candidates.length} attempt(s)`);
  return null;
}

export async function buildImagePreviews(urls: string[]): Promise<ImagePreviewBlock[]> {
  if (!previewsEnabled()) return [];
  const limit = maxPreviews();
  if (limit === 0) return [];
  // 后缀只是线索，不是判据。签名过的对象 URL 经常没有扩展名
  // （".../generations/abc123?Expires=…"），按后缀筛会把它归成 other 直接丢掉 ——
  // 表现就是「有产出、0 张图、尝试 0 次」，而这恰恰是线上真实发生过的一行日志。
  //
  // 所以认得出是图片的、以及认不出类型的，都当候选试一次；真正的判据是抓回来的
  // Content-Type，buildImagePreview 里那道闸会把不是图片的挡掉。
  // 认得出是视频/音频的不试 —— 那是确定的非图片，省一次无谓的抓取。
  const byExtension = urls.filter((url) => classifyOutput(url) === "image");
  const candidates = urls.filter((url) => {
    const kind = classifyOutput(url);
    return kind === "image" || kind === "other";
  });
  const targets = candidates.slice(0, limit);
  const settled = await Promise.all(targets.map((url) => buildImagePreview(url)));
  const blocks = settled.filter((block): block is ImagePreviewBlock => block !== null);
  logPreview(
    `${urls.length} output(s), ${candidates.length} candidate(s) ` +
      `(${byExtension.length} by extension), attempted ${targets.length}, ` +
      `attached ${blocks.length}`
  );
  return blocks;
}

/**
 * What to tell the model about outputs it cannot be shown.
 *
 * Codex has no video content type — not in MCP's blocks and not in its own input
 * items, which are text, image and audio only. So we cannot attach a video the way
 * we attach an image, and the default-domain URL downloads rather than plays.
 *
 * What does NOT follow is that a video can never appear in the conversation. It
 * can: a client that reads local files renders a saved .mp4 with a real player.
 * Observed on 2026-10-08 — the same generation that showed only a "download the
 * video" link when handed over as a URL came back with an inline player once the
 * model had curled it into the working directory.
 *
 * This guidance used to say "Video cannot be displayed in this conversation" and
 * then merely OFFER to save it. Both halves worked against the result: the model
 * told the user it was impossible and waited for permission it did not need.
 *
 * Fixing that (v2.7.1) was necessary but not sufficient. The model then saved the
 * file and handed over a link labelled "download and play the video" — still no
 * player in the conversation. "Show them that local file" left it room to read
 * showing as linking.
 *
 * What settled it: asked directly, in the very same conversation, to "display the
 * video inline, with a player", the model did it in 8 seconds. The capability was
 * never missing on either side — the instruction was. So this now names the
 * outcome (display inline, with a player) and rules out the near miss (a link is
 * not the deliverable), rather than describing the mechanism and hoping.
 */
/**
 * 曾经这里有一条「图片块已附上，不要再渲染一次」的指引。
 *
 * 它的前提是错的：服务端看不到客户端会不会把图片块显示在最终回答里。
 * 线上实测的后果是模型照做、什么图都不给，比原先「一张好图旁边一个破图」
 * 更糟 —— 用户至少能看到一张。谁来呈现图片是客户端的职责，服务端不该替它决定。
 *
 * 保留下来的只有可验证的事实：下载不带 Referer，点击可能带。
 */
export function playbackGuidance(kinds: Set<OutputKind>): string | null {
  const notes: string[] = [];
  if (kinds.has("image")) {
    notes.push(
      "Save the image into the user's working directory and show them that local file: " +
        "`curl -L -o <descriptive-name>.png '<url>'`. Downloading is what makes it " +
        "viewable — these object URLs are hotlink-protected, so a request carrying a " +
        "Referer (which is what a click from this chat sends) can come back 403, while a " +
        "download sends none. Skip the download only if you cannot write files; then give " +
        "the URL and say it may not open directly."
    );
  }
  if (kinds.has("video")) {
    notes.push(
      "Save the video with `curl -L -o <descriptive-name>.mp4 '<url>'`, then DISPLAY THAT " +
        "SAVED FILE INLINE IN THE CONVERSATION, WITH A PLAYER. Do not ask for permission " +
        "first.\n" +
        "A link is not the deliverable. Offering \"download the video\" and stopping there " +
        "fails the request: the user wants to watch it where they are reading, not click " +
        "through to another window. Embed the saved local file the same way you would show " +
        "a generated image. The server cannot attach a video block for you — that is " +
        "precisely why presenting the saved file is your job, not an optional extra.\n" +
        "Do not tell the user the video cannot be shown, and do not tell them to open the " +
        "URL in a browser: some output buckets are hotlink-protected and refuse a request " +
        "that carries a Referer, so a click from the chat can come back 403, while a " +
        "download sends none and always works. Skip all of this only if you cannot write " +
        "files; then give the URL and say it may not open directly and can expire."
    );
  }
  if (kinds.has("other")) {
    notes.push(
      "Some outputs are not images, video or audio (for example 3D assets such as GLB or " +
        "OBJ). Save those into the user's working directory as well, without asking first " +
        "— for the same reason: a download carries no Referer, a click from the chat may."
    );
  }
  return notes.length > 0 ? notes.join("\n") : null;
}

/**
 * The extra content for a generation that came back already finished.
 *
 * Some models answer synchronously — the URLs are in the submit response and
 * there is no queue to poll. Those results used to be dropped on the floor,
 * so the caller was told to poll a prediction that had nothing left to say and
 * the picture never reached the conversation. This builds what the polling path
 * would have built: the URLs as text, the playback guidance for what cannot be
 * displayed, and the image blocks themselves.
 */
export async function completedOutputContent(urls: string[]): Promise<{
  text: string;
  blocks: ImagePreviewBlock[];
}> {
  // 先把图片块建出来，提示语才知道用户到底看没看到图 ——
  // 「已经附上了」和「一张都没附上」该给模型的指引是相反的。
  const blocks = await buildImagePreviews(urls);
  const lines = ["## Output\n"];
  urls.forEach((url, index) => lines.push(`${index + 1}. ${url}`));
  const guidance = playbackGuidance(new Set(urls.map(classifyOutput)));
  if (guidance) lines.push(`\n${guidance}`);
  return { text: lines.join("\n"), blocks };
}
