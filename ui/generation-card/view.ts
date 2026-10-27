// 卡片的 DOM。每种状态一个函数，对应 Figma 里的一张卡；交互都交给 main.ts 传进来的 actions。
// 用户数据一律走 textContent / 属性，innerHTML 只放下面这几个固定的 SVG 图标。

import {
  type CardData,
  type CardMedia,
  KIND_LABEL,
  fileNameOf,
  formatClock,
  formatElapsed,
  formatUsd,
  modelLabel,
  perItemPrice,
  shortId,
  typeLabel,
} from "./card.js";

export interface CardActions {
  download(media: CardMedia): void;
  openInAtlas(): void;
  copyLink(url: string): Promise<boolean>;
  refresh(): void;
  keepWaiting(): void;
  tryAgain(): void;
  switchModel(): void;
}

export interface ViewOptions {
  /** 宿主允许卡片调服务端工具（刷新）。 */
  canRefresh: boolean;
  /** 宿主允许卡片往对话里发消息（重试、换模型）。 */
  canMessage: boolean;
  /** 卡片自己等了很久还没结果：显示「Still generating」。 */
  stalled: boolean;
  /** 正在刷新：刷新按钮置灰。 */
  refreshing: boolean;
  /** 刷新出错时的一行说明。 */
  notice?: string;
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.8v14.4c0 .8.9 1.3 1.6.9l11.5-7.2c.6-.4.6-1.4 0-1.8L8.6 3.9C7.9 3.5 7 4 7 4.8z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/></svg>';
const ICON_SPINNER = '<svg class="spin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="28 10"/></svg>';
const ICON_CUBE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 3.8 7.4v9.2l8.2 4.6 8.2-4.6V7.4L12 2.8zm0 2.3 5.9 3.3L12 11.7 6.1 8.4 12 5.1zM5.8 10.1l5.2 2.9v5.8l-5.2-2.9v-5.8zm7.2 8.7V13l5.2-2.9v5.8L13 18.8z" fill="currentColor"/></svg>';
const ICON_IMAGE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h14c.8 0 1.5.7 1.5 1.5v14c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5V5c0-.8.7-1.5 1.5-1.5zm0 1.5v10.4l4.2-4.2c.4-.4 1-.4 1.4 0l2.3 2.3 1.8-1.8c.4-.4 1-.4 1.4 0L19 14.6V5H5zm9.5 1.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" fill="currentColor"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l5 5v12.4c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1V3.8c0-.6.4-1 1-1zm7.5 1.7V8.3h3.8L13.5 4.5z" fill="currentColor"/></svg>';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key === "html") el.innerHTML = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in el && typeof value !== "string") {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

export function button(
  label: string,
  variant: "primary" | "secondary",
  onClick: () => void,
  extra: { small?: boolean; disabled?: boolean } = {}
): HTMLButtonElement {
  return h(
    "button",
    {
      type: "button",
      class: `btn btn-${variant}${extra.small ? " btn-small" : ""}`,
      disabled: extra.disabled === true,
      onclick: onClick,
    },
    label
  );
}

export function badge(label: string, opts: { spinner?: boolean; danger?: boolean } = {}): HTMLElement {
  return h(
    "span",
    { class: `badge${opts.danger ? " danger" : ""}` },
    opts.spinner ? h("span", { html: ICON_SPINNER, style: "display:inline-flex" }) : null,
    label
  );
}

export function head(title: string, badgeEl: HTMLElement | null, large = false): HTMLElement {
  return h("div", { class: "head" }, h("p", { class: large ? "title-lg" : "title" }, title), badgeEl);
}

export function row(label: string, value: string, opts: { mono?: boolean; title?: string; elapsedFrom?: string } = {}): HTMLElement {
  return h(
    "div",
    { class: "row" },
    h("span", { class: "row-label" }, label),
    h(
      "span",
      {
        class: `row-value${opts.mono ? " mono" : ""}`,
        title: opts.title,
        "data-elapsed-from": opts.elapsedFrom,
      },
      value
    )
  );
}

function priceText(card: CardData): string | null {
  return card.price_usd !== undefined ? formatUsd(card.price_usd) : null;
}

function captionText(card: CardData, media: CardMedia, extra: string[] = []): string {
  const parts = [KIND_LABEL[media.kind], modelLabel(card), ...extra];
  const price = priceText(card);
  if (price) parts.push(price);
  return parts.join(" · ");
}

function notice(opts: ViewOptions): HTMLElement | null {
  return opts.notice ? h("p", { class: "note", role: "status" }, opts.notice) : null;
}

function secondsSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, (now - at) / 1000) : null;
}

// ---------- 生成进度 ----------

function progressCard(card: CardData, opts: ViewOptions, actions: CardActions): HTMLElement {
  const title = `${typeLabel(card)} · ${modelLabel(card)}`;
  const price = priceText(card);
  const refresh = opts.canRefresh
    ? button("Refresh", "secondary", actions.refresh, { disabled: opts.refreshing })
    : null;

  if (opts.stalled) {
    return h(
      "section",
      { class: "card" },
      head(title, badge("Still generating", { spinner: true })),
      h("p", { class: "desc" }, "This is taking longer than usual. It hasn't failed."),
      h(
        "div",
        { class: "actions" },
        opts.canRefresh ? button("Keep waiting", "primary", actions.keepWaiting) : null,
        refresh
      ),
      notice(opts)
    );
  }

  const rows: HTMLElement[] = [row("Task", shortId(card.prediction_id), { mono: true, title: card.prediction_id })];
  if (price) rows.push(row("Est. cost", price));
  const now = Date.now();
  if (card.state === "queued") {
    if (card.submitted_at && secondsSince(card.submitted_at, now) !== null) {
      const at = new Date(card.submitted_at);
      rows.push(row("Submitted", at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
    }
  } else {
    const since = secondsSince(card.submitted_at, now);
    if (since !== null) rows.push(row("Running for", formatElapsed(since), { elapsedFrom: card.submitted_at }));
  }

  const label =
    card.state === "queued" ? badge("Queued") : card.state === "transfer_pending" ? badge("Saving", { spinner: true }) : badge("Generating", { spinner: true });

  return h(
    "section",
    { class: "card" },
    head(title, label),
    card.state === "transfer_pending"
      ? h("p", { class: "desc" }, "Your file is ready and is being saved to Atlas.")
      : null,
    h("div", { class: "rows" }, ...rows),
    refresh ? h("div", { class: "actions" }, refresh) : null,
    notice(opts)
  );
}

function failedCard(card: CardData, opts: ViewOptions, actions: CardActions): HTMLElement {
  const kind = typeLabel(card).toLowerCase();
  const what = kind === "generation" ? "this generation" : `this ${kind}`;
  const rows = [row("Task", shortId(card.prediction_id), { mono: true, title: card.prediction_id })];
  if (card.error) rows.push(row("Reason", card.error, { title: card.error }));
  return h(
    "section",
    { class: "card" },
    head(`${typeLabel(card)} · ${modelLabel(card)}`, badge("Failed", { danger: true })),
    h("p", { class: "desc" }, `The model couldn't finish ${what}. You weren't charged.`),
    h("div", { class: "rows" }, ...rows),
    // 有原参数时 Try again 直接重新报价，只要宿主允许调工具；否则要能发消息。
    opts.canMessage || (card.retry && opts.canRefresh)
      ? h(
          "div",
          { class: "actions" },
          button("Try again", "primary", actions.tryAgain),
          opts.canMessage ? button("Switch model", "secondary", actions.switchModel) : null
        )
      : null,
    notice(opts)
  );
}

function canceledCard(card: CardData): HTMLElement {
  return h(
    "section",
    { class: "card" },
    head(`${typeLabel(card)} · ${modelLabel(card)}`, badge("Canceled")),
    h("p", { class: "desc", style: "margin-top:2px" }, "Nothing was charged.")
  );
}

// ---------- 作品 ----------

function resultActions(card: CardData, media: CardMedia, actions: CardActions): HTMLElement {
  return h(
    "div",
    { class: "actions" },
    button("Download", "primary", () => actions.download(media)),
    button("Open in Atlas", "secondary", actions.openInAtlas)
  );
}

/** 预览加载不出来（宿主拦了来源、链接失效）：灰底说明 + 在 Atlas 打开 / 复制链接。 */
function previewBlocked(card: CardData, media: CardMedia, actions: CardActions): HTMLElement {
  const copy = button("Copy link", "secondary", async () => {
    const ok = await actions.copyLink(media.url);
    copy.textContent = ok ? "Copied" : "Couldn't copy";
    setTimeout(() => (copy.textContent = "Copy link"), 1600);
  });
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "placeholder" },
      h("div", {}, h("span", { class: "placeholder-icon", html: ICON_IMAGE }), "Preview isn't available in this app")
    ),
    h("p", { class: "caption" }, captionText(card, media)),
    h("div", { class: "actions" }, button("Open in Atlas", "primary", actions.openInAtlas), copy)
  );
}

function imageCard(card: CardData, media: CardMedia, actions: CardActions, swap: (el: HTMLElement) => void): HTMLElement {
  const img = h("img", {
    src: media.url,
    alt: `${KIND_LABEL[media.kind]} from ${modelLabel(card)}`,
    decoding: "async",
    referrerpolicy: "no-referrer",
  });
  img.addEventListener("error", () => swap(previewBlocked(card, media, actions)), { once: true });
  return h(
    "section",
    { class: "card" },
    h("div", { class: "media" }, img),
    h("p", { class: "caption" }, captionText(card, media)),
    resultActions(card, media, actions)
  );
}

function videoCard(card: CardData, media: CardMedia, actions: CardActions, swap: (el: HTMLElement) => void): HTMLElement {
  const caption = h("p", { class: "caption" }, captionText(card, media));
  const video = h("video", { src: `${media.url}#t=0.1`, preload: "metadata", playsinline: "", referrerpolicy: "no-referrer" });
  video.playsInline = true;
  const play = h("button", {
    type: "button",
    class: "play-overlay",
    "aria-label": "Play video",
    html: ICON_PLAY,
    onclick: () => {
      play.remove();
      video.controls = true;
      void video.play().catch(() => undefined);
    },
  });
  video.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      caption.textContent = captionText(card, media, [`${Math.round(video.duration)} s`]);
    }
  });
  video.addEventListener("error", () => swap(previewBlocked(card, media, actions)), { once: true });
  return h(
    "section",
    { class: "card" },
    h("div", { class: "media" }, video, play),
    caption,
    resultActions(card, media, actions)
  );
}

/** 装饰性波形：按链接算出固定的高低，不解码音频（跨域读不到数据，也没必要）。 */
function waveHeights(seed: string, count: number): number[] {
  let x = 2166136261;
  for (let i = 0; i < seed.length; i++) x = Math.imul(x ^ seed.charCodeAt(i), 16777619);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    x = Math.imul(x ^ (x >>> 15), 2246822507) ^ Math.imul(x ^ (x >>> 13), 3266489909);
    const r = ((x >>> 0) % 1000) / 1000;
    const envelope = 0.55 + 0.45 * Math.sin((i / count) * Math.PI);
    out.push(Math.round(6 + r * 18 * envelope));
  }
  return out;
}

function audioCard(card: CardData, media: CardMedia, actions: CardActions, swap: (el: HTMLElement) => void): HTMLElement {
  const audio = h("audio", { src: media.url, preload: "metadata", referrerpolicy: "no-referrer" });
  const time = h("span", { class: "audio-time" }, "0:00 / –:––");
  const bars = waveHeights(media.url, 30).map((height) => h("span", { style: `height:${height}px` }));
  const wave = h("div", { class: "wave", role: "slider", "aria-label": "Seek", tabindex: "0" }, ...bars);
  const play = h("button", {
    type: "button",
    class: "audio-play paused",
    "aria-label": "Play audio",
    html: ICON_PLAY,
    onclick: () => (audio.paused ? void audio.play().catch(() => undefined) : audio.pause()),
  });

  const paint = () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const progress = duration > 0 ? audio.currentTime / duration : 0;
    const played = Math.round(progress * bars.length);
    bars.forEach((bar, i) => bar.classList.toggle("played", i < played));
    time.textContent = `${formatClock(audio.currentTime)} / ${duration > 0 ? formatClock(duration) : "–:––"}`;
    wave.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  };
  audio.addEventListener("loadedmetadata", paint);
  audio.addEventListener("timeupdate", paint);
  audio.addEventListener("play", () => {
    play.innerHTML = ICON_PAUSE;
    play.classList.remove("paused");
    play.setAttribute("aria-label", "Pause audio");
  });
  const onStop = () => {
    play.innerHTML = ICON_PLAY;
    play.classList.add("paused");
    play.setAttribute("aria-label", "Play audio");
  };
  audio.addEventListener("pause", onStop);
  audio.addEventListener("ended", onStop);
  audio.addEventListener("error", () => swap(previewBlocked(card, media, actions)), { once: true });
  wave.addEventListener("click", (event) => {
    const rect = wave.getBoundingClientRect();
    if (Number.isFinite(audio.duration) && rect.width > 0) {
      audio.currentTime = ((event.clientX - rect.left) / rect.width) * audio.duration;
    }
  });
  wave.addEventListener("keydown", (event) => {
    if (!Number.isFinite(audio.duration)) return;
    if (event.key === "ArrowRight") audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    if (event.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 5);
  });

  const price = priceText(card);
  return h(
    "section",
    { class: "card" },
    h("p", { class: "title-lg" }, `${KIND_LABEL[media.kind]} · ${modelLabel(card)}`),
    h("div", { class: "audio-player" }, play, wave, time, audio),
    price ? h("p", { class: "caption" }, price) : null,
    resultActions(card, media, actions)
  );
}

function fileCard(card: CardData, media: CardMedia, actions: CardActions): HTMLElement {
  const is3d = media.kind === "3d";
  const ext = fileNameOf(media.url, "").split(".").pop()?.toUpperCase();
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: `placeholder${is3d ? " tall" : ""}` },
      h(
        "div",
        {},
        h("span", { html: is3d ? ICON_CUBE : ICON_FILE }),
        is3d ? "3D preview isn't available in this app" : fileNameOf(media.url, "Result file")
      )
    ),
    h("p", { class: "caption" }, captionText(card, media, ext ? [ext] : [])),
    resultActions(card, media, actions)
  );
}

function tileMedia(media: CardMedia, alt: string): HTMLElement {
  const box = h("div", { class: "tile-media" });
  const fail = () => {
    box.replaceChildren("Preview isn't available");
  };
  if (media.kind === "image") {
    const img = h("img", { src: media.url, alt, decoding: "async", loading: "lazy", referrerpolicy: "no-referrer" });
    img.addEventListener("error", fail, { once: true });
    box.append(img);
  } else if (media.kind === "video") {
    const video = h("video", {
      src: `${media.url}#t=0.1`,
      preload: "metadata",
      muted: true,
      playsinline: "",
      referrerpolicy: "no-referrer",
    });
    video.addEventListener("error", fail, { once: true });
    box.append(video);
  } else {
    box.append(h("span", { html: media.kind === "3d" ? ICON_CUBE : ICON_FILE, style: "width:40px;height:40px;display:block" }));
  }
  return box;
}

const MAX_TILES = 8;

function carousel(card: CardData, actions: CardActions): HTMLElement {
  const each = perItemPrice(card);
  const shown = card.media.slice(0, MAX_TILES);
  const tiles = shown.map((media, i) => {
    const label = `${KIND_LABEL[media.kind]} ${i + 1}`;
    const sub = [modelLabel(card), each !== undefined ? formatUsd(each) : null].filter(Boolean).join(" · ");
    return h(
      "article",
      { class: "tile" },
      tileMedia(media, `${label} from ${modelLabel(card)}`),
      h("p", { class: "tile-title" }, label),
      h("p", { class: "tile-sub" }, sub),
      button("Download", "secondary", () => actions.download(media), { small: true })
    );
  });
  // 工作流按次计费，单张价没意义，总价写在下面；超过 8 个的去 Atlas 看全部。
  const footerBits: (Node | string)[] = [];
  if (each === undefined && card.price_usd !== undefined) footerBits.push(`Total ${formatUsd(card.price_usd)}`);
  if (card.media.length > MAX_TILES) footerBits.push(`${card.media.length - MAX_TILES} more in Atlas`);
  return h(
    "section",
    { "aria-label": `${card.media.length} results` },
    h("div", { class: "carousel" }, ...tiles),
    footerBits.length > 0 || card.media.length > MAX_TILES
      ? h(
          "div",
          { class: "carousel-footer" },
          ...footerBits.map((bit) => h("span", {}, bit)),
          button("Open in Atlas", "secondary", actions.openInAtlas, { small: true })
        )
      : null
  );
}

function expiredCard(actions: CardActions): HTMLElement {
  return h(
    "section",
    { class: "card" },
    head("Result link expired", badge("Expired"), true),
    h("p", { class: "desc lg" }, "Your file is still saved."),
    h("div", { class: "actions", style: "margin-top:16px" }, button("Get a new link", "primary", actions.openInAtlas))
  );
}

function resultCard(card: CardData, actions: CardActions, swap: (el: HTMLElement) => void): HTMLElement {
  if (card.media_expired) return expiredCard(actions);
  if (card.media.length === 0) {
    return h(
      "section",
      { class: "card" },
      head(`${typeLabel(card)} · ${modelLabel(card)}`, badge("Done")),
      h("p", { class: "desc" }, "The task finished without a file to show."),
      h("div", { class: "actions" }, button("Open in Atlas", "secondary", actions.openInAtlas))
    );
  }
  if (card.media.length > 1) return carousel(card, actions);
  const media = card.media[0];
  switch (media.kind) {
    case "image":
      return imageCard(card, media, actions, swap);
    case "video":
      return videoCard(card, media, actions, swap);
    case "audio":
      return audioCard(card, media, actions, swap);
    default:
      return fileCard(card, media, actions);
  }
}

// ---------- 入口 ----------

export function loadingCard(predictionId?: string): HTMLElement {
  return h(
    "section",
    { class: "card" },
    head("Atlas Cloud", badge("Checking", { spinner: true })),
    predictionId
      ? h("div", { class: "rows" }, row("Task", shortId(predictionId), { mono: true, title: predictionId }))
      : null
  );
}

export function errorCard(message: string, opts: ViewOptions, actions: CardActions): HTMLElement {
  return h(
    "section",
    { class: "card" },
    head("Couldn't load this task", badge("Error", { danger: true })),
    h("p", { class: "desc" }, message),
    opts.canRefresh ? h("div", { class: "actions" }, button("Refresh", "secondary", actions.refresh)) : null
  );
}

export function renderCard(card: CardData, opts: ViewOptions, actions: CardActions): HTMLElement {
  const holder = h("div");
  const swap = (el: HTMLElement) => holder.replaceChildren(el);
  let view: HTMLElement;
  switch (card.state) {
    case "queued":
    case "running":
    case "transfer_pending":
      view = progressCard(card, opts, actions);
      break;
    case "failed":
      view = failedCard(card, opts, actions);
      break;
    case "canceled":
      view = canceledCard(card);
      break;
    default:
      view = resultCard(card, actions, swap);
  }
  holder.append(view);
  return holder;
}

/** 「Running for」每秒走字，不重画整张卡（不然视频、音频会被打断）。 */
export function tickElapsed(root: HTMLElement): void {
  const now = Date.now();
  root.querySelectorAll<HTMLElement>("[data-elapsed-from]").forEach((el) => {
    const since = secondsSince(el.dataset.elapsedFrom, now);
    if (since !== null) el.textContent = formatElapsed(since);
  });
}
