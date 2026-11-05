// 上传卡：设计稿「上传 · Upload」。
// 模型调 atlas_get_upload_url 时卡片打开，用户在卡里选文件或拖进来，浏览器直接把字节 POST 到
// 上传中转（地址里的票据就是凭据，见 src/services/upload-ticket.ts），传完拿到公网地址。
// 用户点「Use N files」时把地址交给模型：放进模型上下文，再替用户发一句「用这几个文件」。
// 服务端数据见 src/apps/upload-card.ts。

import type { App } from "@modelcontextprotocol/ext-apps";
import { ASSET_REF_NOTE, type PickedAsset, shapeText } from "./assets.js";
import { RECONNECT_NOTE, isSignedOut } from "./card.js";
import { handOff } from "./handoff.js";
import { prefillNote, say, userLang } from "./voice.js";
import { thrownErrorText } from "./quote.js";
import { badge, button, h, head } from "./view.js";

export const UPLOAD_META_KEY = "atlascloud/upload";
const UPLOAD_TOOL = "atlas_get_upload_url";

export type UploadKind = "image" | "video" | "audio" | "other";
export type UploadStatus = "queued" | "uploading" | "saving" | "done" | "invalid" | "failed";

export interface UploadCardData {
  view: "upload";
  upload_url: string;
  expires_at: string;
  /** 单个文件上限；存进资产库时是图片、音频的上限。 */
  max_bytes: number;
  /** 存进资产库时视频的上限（资产库二期：图片、音频 50 MB，视频 100 MB）。 */
  max_video_bytes?: number;
  /** 存进资产库时图片的像素上限（AssetD 拒收超过的，默认 2400 万像素）。 */
  max_image_pixels?: number;
  /** 传上去的文件存进用户的资产库。 */
  library?: boolean;
  max_files: number;
  sample?: boolean;
  sample_files?: Array<{
    name: string;
    size_bytes: number;
    kind: UploadKind;
    status: "uploading" | "done" | "invalid" | "failed";
    progress?: number;
    url?: string;
    error?: string;
    megapixels?: number;
  }>;
  sample_expired?: boolean;
  sample_overflow?: { picked: number; added: number };
  /** 测试卡片：换地址时 Atlas 登录已失效（「需要重新连接」）。 */
  sample_signed_out?: boolean;
  /** 测试卡片：资产库上传空间已满（设计稿 06 页 11/02「上传空间已满」）。 */
  sample_library_full?: { quota_bytes: number };
}

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  kind: UploadKind;
  status: UploadStatus;
  /** 0~1。 */
  progress: number;
  /** 传完后的公网地址。 */
  url?: string;
  error?: string;
  /** 缩略图：本地图片缩成的 data URL（卡片 CSP 不一定放行 blob:），或示例图地址。 */
  thumb?: string;
  file?: File;
  /** 在资产库里的（选来的或传进去的）：地址是临时的，过期了模型用这个编号再换。 */
  asset_id?: string;
  /** 这张卡传进资产库的（不是从资产库选来的）。 */
  saved?: boolean;
  /** 超像素的图片：原因那行写「52 MP · over the 24 MP limit」，不写文件大小。 */
  megapixels?: number;
  /** 正在读图片尺寸（存进资产库前先查像素），读完才排队上传。 */
  checking?: boolean;
  /** 图片的尺寸和横竖，交给模型时写上（模型看不到图，判断不了横竖）。 */
  shape?: string;
}

export type UploadPhase = "empty" | "uploading" | "done" | "problem" | "failed" | "expired";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 工具结果 → 上传卡数据。优先读 _meta，宿主没转过来就从 structuredContent 推。 */
export function uploadFromToolResult(result: unknown): UploadCardData | undefined {
  const r = record(result);
  if (!r) return undefined;
  const fromMeta = record(record(r._meta)?.[UPLOAD_META_KEY]);
  if (fromMeta?.view === "upload" && typeof fromMeta.upload_url === "string") return fromMeta as unknown as UploadCardData;
  const s = record(r.structuredContent);
  if (!s || typeof s.upload_url !== "string" || typeof s.max_bytes !== "number" || typeof s.curl_example !== "string") {
    return undefined;
  }
  return {
    view: "upload",
    upload_url: s.upload_url,
    expires_at: typeof s.expires_at === "string" ? s.expires_at : new Date(Date.now() + 5 * 60_000).toISOString(),
    max_bytes: s.max_bytes,
    ...(typeof s.max_video_bytes === "number" ? { max_video_bytes: s.max_video_bytes } : {}),
    ...(s.saves_to_asset_library === true ? { library: true } : {}),
    max_files: 10,
  };
}

const EXT_KIND: Record<string, UploadKind> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", avif: "image", bmp: "image", heic: "image",
  mp4: "video", mov: "video", webm: "video", m4v: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", ogg: "audio", flac: "audio", opus: "audio",
};

export function fileKind(name: string, mime = ""): UploadKind {
  const top = mime.split("/")[0];
  if (top === "image" || top === "video" || top === "audio") return top;
  return EXT_KIND[name.split(".").pop()?.toLowerCase() ?? ""] ?? "other";
}

/** 2.4 MB、860 KB、12 bytes。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1).replace(/\.0$/, "")} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function limitLabel(maxBytes: number): string {
  return `${Math.floor(maxBytes / 1_048_576)} MB`;
}

/** 上传空间：2 GB（不到 1 GB 的按 MB）。 */
function quotaLabel(bytes: number): string {
  return bytes >= 1_073_741_824 ? `${Math.round(bytes / 1_073_741_824)} GB` : limitLabel(bytes);
}

/** 不符合的原因（设计稿 06 页 11/02「文件不符合」）：格式这条不带文件大小，其余跟在大小后面。 */
const FORMAT_PREFIX = "Format not supported";

export function pixelLimitMessage(maxPixels: number): string {
  return `over the ${Math.round(maxPixels / 1_000_000)} MP limit`;
}

/** 这类文件的上限：存进资产库时视频另有上限，其余按 max_bytes。 */
export function limitFor(kind: UploadKind, data: Pick<UploadCardData, "max_bytes" | "max_video_bytes">): number {
  return kind === "video" && data.max_video_bytes ? data.max_video_bytes : data.max_bytes;
}

/** 选进来的文件能不能传；能传返回 undefined，不能传返回显示在文件名下面的原因。 */
export function validateFile(file: { name: string; size: number; type?: string }, maxBytes: number): string | undefined {
  if (fileKind(file.name, file.type) === "other") return `${FORMAT_PREFIX} · use an image, video or audio file`;
  if (file.size === 0) return "This file is empty";
  if (file.size > maxBytes) return `over the ${limitLabel(maxBytes)} limit`;
  return undefined;
}

export function uploadPhase(items: Pick<UploadItem, "status">[], linkExpired: boolean): UploadPhase {
  if (linkExpired) return "expired";
  if (items.length === 0) return "empty";
  if (items.some((i) => i.status === "queued" || i.status === "uploading" || i.status === "saving")) return "uploading";
  if (items.some((i) => i.status === "failed")) return "failed";
  if (items.some((i) => i.status === "invalid")) return "problem";
  return "done";
}

export type UploadOutcome =
  | { kind: "done"; url: string; asset_id?: string }
  | { kind: "expired" }
  | { kind: "invalid"; message: string; megapixels?: number }
  | { kind: "failed"; message: string }
  /** 资产库上传空间满了：中转另给了一张普通上传的地址，这个文件改传那里（不存进资产库）。 */
  | { kind: "library_full"; quota_bytes?: number; fallback?: { upload_url: string; expires_at: string; max_bytes: number } };

/** 上传中转的回应 → 这个文件怎么样了。状态码见 src/http/upload-relay.ts。 */
export function outcomeOf(status: number, body: string, maxBytes: number): UploadOutcome {
  let json: Record<string, unknown> | undefined;
  try {
    json = record(JSON.parse(body));
  } catch {
    json = undefined;
  }
  if (status === 200 && typeof json?.url === "string") {
    // 存进资产库的会带资产编号（资产库二期）。
    return { kind: "done", url: json.url, ...(typeof json.asset_id === "string" ? { asset_id: json.asset_id } : {}) };
  }
  // 410 票据过期；401 票据无效、里面的凭据被拒或资产库用不了了：都是换一张新地址再传。
  if (status === 410 || status === 401) return { kind: "expired" };
  if (status === 413 && json?.error === "upload_quota_exceeded") {
    const fallbackUrl = json.fallback_upload_url;
    return {
      kind: "library_full",
      ...(typeof json.quota_bytes === "number" ? { quota_bytes: json.quota_bytes } : {}),
      ...(typeof fallbackUrl === "string" && typeof json.fallback_max_bytes === "number"
        ? {
            fallback: {
              upload_url: fallbackUrl,
              expires_at: typeof json.fallback_expires_at === "string" ? json.fallback_expires_at : new Date(Date.now() + 5 * 60_000).toISOString(),
              max_bytes: json.fallback_max_bytes,
            },
          }
        : {}),
    };
  }
  if (status === 413) return { kind: "invalid", message: `over the ${limitLabel(maxBytes)} limit` };
  // 超像素的图片（AssetD 先解出尺寸再拒收）。
  if (status === 422 && json?.error === "image_too_large" && typeof json.max_pixels === "number") {
    const w = typeof json.width === "number" ? json.width : 0;
    const h = typeof json.height === "number" ? json.height : 0;
    return { kind: "invalid", message: pixelLimitMessage(json.max_pixels), ...(w && h ? { megapixels: Math.round((w * h) / 1_000_000) } : {}) };
  }
  // 资产库只收常见格式（AssetD 按内容认）。
  if (status === 415) return { kind: "invalid", message: `${FORMAT_PREFIX} · use JPG, PNG, WEBP, GIF, MP4, MOV, WEBM, MP3, WAV or M4A` };
  if (status === 429) return { kind: "failed", message: "Too many uploads at once. Retry in a minute" };
  if (status === 0) return { kind: "failed", message: "Couldn't reach Atlas Cloud" };
  return { kind: "failed", message: "Upload failed" };
}

/** 交给模型的文字：文件名、类型、尺寸、地址。资产库选来的带上编号（临时地址过期了模型用它再换）。 */
export function filesForModel(items: Array<Pick<UploadItem, "name" | "kind" | "url" | "asset_id" | "saved" | "shape">>): string {
  // 进了资产库的给 asset:// 编号，不给签名地址（验收问题 36，见 assets.ts assetsForModel）；没进的给上传地址。
  const lines = items.map((item) => {
    const kind = item.shape ? `${item.kind}, ${item.shape}` : item.kind;
    return item.asset_id
      ? `- ${item.name} (${kind}, ${item.saved ? "saved to" : "from"} the Asset Library): asset://${item.asset_id}`
      : `- ${item.name} (${kind}): ${item.url}`;
  });
  const fromLibrary = items.some((item) => item.asset_id) ? ` ${ASSET_REF_NOTE}` : "";
  return (
    `The user added ${items.length === 1 ? "1 file" : `${items.length} files`} in the Atlas upload card. ` +
    `Use these as the media inputs for their request (they are already uploaded; do not upload them again).${fromLibrary}\n${lines.join("\n")}`
  );
}

// ---------- 状态和动作 ----------

export interface UploaderDeps {
  app: App;
  render(): void;
  notice(text: string): void;
  /** 当前要显示的一行说明（main.ts 的 notice）。 */
  noticeText(): string | undefined;
  /** 打开资产库选择（设计稿：上传卡里「Choose from Asset Library」，全屏选）。宿主不让卡片调工具时没有它。 */
  openLibrary?(): void;
}

export interface Uploader {
  readonly data: UploadCardData;
  /** 每次状态变化加一，main.ts 据此判断要不要重画。 */
  readonly version: number;
  view(): HTMLElement;
  /** 打开文件选择框。 */
  pick(): void;
  /** 资产库里选好的素材：作为已经传好的文件放进列表。 */
  addPicked(picked: PickedAsset[]): void;
  /** 把传好的文件交给模型（「Use files」）。 */
  useFiles(): Promise<void>;
}

const CONCURRENCY = 2;
// 超过这么多个文件时列表收起，只露前几个。
const COLLAPSE_OVER = 4;
const COLLAPSE_SHOWN = 3;
// 地址还剩这么点时间就先换新的，免得传到一半过期。
const RENEW_MARGIN_MS = 15_000;
const XHR_TIMEOUT_MS = 5 * 60_000;
// 大文件按最慢 64 KB/s 的上行放宽，最多 30 分钟（和服务端 requestTimeout 一致）：存进资产库的视频
// 能到 100 MB，按 2026-10-19 实测的 250~300 KB/s 也要传 6 分钟左右。
const XHR_MIN_BYTES_PER_SECOND = 64 * 1024;
const XHR_MAX_TIMEOUT_MS = 30 * 60_000;
// 连着换了这么多次地址还是被拒（一直 410/401），就停下来让用户点「Upload again」，不再自动重传。
const MAX_AUTO_RENEWALS = 2;
// 按时钟主动换地址，一分钟内最多一次：本机时钟比服务器快时，新地址看起来也「快过期」。
const PROACTIVE_RENEW_GAP_MS = 60_000;
// 换地址失败后隔这么久自动再试一次。2026-10-28 ChatGPT 实测：选完文件时自动换地址失败，
// 紧接着手动点「Upload again」就成功了，原因没抓到，先按偶发处理。
const RENEW_RETRY_DELAY_MS = 1_500;
const THUMB_PX = 96;

let nextId = 0;

/** 本地图片的缩略图和原始尺寸。浏览器解不开的格式（比如有的 HEIC）返回 undefined。 */
async function imageInfo(file: File): Promise<{ thumb: string; width: number; height: number } | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = THUMB_PX / Math.max(width, height, 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * Math.min(1, scale)));
    canvas.height = Math.max(1, Math.round(height * Math.min(1, scale)));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return { thumb: canvas.toDataURL("image/jpeg", 0.8), width, height };
  } catch {
    return undefined;
  }
}

export function createUploader(initial: UploadCardData, deps: UploaderDeps): Uploader {
  let data = initial;
  let version = 0;
  let items: UploadItem[] = (initial.sample_files ?? []).map((f) => ({
    id: `s${nextId++}`,
    name: f.name,
    size: f.size_bytes,
    kind: f.kind,
    status: f.status,
    progress: f.progress ?? (f.status === "done" ? 1 : 0),
    ...(f.url ? { url: f.url, thumb: f.url } : {}),
    ...(f.error ? { error: f.error } : {}),
    ...(f.megapixels ? { megapixels: f.megapixels } : {}),
  }));
  // linkExpired：手上的地址不能用了，要换；gaveUp：自动换了几次都没换到，显示「过期」等用户点。
  // 分开是为了自动重试那一两秒里卡片照常显示上传中，不闪一下「过期」。
  let linkExpired = initial.sample_expired === true || initial.sample_signed_out === true;
  let gaveUp = linkExpired;
  /**
   * 换地址时 Atlas 登录失效了（设计稿 v2「需要重新连接」）。中转回 401 时卡片去换地址，换地址的
   * 工具也被拒，就是用户掉线了；「Reconnect」再换一次，ChatGPT 会自己弹出连接（11-02 实测）。
   */
  let signedOut = initial.sample_signed_out === true;
  let renewing: Promise<boolean> | undefined;
  let renewals = 0;
  let lastRenewAt = 0;
  /** 最近一次换地址失败的原因，显示在「过期」卡上。 */
  let renewError: string | undefined;
  /** 交给模型之后的那组文件；列表一变就清掉，按钮恢复。 */
  let handedOff = "";
  /** 文件多时列表收起，点「+N more files」展开。 */
  let expanded = false;
  /** 上一次选了多少个、超出上限没收进来的有几个（设计稿 v2「超出数量上限」）。 */
  let overflow: { picked: number; added: number } | undefined = initial.sample_overflow;
  /**
   * 资产库上传空间满了（设计稿 06 页 11/02「上传空间已满」）：之后的文件改走普通上传，照样能用在这次
   * 生成里，只是不存进资产库。卡片上留一句说明。
   */
  let libraryFull: { quota_bytes?: number } | undefined = initial.sample_library_full;
  const inflight = new Map<string, XMLHttpRequest>();
  const sample = initial.sample === true;

  const caps = () => deps.app.getHostCapabilities() ?? {};
  const changed = () => {
    version += 1;
    deps.render();
  };

  // 文件选择框放在 body 上，不随卡片重画：选择框开着时卡片可能因为别的文件进度在重画。
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = "image/*,video/*,audio/*";
  input.hidden = true;
  input.addEventListener("change", () => {
    addFiles([...(input.files ?? [])]);
    input.value = "";
  });
  document.body.append(input);

  function pick(): void {
    if (sample) {
      deps.notice("This is a sample card, so nothing is uploaded.");
      return;
    }
    input.click();
  }

  function addFiles(files: File[]): void {
    if (files.length === 0) return;
    if (sample) {
      deps.notice("This is a sample card, so nothing is uploaded.");
      return;
    }
    // 一次选多了：先收前面的，提示多出来的没加（设计稿 v2「超出数量上限」），不再逐个标成不能上传。
    const room = Math.max(0, data.max_files - items.filter((i) => i.status !== "invalid").length);
    overflow = files.length > room ? { picked: files.length, added: room } : undefined;
    for (const file of files.slice(0, room)) {
      const kind = fileKind(file.name, file.type);
      const error = validateFile(file, limitFor(kind, data));
      const item: UploadItem = {
        id: `f${nextId++}`,
        name: file.name,
        size: file.size,
        kind,
        status: error ? "invalid" : "queued",
        progress: 0,
        ...(error ? { error } : {}),
        file,
      };
      items.push(item);
      if (kind === "image" && !error) {
        // 存进资产库的图片先查像素（AssetD 拒收超过上限的），查完才上传；顺带出缩略图。
        const maxPixels = data.library ? data.max_image_pixels : undefined;
        if (maxPixels) item.checking = true;
        void imageInfo(file).then((info) => {
          item.checking = false;
          if (!items.includes(item)) return;
          if (info) {
            item.thumb = info.thumb;
            item.shape = shapeText(info.width, info.height);
          }
          if (info && maxPixels && item.status === "queued" && info.width * info.height > maxPixels) {
            item.status = "invalid";
            item.error = pixelLimitMessage(maxPixels);
            item.megapixels = Math.round((info.width * info.height) / 1_000_000);
          }
          changed();
          void pump();
        });
      }
    }
    changed();
    void pump();
  }

  /**
   * 上传空间满了：中转另给了一张普通上传的地址。换上它，排队的文件按普通上传的上限重新查一遍
   * （超了的标出来），这个文件放回队列重传。
   */
  function fallBackToPlainUpload(fallback: { upload_url: string; expires_at: string; max_bytes: number }): void {
    data = {
      ...data,
      upload_url: fallback.upload_url,
      expires_at: fallback.expires_at,
      max_bytes: fallback.max_bytes,
      library: false,
      max_video_bytes: undefined,
      max_image_pixels: undefined,
    };
    linkExpired = false;
    for (const queued of items) {
      if (queued.status !== "queued" || !queued.file) continue;
      const error = validateFile(queued.file, limitFor(queued.kind, data));
      if (error) {
        queued.status = "invalid";
        queued.error = error;
      }
    }
  }

  function expiresSoon(): boolean {
    const at = Date.parse(data.expires_at);
    return Number.isFinite(at) && at - RENEW_MARGIN_MS <= Date.now();
  }

  /** 换一次上传地址（卡片自己调 atlas_get_upload_url，不经过模型）。失败时记下原因。 */
  function renewOnce(): Promise<boolean> {
    if (renewing) return renewing;
    if (caps().serverTools === undefined) {
      renewError = "This app doesn't let the card ask for a new link";
      return Promise.resolve(false);
    }
    renewing = deps.app
      .callServerTool({ name: UPLOAD_TOOL, arguments: {} })
      .then((result) => {
        if (result.isError) {
          const text = (result.content ?? []).find((block) => block.type === "text");
          renewError = (text && "text" in text ? String(text.text) : "").replace(/^Error:\s*/, "").slice(0, 200) || "Atlas Cloud returned an error";
          signedOut = isSignedOut(renewError);
          return false;
        }
        const next = uploadFromToolResult(result);
        if (!next) {
          renewError = "Atlas Cloud sent back something this card can't read";
          return false;
        }
        data = { ...next, max_files: data.max_files };
        linkExpired = false;
        gaveUp = false;
        signedOut = false;
        renewError = undefined;
        lastRenewAt = Date.now();
        return true;
      })
      .catch((error: unknown) => {
        renewError = thrownErrorText(error) || "Couldn't reach Atlas Cloud";
        signedOut = isSignedOut(renewError, true);
        return false;
      })
      .finally(() => {
        renewing = undefined;
      });
    return renewing;
  }

  /** 换地址，失败了隔一会儿再试一次。掉线了不再试：再调一次 ChatGPT 会再弹一次连接框。 */
  async function renew(): Promise<boolean> {
    if (await renewOnce()) return true;
    if (signedOut) return false;
    console.warn(`[atlas upload card] couldn't get a new upload link: ${renewError ?? "unknown"}; retrying`);
    await new Promise((resolve) => setTimeout(resolve, RENEW_RETRY_DELAY_MS));
    return renewOnce();
  }

  async function pump(): Promise<void> {
    while (inflight.size < CONCURRENCY) {
      const next = items.find((i) => i.status === "queued" && !i.checking);
      if (!next) return;
      if (linkExpired) {
        // 中转说地址过期了（或卡片按时钟判断）：换新地址；连着换了几次都不成就停下，等用户点「Upload again」。
        if (renewals >= MAX_AUTO_RENEWALS) {
          gaveUp = true;
          changed();
          return;
        }
        renewals += 1;
        changed(); // 显示「Waiting for a new link」
        if (!(await renew())) {
          gaveUp = true;
          changed();
          return;
        }
        changed();
        continue;
      }
      if (expiresSoon() && Date.now() - lastRenewAt > PROACTIVE_RENEW_GAP_MS) {
        // 按时钟看快过期了：先换新地址，免得传完才被拒。换不到也不拦着，用手上的地址照传，
        // 真过期了中转会回 410，再走上面那条路。
        lastRenewAt = Date.now();
        await renew();
        changed();
        continue;
      }
      start(next);
    }
  }

  function start(item: UploadItem): void {
    const file = item.file;
    if (!file) return;
    const xhr = new XMLHttpRequest();
    inflight.set(item.id, xhr);
    item.status = "uploading";
    item.progress = 0;
    item.error = undefined;
    const usedUrl = data.upload_url;
    const sep = usedUrl.includes("?") ? "&" : "?";
    xhr.open("POST", `${usedUrl}${sep}filename=${encodeURIComponent(item.name)}`);
    xhr.timeout = Math.min(XHR_MAX_TIMEOUT_MS, Math.max(XHR_TIMEOUT_MS, (file.size / XHR_MIN_BYTES_PER_SECOND) * 1000));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      item.progress = event.loaded / event.total;
      updateSub(item);
    };
    // 字节送完了，中转还要转存到 Atlas，这几秒显示「Saving」。
    xhr.upload.onload = () => {
      item.status = "saving";
      item.progress = 1;
      updateSub(item);
    };
    const finish = (outcome: UploadOutcome) => {
      if (inflight.get(item.id) !== xhr) return;
      inflight.delete(item.id);
      if (!items.includes(item)) return;
      if (outcome.kind === "done") {
        item.status = "done";
        item.url = outcome.url;
        if (outcome.asset_id) {
          item.asset_id = outcome.asset_id;
          item.saved = true;
        }
        renewals = 0;
      } else if (outcome.kind === "expired") {
        // 地址过期：放回队列，换新地址后自动重传。别的文件已经换来新地址时直接用新的重传。
        item.status = "queued";
        item.progress = 0;
        if (usedUrl === data.upload_url) linkExpired = true;
      } else if (outcome.kind === "library_full") {
        libraryFull = { ...(outcome.quota_bytes ? { quota_bytes: outcome.quota_bytes } : {}) };
        item.progress = 0;
        if (outcome.fallback) {
          // 别的文件已经换上普通上传的地址时，直接用手上的重传。
          if (data.library) fallBackToPlainUpload(outcome.fallback);
          item.status = "queued";
          const error = validateFile(file, limitFor(item.kind, data));
          if (error) {
            item.status = "invalid";
            item.error = error;
          }
        } else {
          // 旧版中转没给普通上传的地址：只能标成传不了。
          item.status = "invalid";
          item.error = "Your upload space is full";
        }
      } else {
        item.status = outcome.kind;
        item.error = outcome.message;
        if (outcome.kind === "invalid" && outcome.megapixels) item.megapixels = outcome.megapixels;
      }
      changed();
      void pump();
    };
    xhr.onload = () => finish(outcomeOf(xhr.status, xhr.responseText, limitFor(item.kind, data)));
    xhr.onerror = () => finish(outcomeOf(0, "", limitFor(item.kind, data)));
    xhr.ontimeout = () => finish({ kind: "failed", message: "Upload timed out" });
    xhr.send(file);
    changed();
  }

  function remove(item: UploadItem): void {
    inflight.get(item.id)?.abort();
    inflight.delete(item.id);
    items = items.filter((i) => i !== item);
    changed();
    void pump();
  }

  function cancel(): void {
    if (sample) {
      deps.notice("This is a sample card, so nothing is uploading.");
      return;
    }
    for (const xhr of inflight.values()) xhr.abort();
    inflight.clear();
    items = items.filter((i) => i.status === "done");
    changed();
  }

  function retry(): void {
    if (sample) {
      deps.notice("This is a sample card, so nothing is uploaded.");
      return;
    }
    for (const item of items) {
      if (item.status === "failed") {
        item.status = "queued";
        item.error = undefined;
      }
    }
    changed();
    void pump();
  }

  function uploadAgain(): void {
    if (sample) {
      deps.notice("This is a sample card, so nothing is uploaded.");
      return;
    }
    renewals = 0;
    void renew().then((ok) => {
      changed();
      if (!ok) {
        // 掉线时卡片本身就是「Reconnect」，不用再提示一句。
        if (!signedOut) deps.notice("Couldn't get a new upload link. Try again, or ask in the chat to upload again.");
        return;
      }
      void pump();
    });
  }

  function addPicked(picked: PickedAsset[]): void {
    for (const asset of picked) {
      if (items.some((i) => i.asset_id === asset.asset_id)) continue;
      items.push({
        id: `a${nextId++}`,
        name: asset.label,
        size: 0,
        kind: asset.kind === "3d" ? "other" : asset.kind,
        status: "done",
        progress: 1,
        url: asset.url,
        asset_id: asset.asset_id,
        ...(asset.thumb ? { thumb: asset.thumb } : {}),
        ...(asset.shape ? { shape: asset.shape } : {}),
      });
    }
    changed();
  }

  function chooseAgain(): void {
    items = items.filter((i) => i.status !== "invalid");
    overflow = undefined;
    changed();
    pick();
  }

  /** 「Change files」：清掉这次选的，重新选。 */
  function changeFiles(): void {
    for (const xhr of inflight.values()) xhr.abort();
    inflight.clear();
    items = [];
    overflow = undefined;
    expanded = false;
    changed();
    pick();
  }

  function doneKey(): string {
    return items
      .filter((i) => i.status === "done")
      .map((i) => i.url)
      .join("\n");
  }

  async function useFiles(): Promise<void> {
    if (sample) {
      deps.notice("This is a sample card, so nothing was sent.");
      return;
    }
    const done = items.filter((i) => i.status === "done" && i.url);
    if (done.length === 0) return;
    const names = done.map((i) => i.name).join(", ");
    // 地址已经进了模型上下文时，对话里只写文件名，免得一长串链接；进不去就把地址写进消息。
    const outcome = await handOff(deps.app, filesForModel(done), say.addedInCard(userLang(deps.app), done.length, names));
    if (outcome === "sent" || outcome === "context") {
      handedOff = doneKey();
      changed();
    }
    const claudeNote = prefillNote(deps.app, outcome);
    if (claudeNote) deps.notice(claudeNote);
    else if (outcome === "context") deps.notice("Files are ready. Tell the chat what to make with them.");
    if (outcome === "failed") deps.notice("Couldn't send the files to the chat. Try again.");
    if (outcome === "unsupported") deps.notice("This app can't take files from the card. Ask in the chat for another way to share them.");
  }

  // ---- 视图 ----

  function subText(item: UploadItem): string {
    if (item.asset_id && !item.saved) return "From Asset Library";
    const size = formatBytes(item.size);
    if (item.saved && item.status === "done") return `${size} · Saved to Asset Library`;
    if (linkExpired && (item.status === "queued" || item.status === "uploading")) {
      if (gaveUp) return `${size} · Not uploaded yet`;
      return `${size} · ${signedOut ? "Waiting to reconnect" : "Waiting for a new link"}`;
    }
    switch (item.status) {
      case "queued":
        return `${size} · Waiting`;
      case "uploading":
        return `${size} · ${Math.round(item.progress * 100)}%`;
      case "saving":
        return `${size} · Saving…`;
      case "invalid":
        if (item.megapixels) return `${item.megapixels} MP · ${item.error ?? ""}`;
        if (item.error?.startsWith(FORMAT_PREFIX)) return item.error;
        return `${size} · ${item.error ?? "Upload failed"}`;
      case "failed":
        return `${size} · ${item.error ?? "Upload failed"}`;
      default:
        return size;
    }
  }

  /** 进度只改那一行的字，不重画整张卡（缩略图会闪）。 */
  function updateSub(item: UploadItem): void {
    const el = document.querySelector<HTMLElement>(`[data-upload-sub="${item.id}"]`);
    if (el) el.textContent = subText(item);
    else changed();
  }

  function thumb(item: UploadItem): HTMLElement {
    const box = h("span", { class: "upload-thumb" });
    const icon = () => box.replaceChildren(h("span", { class: "upload-thumb-icon", html: ICONS[item.kind] }));
    if (item.thumb) {
      const img = h("img", { src: item.thumb, alt: "", decoding: "async", referrerpolicy: "no-referrer" });
      img.addEventListener("error", icon, { once: true });
      box.append(img);
    } else {
      icon();
    }
    return box;
  }

  function mark(item: UploadItem): HTMLElement {
    // 已经停下来等用户点「Upload again / Reconnect」：不转圈，免得看起来像在自动处理。
    if (gaveUp && (item.status === "uploading" || item.status === "queued")) {
      return h("span", { class: "upload-mark", html: ICON_WAITING, "aria-label": "Not uploaded yet" });
    }
    if (item.status === "uploading" || item.status === "saving" || item.status === "queued") {
      return h("span", { class: "upload-mark", html: ICON_SPINNER, "aria-label": "Uploading" });
    }
    if (item.status === "done") return h("span", { class: "upload-mark ok", html: ICON_CHECK, "aria-label": "Uploaded" });
    return h("button", {
      type: "button",
      class: "upload-mark upload-remove",
      html: ICON_REMOVE,
      "aria-label": `Remove ${item.name}`,
      onclick: () => remove(item),
    });
  }

  function list(): HTMLElement {
    // 设计稿 v2「超出数量上限」：一次选很多时只露前几个，其余收成一行。出问题的文件总是露出来。
    const collapse = !expanded && items.length > COLLAPSE_OVER;
    const shown = collapse
      ? items.filter((item, i) => i < COLLAPSE_SHOWN || item.status === "invalid" || item.status === "failed")
      : items;
    const hidden = items.length - shown.length;
    return h(
      "ul",
      { class: "upload-list" },
      ...shown.map((item) =>
        h(
          "li",
          { class: `upload-row${item.status === "invalid" || item.status === "failed" ? " bad" : ""}` },
          thumb(item),
          h(
            "span",
            { class: "upload-text" },
            h("span", { class: "upload-name", title: item.name }, item.name),
            h("span", { class: "upload-sub", "data-upload-sub": item.id }, subText(item))
          ),
          mark(item)
        )
      ),
      hidden > 0
        ? h(
            "li",
            { class: "upload-more" },
            h(
              "button",
              {
                type: "button",
                class: "upload-more-btn",
                onclick: () => {
                  expanded = true;
                  changed();
                },
              },
              `+ ${hidden} more file${hidden === 1 ? "" : "s"}`
            )
          )
        : null
    );
  }

  // 设计稿 v2：不做拖拽（拖进卡片会被宿主当成聊天附件），灰底不画虚线，点开选文件；只写大小上限，格式传完再查。
  function chooser(): HTMLElement {
    return h(
      "button",
      { type: "button", class: "upload-drop", onclick: pick },
      h("span", { class: "upload-drop-icon", html: ICON_UPLOAD }),
      h("span", { class: "upload-drop-title" }, "Choose images, videos or audio from your device"),
      h(
        "span",
        { class: "upload-drop-hint" },
        data.max_video_bytes
          ? `Images and audio up to ${limitLabel(data.max_bytes)}, videos up to ${limitLabel(data.max_video_bytes)} · ${data.max_files} files at a time`
          : `Up to ${limitLabel(data.max_bytes)} per file · ${data.max_files} files at a time`
      )
    );
  }

  function overflowNote(): HTMLElement | null {
    if (!overflow) return null;
    return h(
      "p",
      { class: "note" },
      `You picked ${overflow.picked} files. Only the first ${overflow.added} were added — you can add up to ${data.max_files} at a time.`
    );
  }

  function libraryFullNote(): HTMLElement | null {
    if (!libraryFull) return null;
    const space = libraryFull.quota_bytes ? ` (${quotaLabel(libraryFull.quota_bytes)})` : "";
    return h(
      "p",
      { class: "note" },
      `Your upload space${space} is full, so these files weren't saved to your Asset Library. You can still use them for this request.`
    );
  }

  function noticeEl(): HTMLElement | null {
    const text = deps.noticeText();
    return text ? h("p", { class: "note", role: "status" }, text) : null;
  }

  function view(): HTMLElement {
    const phase = uploadPhase(items, gaveUp);
    const done = items.filter((i) => i.status === "done");
    const useLabel = done.length === 1 ? "Use 1 file" : `Use ${done.length} files`;
    const handed = handedOff !== "" && handedOff === doneKey();
    const useButton = (variant: "primary" | "secondary") =>
      handed ? button("Added to chat", variant, () => undefined, { disabled: true }) : button(useLabel, variant, () => void useFiles());

    let body: (HTMLElement | null)[];
    if (phase === "expired" && signedOut) {
      // 选过的文件留在卡上，重新连上后接着传。
      body = [
        head("Reconnect Atlas Cloud", badge("Sign in required", { danger: true })),
        h("p", { class: "desc" }, "Your Atlas Cloud sign-in expired, so these files haven't finished uploading. Reconnect and they'll upload again."),
        items.length > 0 ? list() : null,
        h("div", { class: "actions" }, button("Reconnect", "primary", uploadAgain)),
        h("p", { class: "note" }, RECONNECT_NOTE),
      ];
    } else if (phase === "expired") {
      // 选过的文件留在卡上：用户要看得出是哪几个文件在等，点「Upload again」会接着传它们。
      body = [
        head("Upload link expired", badge("Expired")),
        h("p", { class: "desc" }, "We'll get a new link when you try again."),
        items.length > 0 ? list() : null,
        renewError ? h("p", { class: "note" }, `Couldn't get a new link: ${renewError}`) : null,
        h("div", { class: "actions" }, button("Upload again", "primary", uploadAgain)),
      ];
    } else if (phase === "empty") {
      body = [
        head("Add reference media", null),
        chooser(),
        h("p", { class: "note" }, "Files are saved to your Asset Library. Have a link? Paste it in the chat."),
        h(
          "div",
          { class: "actions" },
          button("Choose files", "primary", pick),
          deps.openLibrary ? button("Asset Library", "secondary", deps.openLibrary) : null
        ),
      ];
    } else {
      const status =
        phase === "uploading"
          ? badge("Uploading", { spinner: true })
          : phase === "done"
            ? badge("Ready", { success: true })
            : phase === "failed"
              ? badge("Upload failed", { danger: true })
              : badge("Can't upload", { danger: true });
      const actions: (HTMLElement | null)[] =
        phase === "uploading"
          ? [button("Cancel", "secondary", cancel)]
          : phase === "done"
            ? [useButton("primary"), overflow ? button("Change files", "secondary", changeFiles) : button("Add more", "secondary", pick)]
            : phase === "failed"
              ? // 设计稿 v2「网络失败」：重传，或者改从资产库选。
                [
                  button("Retry", "primary", retry),
                  done.length > 0 ? useButton("secondary") : null,
                  deps.openLibrary ? button("Asset Library", "secondary", deps.openLibrary) : null,
                ]
              : [done.length > 0 ? useButton("primary") : null, button("Choose again", "secondary", chooseAgain)];
      body = [head("Add reference media", status), list(), overflowNote(), libraryFullNote(), h("div", { class: "actions" }, ...actions)];
    }

    return h("section", { class: "card upload" }, ...body, noticeEl());
  }

  return {
    get data() {
      return data;
    },
    get version() {
      return version;
    },
    view,
    pick,
    addPicked,
    useFiles,
  };
}

const ICON_SPINNER = '<svg class="spin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="28 10"/></svg>';
const ICON_WAITING = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m5 8.2 2 2 4-4.2" fill="none" style="stroke:var(--ac-card-bg,#fff)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_REMOVE = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_UPLOAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5V4.5m0 0-4 4m4-4 4 4M5 14.5v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICONS: Record<UploadKind, string> = {
  image: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h14c.8 0 1.5.7 1.5 1.5v14c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5V5c0-.8.7-1.5 1.5-1.5zm0 1.5v10.4l4.2-4.2c.4-.4 1-.4 1.4 0l2.3 2.3 1.8-1.8c.4-.4 1-.4 1.4 0L19 14.6V5H5zm9.5 1.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" fill="currentColor"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  other: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l5 5v12.4c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1V3.8c0-.6.4-1 1-1zm7.5 1.7V8.3h3.8L13.5 4.5z" fill="currentColor"/></svg>',
};
