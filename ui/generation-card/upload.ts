// 上传卡：设计稿「上传 · Upload」。
// 模型调 atlas_get_upload_url 时卡片打开，用户在卡里选文件或拖进来，浏览器直接把字节 POST 到
// 上传中转（地址里的票据就是凭据，见 src/services/upload-ticket.ts），传完拿到公网地址。
// 用户点「Use N files」时把地址交给模型：放进模型上下文，再替用户发一句「用这几个文件」。
// 服务端数据见 src/apps/upload-card.ts。

import type { App } from "@modelcontextprotocol/ext-apps";
import type { PickedAsset } from "./assets.js";
import { handOff } from "./handoff.js";
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
  max_bytes: number;
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
  }>;
  sample_expired?: boolean;
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
  /** 从资产库选来的：地址是临时的，过期了模型用这个编号再换。 */
  asset_id?: string;
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

/** 选进来的文件能不能传；能传返回 undefined，不能传返回显示在文件名下面的原因。 */
export function validateFile(file: { name: string; size: number; type?: string }, maxBytes: number): string | undefined {
  if (fileKind(file.name, file.type) === "other") return "Use an image, video or audio file";
  if (file.size === 0) return "This file is empty";
  if (file.size > maxBytes) return `Over the ${limitLabel(maxBytes)} limit`;
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
  | { kind: "done"; url: string }
  | { kind: "expired" }
  | { kind: "invalid"; message: string }
  | { kind: "failed"; message: string };

/** 上传中转的回应 → 这个文件怎么样了。状态码见 src/http/upload-relay.ts。 */
export function outcomeOf(status: number, body: string, maxBytes: number): UploadOutcome {
  let json: Record<string, unknown> | undefined;
  try {
    json = record(JSON.parse(body));
  } catch {
    json = undefined;
  }
  if (status === 200 && typeof json?.url === "string") return { kind: "done", url: json.url };
  // 410 票据过期；401 票据无效或里面的凭据被拒：都是换一张新地址再传。
  if (status === 410 || status === 401) return { kind: "expired" };
  if (status === 413) return { kind: "invalid", message: `Over the ${limitLabel(maxBytes)} limit` };
  if (status === 429) return { kind: "failed", message: "Too many uploads at once. Retry in a minute" };
  if (status === 0) return { kind: "failed", message: "Couldn't reach Atlas Cloud" };
  return { kind: "failed", message: "Upload failed" };
}

/** 交给模型的文字：文件名、类型、地址。资产库选来的带上编号（临时地址过期了模型用它再换）。 */
export function filesForModel(items: Pick<UploadItem, "name" | "kind" | "url" | "asset_id">[]): string {
  const lines = items.map((item) =>
    item.asset_id ? `- ${item.name} (${item.kind}, from the Asset Library, ${item.asset_id}): ${item.url}` : `- ${item.name} (${item.kind}): ${item.url}`
  );
  const fromLibrary = items.some((item) => item.asset_id)
    ? " Links for Asset Library files are temporary (about 15 minutes); if one has expired, call atlas_use_assets with its asset ID."
    : "";
  return (
    `The user added ${items.length === 1 ? "1 file" : `${items.length} files`} in the Atlas upload card. ` +
    `Use these URLs as the media inputs for their request (they are already uploaded; do not upload them again).${fromLibrary}\n${lines.join("\n")}`
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
// 地址还剩这么点时间就先换新的，免得传到一半过期。
const RENEW_MARGIN_MS = 15_000;
const XHR_TIMEOUT_MS = 5 * 60_000;
// 连着换了这么多次地址还是被拒（一直 410/401），就停下来让用户点「Upload again」，不再自动重传。
const MAX_AUTO_RENEWALS = 2;
// 按时钟主动换地址，一分钟内最多一次：本机时钟比服务器快时，新地址看起来也「快过期」。
const PROACTIVE_RENEW_GAP_MS = 60_000;
// 换地址失败后隔这么久自动再试一次。2026-10-28 ChatGPT 实测：选完文件时自动换地址失败，
// 紧接着手动点「Upload again」就成功了，原因没抓到，先按偶发处理。
const RENEW_RETRY_DELAY_MS = 1_500;
const THUMB_PX = 96;

let nextId = 0;

async function imageThumb(file: File): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = THUMB_PX / Math.max(bitmap.width, bitmap.height, 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * Math.min(1, scale)));
    canvas.height = Math.max(1, Math.round(bitmap.height * Math.min(1, scale)));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.8);
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
  }));
  // linkExpired：手上的地址不能用了，要换；gaveUp：自动换了几次都没换到，显示「过期」等用户点。
  // 分开是为了自动重试那一两秒里卡片照常显示上传中，不闪一下「过期」。
  let linkExpired = initial.sample_expired === true;
  let gaveUp = initial.sample_expired === true;
  let renewing: Promise<boolean> | undefined;
  let renewals = 0;
  let lastRenewAt = 0;
  /** 最近一次换地址失败的原因，显示在「过期」卡上。 */
  let renewError: string | undefined;
  /** 交给模型之后的那组文件；列表一变就清掉，按钮恢复。 */
  let handedOff = "";
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
    let room = data.max_files - items.filter((i) => i.status !== "invalid").length;
    for (const file of files) {
      const kind = fileKind(file.name, file.type);
      let error = validateFile(file, data.max_bytes);
      if (!error && room <= 0) error = `Up to ${data.max_files} files per upload`;
      if (!error) room -= 1;
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
        void imageThumb(file).then((thumb) => {
          if (thumb && items.includes(item)) {
            item.thumb = thumb;
            changed();
          }
        });
      }
    }
    changed();
    void pump();
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
        renewError = undefined;
        lastRenewAt = Date.now();
        return true;
      })
      .catch((error: unknown) => {
        renewError = thrownErrorText(error) || "Couldn't reach Atlas Cloud";
        return false;
      })
      .finally(() => {
        renewing = undefined;
      });
    return renewing;
  }

  /** 换地址，失败了隔一会儿再试一次。 */
  async function renew(): Promise<boolean> {
    if (await renewOnce()) return true;
    console.warn(`[atlas upload card] couldn't get a new upload link: ${renewError ?? "unknown"}; retrying`);
    await new Promise((resolve) => setTimeout(resolve, RENEW_RETRY_DELAY_MS));
    return renewOnce();
  }

  async function pump(): Promise<void> {
    while (inflight.size < CONCURRENCY) {
      const next = items.find((i) => i.status === "queued");
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
    xhr.timeout = XHR_TIMEOUT_MS;
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
        renewals = 0;
      } else if (outcome.kind === "expired") {
        // 地址过期：放回队列，换新地址后自动重传。别的文件已经换来新地址时直接用新的重传。
        item.status = "queued";
        item.progress = 0;
        if (usedUrl === data.upload_url) linkExpired = true;
      } else {
        item.status = outcome.kind;
        item.error = outcome.message;
      }
      changed();
      void pump();
    };
    xhr.onload = () => finish(outcomeOf(xhr.status, xhr.responseText, data.max_bytes));
    xhr.onerror = () => finish(outcomeOf(0, "", data.max_bytes));
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
        deps.notice("Couldn't get a new upload link. Try again, or ask in the chat to upload again.");
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
        kind: asset.kind,
        status: "done",
        progress: 1,
        url: asset.url,
        asset_id: asset.asset_id,
        ...(asset.thumb ? { thumb: asset.thumb } : {}),
      });
    }
    changed();
  }

  function chooseAgain(): void {
    items = items.filter((i) => i.status !== "invalid");
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
    const them = done.length === 1 ? "it" : "them";
    // 地址已经进了模型上下文时，对话里只写文件名，免得一长串链接；进不去就把地址写进消息。
    const outcome = await handOff(deps.app, filesForModel(done), {
      short: `I've added ${done.length === 1 ? "1 file" : `${done.length} files`} in the Atlas card (${names}). Please use ${them}.`,
      ask: `Please use ${them}.`,
    });
    if (outcome === "sent" || outcome === "context") {
      handedOff = doneKey();
      changed();
    }
    if (outcome === "context") deps.notice("Files are ready. Tell the chat what to make with them.");
    if (outcome === "failed") deps.notice("Couldn't send the files to the chat. Try again.");
    if (outcome === "unsupported") deps.notice("This app can't take files from the card. Ask in the chat for another way to share them.");
  }

  // ---- 视图 ----

  function subText(item: UploadItem): string {
    if (item.asset_id) return "From Asset Library";
    const size = formatBytes(item.size);
    if (linkExpired && (item.status === "queued" || item.status === "uploading")) return `${size} · Waiting for a new link`;
    switch (item.status) {
      case "queued":
        return `${size} · Waiting`;
      case "uploading":
        return `${size} · ${Math.round(item.progress * 100)}%`;
      case "saving":
        return `${size} · Saving…`;
      case "invalid":
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
    return h(
      "ul",
      { class: "upload-list" },
      ...items.map((item) =>
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
      )
    );
  }

  function dropZone(): HTMLElement {
    return h(
      "button",
      { type: "button", class: "upload-drop", onclick: pick },
      h("span", { class: "upload-drop-icon", html: ICON_UPLOAD }),
      h("span", { class: "upload-drop-title" }, "Drop files here or ", h("span", { class: "upload-link" }, "browse")),
      h(
        "span",
        { class: "upload-drop-hint" },
        `Images, video or audio · up to ${limitLabel(data.max_bytes)} each · up to ${data.max_files} files`
      )
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
    if (phase === "expired") {
      // 选过的文件留在卡上：用户要看得出是哪几个文件在等，点「Upload again」会接着传它们。
      body = [
        head("Upload link expired", badge("Expired")),
        h("p", { class: "desc" }, "Upload links last a few minutes. Get a new one and your files will upload again."),
        items.length > 0 ? list() : null,
        renewError ? h("p", { class: "note" }, `Couldn't get a new link: ${renewError}`) : null,
        h("div", { class: "actions" }, button("Upload again", "primary", uploadAgain)),
      ];
    } else if (phase === "empty") {
      body = [
        head("Add reference media", null),
        dropZone(),
        deps.openLibrary
          ? h("div", { class: "actions" }, button("Choose from Asset Library", "secondary", deps.openLibrary))
          : null,
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
            ? [useButton("primary"), button("Add more", "secondary", pick)]
            : phase === "failed"
              ? [button("Retry", "primary", retry), done.length > 0 ? useButton("secondary") : null]
              : [done.length > 0 ? useButton("primary") : null, button("Choose again", "secondary", chooseAgain)];
      body = [head("Add reference media", status), list(), h("div", { class: "actions" }, ...actions)];
    }

    const section = h("section", { class: "card upload" }, ...body, noticeEl());
    // 整张卡都能接拖进来的文件；拖动时只切高亮，不重画。
    section.addEventListener("dragover", (event) => {
      event.preventDefault();
      section.classList.add("dragging");
    });
    section.addEventListener("dragleave", (event) => {
      if (!section.contains(event.relatedTarget as Node | null)) section.classList.remove("dragging");
    });
    section.addEventListener("drop", (event) => {
      event.preventDefault();
      section.classList.remove("dragging");
      addFiles([...(event.dataTransfer?.files ?? [])]);
    });
    return section;
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
const ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m5 8.2 2 2 4-4.2" fill="none" style="stroke:var(--ac-card-bg,#fff)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_REMOVE = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_UPLOAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5V4.5m0 0-4 4m4-4 4 4M5 14.5v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICONS: Record<UploadKind, string> = {
  image: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h14c.8 0 1.5.7 1.5 1.5v14c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5V5c0-.8.7-1.5 1.5-1.5zm0 1.5v10.4l4.2-4.2c.4-.4 1-.4 1.4 0l2.3 2.3 1.8-1.8c.4-.4 1-.4 1.4 0L19 14.6V5H5zm9.5 1.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" fill="currentColor"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  other: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l5 5v12.4c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1V3.8c0-.6.4-1 1-1zm7.5 1.7V8.3h3.8L13.5 4.5z" fill="currentColor"/></svg>',
};
