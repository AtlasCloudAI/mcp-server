// 上传卡：设计稿「上传 · Upload」。
// 模型调 atlas_get_upload_url 时卡片打开，用户在卡里选文件或拖进来，浏览器直接把字节 POST 到
// 上传中转（地址里的票据就是凭据，见 src/services/upload-ticket.ts），传完拿到公网地址。
// 用户点「Use N files」时把地址交给模型：放进模型上下文，再替用户发一句「用这几个文件」。
// 服务端数据见 src/apps/upload-card.ts。

import type { App } from "@modelcontextprotocol/ext-apps";
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

/** 交给模型的文字：文件名、类型、地址。 */
export function filesForModel(items: Pick<UploadItem, "name" | "kind" | "url">[]): string {
  const lines = items.map((item) => `- ${item.name} (${item.kind}): ${item.url}`);
  return (
    `The user uploaded ${items.length === 1 ? "1 file" : `${items.length} files`} in the Atlas upload card. ` +
    `Use these URLs as the media inputs for their request (they are already uploaded; do not upload them again):\n${lines.join("\n")}`
  );
}

// ---------- 状态和动作 ----------

export interface UploaderDeps {
  app: App;
  render(): void;
  notice(text: string): void;
  /** 当前要显示的一行说明（main.ts 的 notice）。 */
  noticeText(): string | undefined;
}

export interface Uploader {
  readonly data: UploadCardData;
  /** 每次状态变化加一，main.ts 据此判断要不要重画。 */
  readonly version: number;
  view(): HTMLElement;
}

const CONCURRENCY = 2;
// 地址还剩这么点时间就先换新的，免得传到一半过期。
const RENEW_MARGIN_MS = 15_000;
const XHR_TIMEOUT_MS = 5 * 60_000;
// 连着换了这么多次地址还是被拒（一直 410/401），就停下来让用户点「Upload again」，不再自动重传。
const MAX_AUTO_RENEWALS = 2;
// 按时钟主动换地址，一分钟内最多一次：本机时钟比服务器快时，新地址看起来也「快过期」。
const PROACTIVE_RENEW_GAP_MS = 60_000;
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
  let linkExpired = initial.sample_expired === true;
  let renewing: Promise<boolean> | undefined;
  let renewals = 0;
  let lastRenewAt = 0;
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

  /** 换一张新的上传地址（卡片自己调 atlas_get_upload_url，不经过模型）。 */
  function renew(): Promise<boolean> {
    if (renewing) return renewing;
    if (caps().serverTools === undefined) return Promise.resolve(false);
    renewing = deps.app
      .callServerTool({ name: UPLOAD_TOOL, arguments: {} })
      .then((result) => {
        const next = result.isError ? undefined : uploadFromToolResult(result);
        if (!next) return false;
        data = { ...next, max_files: data.max_files };
        linkExpired = false;
        lastRenewAt = Date.now();
        return true;
      })
      .catch(() => false)
      .finally(() => {
        renewing = undefined;
      });
    return renewing;
  }

  async function pump(): Promise<void> {
    while (inflight.size < CONCURRENCY) {
      const next = items.find((i) => i.status === "queued");
      if (!next) return;
      const stale = expiresSoon() && Date.now() - lastRenewAt > PROACTIVE_RENEW_GAP_MS;
      if (linkExpired || stale) {
        if (linkExpired && renewals >= MAX_AUTO_RENEWALS) {
          changed();
          return;
        }
        if (linkExpired) renewals += 1;
        if (!(await renew())) {
          linkExpired = true;
          changed();
          return;
        }
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
      if (!ok) {
        deps.notice("Couldn't get a new upload link. Ask in the chat to upload again.");
        return;
      }
      changed();
      void pump();
    });
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
    const forModel = filesForModel(done);
    let inContext = false;
    if (caps().updateModelContext !== undefined) {
      try {
        const res = await deps.app.updateModelContext({ content: [{ type: "text", text: forModel }] });
        inContext = !(res as { isError?: boolean } | undefined)?.isError;
      } catch {
        inContext = false;
      }
    }
    if (caps().message !== undefined) {
      // 地址已经进了模型上下文时，对话里只写文件名，免得一长串链接；进不去就把地址写进消息。
      const them = done.length === 1 ? "it" : "them";
      const text = inContext
        ? `I've added ${done.length === 1 ? "1 file" : `${done.length} files`} in the Atlas card (${names}). Please use ${them}.`
        : `${forModel}\n\nPlease use ${them}.`;
      try {
        const res = await deps.app.sendMessage({ role: "user", content: [{ type: "text", text }] });
        if (res.isError) throw new Error("rejected");
        handedOff = doneKey();
        changed();
        return;
      } catch {
        if (!inContext) {
          deps.notice("Couldn't send the files to the chat. Try again.");
          return;
        }
      }
    }
    if (inContext) {
      handedOff = doneKey();
      changed();
      deps.notice("Files are ready. Tell the chat what to make with them.");
      return;
    }
    deps.notice("This app can't take files from the card. Ask in the chat for another way to share them.");
  }

  // ---- 视图 ----

  function subText(item: UploadItem): string {
    const size = formatBytes(item.size);
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
    const phase = uploadPhase(items, linkExpired);
    const done = items.filter((i) => i.status === "done");
    const useLabel = done.length === 1 ? "Use 1 file" : `Use ${done.length} files`;
    const handed = handedOff !== "" && handedOff === doneKey();
    const useButton = (variant: "primary" | "secondary") =>
      handed ? button("Added to chat", variant, () => undefined, { disabled: true }) : button(useLabel, variant, () => void useFiles());

    let body: (HTMLElement | null)[];
    if (phase === "expired") {
      body = [
        head("Upload link expired", badge("Expired")),
        h("p", { class: "desc" }, "Upload links last a few minutes. Get a new one and your files will upload again."),
        h("div", { class: "actions" }, button("Upload again", "primary", uploadAgain)),
      ];
    } else if (phase === "empty") {
      body = [head("Add reference media", null), dropZone()];
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
