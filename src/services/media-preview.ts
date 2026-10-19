import { fetchExternalBinary } from "./api-client.js";
import { currentClientWantsImageBlocks, type ClientProfile } from "./client-profile.js";

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
//
// Codex has since changed how it calls tools, and no longer gets the block at all:
// see wantsImageBlocks in client-profile.ts.

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

// 预览格式按原图选：JPG 原图本来就没有透明通道，转 JPG 最省；其它（png/webp，以及
// 签名链接里看不出格式的）一律转 WebP。以前统一转 JPG，透明背景的图在预览里被填成
// 白底，agent 看预览就断定「透明参数没生效」——原文件其实是透明的。
// 实测 1024px：WebP 113KB 保住 alpha；PNG 1.6MB，超过抓取上限，预览会静默消失。
function previewFormat(pathname: string): "jpg" | "webp" {
  return /\.jpe?g$/i.test(pathname) ? "jpg" : "webp";
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
      `image/resize,l_${edge}/format,${previewFormat(parsed.pathname)}/quality,q_80`
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
  // Codex 拿到图片块只会当文字读（见 client-profile.ts 的 wantsImageBlocks），
  // 这里连抓都不抓。
  if (!currentClientWantsImageBlocks()) {
    if (urls.length > 0) logPreview(`${urls.length} output(s), skipped: client gets no image blocks`);
    return [];
  }
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
export interface PlaybackOptions {
  /** Which host is asking; changes what it can do with a file. */
  profile?: ClientProfile;
  /** Byte size per output URL, when the server could read it, so a saved copy can be checked. */
  sizes?: Map<string, number>;
}

function sizeNote(urls: string[] | undefined, sizes: Map<string, number> | undefined): string {
  if (!urls || !sizes || sizes.size === 0) return "";
  const known = urls.filter((url) => sizes.has(url));
  if (known.length === 0) return "";
  const parts = known.map((url, i) => `${known.length > 1 ? `#${i + 1} ` : ""}${sizes.get(url)} bytes`);
  return ` The complete file is ${parts.join(", ")}; compare the saved size before showing it.`;
}

/**
 * 2026-10-19 实测（Codex 0.163）定下来的几条事实，指引就按它们写：
 *
 * - 本地文件用图片语法 `![标题](/绝对路径.mp4)` 会出播放器；同一个文件写成普通链接
 *   `[标题](路径)` 只显示成文件卡片。模型时而用这个时而用那个，所以要把语法原样写出来。
 * - 远程 Atlas 链接嵌进 Markdown 一律破图：Codex 渲染页的来源是 `app://-`，两个桶的
 *   防盗链都对它回 403。公网上没有防盗链的图片能正常显示，问题在我们的存储。
 * - Codex 的命令工具大约 10~30 秒就把控制权交回来，curl 还在后台写文件。模型把写到一半
 *   的文件当成品交付，用户看到的就是"损坏"的视频。所以要求等进程退出、核对大小。
 * - 默认权限下沙箱没有网络，curl 连不上；要为这一条命令申请联网，而不是直接放弃。
 * - ChatGPT、Claude 网页这类聊天客户端没有给模型用的本地 shell。让它下载、转码，只会触发
 *   一次次 node_repl 授权，最后用户还是拿不到文件；那边直接给链接。
 * - 认不出的客户端按有 shell 处理，但要留一条退路：没有 shell 就给链接（旧指引一直有这句）。
 */
export function playbackGuidance(
  kinds: Set<OutputKind>,
  options: PlaybackOptions & { urls?: string[] } = {}
): string | null {
  const profile = options.profile ?? "other";
  const notes: string[] = [];
  const urlsOf = (kind: OutputKind) => options.urls?.filter((u) => classifyOutput(u) === kind);

  if (profile === "chat") {
    if (kinds.has("image")) {
      notes.push(
        "The image is attached above as an image block. Also give the user the URL as a link. " +
          "Do not run code to download, convert or re-encode it: in this client every script " +
          "run asks the user for approval, and the file cannot be handed to them that way."
      );
    }
    if (kinds.has("video") || kinds.has("audio") || kinds.has("other")) {
      notes.push(
        "Give the user the URL above as a link to open or download. Do not run code to " +
          "download, convert, preview or re-encode it (no node_repl, python or shell): each run " +
          "asks the user for approval, the sandbox often has no network, and a file saved there " +
          "is not something the user can open. Say plainly that the file is ready at that link; " +
          "do not claim it was blocked or failed."
      );
    }
    return notes.length > 0 ? notes.join("\n") : null;
  }

  const save =
    "Wait until that command has really exited with code 0 — if your shell tool hands back " +
    "control while curl is still running, keep waiting on the same process; a file that is " +
    "still being written plays or shows as broken.";
  const network =
    "If the download fails because the sandbox has no network access, ask to run that one " +
    "command with network access (escalated permissions) instead of giving up.";
  const remote =
    "Never put the remote URL inside Markdown image syntax: the storage refuses requests " +
    "coming from the chat app, so it renders as a broken image. Mention the URL only as a " +
    "plain link for downloading.";

  if (kinds.has("image")) {
    notes.push(
      "Show the image inline: save it with `curl -L --fail --max-time 120 -o <descriptive-name>.png '<url>'` " +
        "into the working directory. " + save + sizeNote(urlsOf("image"), options.sizes) + " " + network + "\n" +
        "Then put this Markdown in your reply, with the saved file's absolute path: " +
        "`![<short title>](/absolute/path/<descriptive-name>.png)`. " + remote
    );
  }
  if (kinds.has("video")) {
    notes.push(
      "Show the video inline, with a player — a link is not the deliverable. Do not ask for permission first.\n" +
        "1. Save it: `curl -L --fail --max-time 600 -o <descriptive-name>.mp4 '<url>'`. " + save +
        sizeNote(urlsOf("video"), options.sizes) + "\n" +
        "2. " + network + "\n" +
        "3. Put this exact Markdown in your reply, with the saved file's absolute path: " +
        "`![<short title>](/absolute/path/<descriptive-name>.mp4)`. The leading `!` is what makes " +
        "the client render a player. A plain link such as `[video](/path/video.mp4)` shows only " +
        "a file chip, and an HTML <video> tag is printed as plain text.\n" +
        "4. " + remote + "\n" +
        "Do not tell the user the video cannot be shown."
    );
  }
  if (kinds.has("audio")) {
    notes.push(
      "Save the audio into the working directory with `curl -L --fail --max-time 300 -o " +
        "<descriptive-name>.<ext> '<url>'`. " + save + sizeNote(urlsOf("audio"), options.sizes) + " " +
        network + " Then give the saved file as a link with its absolute path, " +
        "`[<short title>](/absolute/path/<descriptive-name>.<ext>)`, so the user can open and play it."
    );
  }
  if (kinds.has("other")) {
    notes.push(
      "Some outputs are not images, video or audio (for example 3D assets such as GLB or " +
        "OBJ). Save those into the user's working directory as well, without asking first, " +
        "and give the saved path. " + save
    );
  }
  if (notes.length > 0) {
    notes.push(
      "If you have no shell or cannot write files, skip the download and give the URL as a plain " +
        "link instead; say it may download rather than play, and that it expires in about 15 days."
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
export async function completedOutputContent(
  urls: string[],
  options: PlaybackOptions = {}
): Promise<{
  text: string;
  blocks: ImagePreviewBlock[];
}> {
  // 先把图片块建出来，提示语才知道用户到底看没看到图 ——
  // 「已经附上了」和「一张都没附上」该给模型的指引是相反的。
  const blocks = await buildImagePreviews(urls);
  const lines = ["## Output\n"];
  urls.forEach((url, index) => lines.push(`${index + 1}. ${url}`));
  const guidance = playbackGuidance(new Set(urls.map(classifyOutput)), { ...options, urls });
  if (guidance) lines.push(`\n${guidance}`);
  return { text: lines.join("\n"), blocks };
}
