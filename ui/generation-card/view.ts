// 卡片的 DOM。每种状态一个函数，对应 Figma 里的一张卡；交互都交给 main.ts 传进来的 actions。
// 用户数据一律走 textContent / 属性，innerHTML 只放下面这几个固定的 SVG 图标。

import {
  type CardData,
  type CardMedia,
  KIND_LABEL,
  RATE_LIMIT_WAIT_MS,
  RECONNECT_NOTE,
  fileNameOf,
  formatClock,
  formatElapsed,
  formatUsd,
  isModelUnavailable,
  isRateLimited,
  isTemplate,
  modelLabel,
  perItemPrice,
  readableReason,
  shortId,
  typeLabel,
} from "./card.js";

// 设计稿 v2（10-29）：结果卡只留「下载」和「查看记录」；想接着改就在对话里说。
export interface CardActions {
  download(media: CardMedia): void;
  /** 多个结果一起下载（设计稿「Download all」）。 */
  downloadAll(media: CardMedia[]): void;
  /** 「View in Atlas」「View request」：在 Atlas 打开这一单。 */
  openInAtlas(): void;
  /** 「View all N」：宿主支持时全屏看全部结果。 */
  expand(): void;
  /** 从全部结果返回：退出全屏。 */
  collapse(): void;
  refresh(): void;
  keepWaiting(): void;
  /** 失败后「Edit and re-quote」：按原参数重新报价，用户在报价卡上改或确认。 */
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
  /** 刷新时发现 Atlas 登录失效了：显示「Reconnect Atlas Cloud」，停止自己刷新。 */
  signedOut: boolean;
  /** 正在刷新：刷新按钮置灰。 */
  refreshing: boolean;
  /** 刷新出错时的一行说明。 */
  notice?: string;
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.8v14.4c0 .8.9 1.3 1.6.9l11.5-7.2c.6-.4.6-1.4 0-1.8L8.6 3.9C7.9 3.5 7 4 7 4.8z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/></svg>';
const ICON_SPINNER = '<svg class="spin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="28 10"/></svg>';
const ICON_CUBE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 3.8 7.4v9.2l8.2 4.6 8.2-4.6V7.4L12 2.8zm0 2.3 5.9 3.3L12 11.7 6.1 8.4 12 5.1zM5.8 10.1l5.2 2.9v5.8l-5.2-2.9v-5.8zm7.2 8.7V13l5.2-2.9v5.8L13 18.8z" fill="currentColor"/></svg>';
export const ICON_IMAGE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h14c.8 0 1.5.7 1.5 1.5v14c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5V5c0-.8.7-1.5 1.5-1.5zm0 1.5v10.4l4.2-4.2c.4-.4 1-.4 1.4 0l2.3 2.3 1.8-1.8c.4-.4 1-.4 1.4 0L19 14.6V5H5zm9.5 1.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" fill="currentColor"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5m0 0L5 7m3 3 3-3M3 12.5h10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const ICON_FILE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l5 5v12.4c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1V3.8c0-.6.4-1 1-1zm7.5 1.7V8.3h3.8L13.5 4.5z" fill="currentColor"/></svg>';

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

export function badge(
  label: string,
  opts: { spinner?: boolean; danger?: boolean; success?: boolean; warn?: boolean } = {}
): HTMLElement {
  return h(
    "span",
    { class: `badge${opts.danger ? " danger" : ""}${opts.success ? " success" : ""}${opts.warn ? " warn" : ""}` },
    opts.spinner ? h("span", { html: ICON_SPINNER, style: "display:inline-flex" }) : null,
    label
  );
}

/** 「Retry in 30 s」：到点前置灰、每秒走字（tickTimers），到点变成 Retry。 */
export function retryButton(at: number, onClick: () => void, now = Date.now()): HTMLButtonElement {
  const el = button("Retry", "secondary", onClick);
  el.dataset.retryAt = String(at);
  paintRetry(el, now);
  return el;
}

function paintRetry(el: HTMLButtonElement, now: number): void {
  const left = Math.ceil((Number(el.dataset.retryAt) - now) / 1000);
  if (Number.isFinite(left) && left > 0) {
    el.textContent = `Retry in ${left} s`;
    el.disabled = true;
    return;
  }
  el.textContent = "Retry";
  el.disabled = false;
  delete el.dataset.retryAt;
}

export function head(title: string, badgeEl: HTMLElement | null, large = false): HTMLElement {
  return h("div", { class: "head" }, h("p", { class: large ? "title-lg" : "title" }, title), badgeEl);
}

export function row(
  label: string,
  value: string,
  opts: { mono?: boolean; title?: string; elapsedFrom?: string; wrap?: boolean } = {}
): HTMLElement {
  return h(
    "div",
    { class: "row" },
    h("span", { class: "row-label" }, label),
    h(
      "span",
      {
        class: `row-value${opts.mono ? " mono" : ""}${opts.wrap ? " wrap" : ""}`,
        title: opts.title,
        "data-elapsed-from": opts.elapsedFrom,
      },
      value
    )
  );
}

/** 出了结果但还没结算：写「Cost pending」，不写价格也不写 $0（需求文档 6.3、设计稿 v2「待结算」）。 */
function costPending(card: CardData): boolean {
  return card.charge_status === "pending" && card.state === "succeeded";
}

function priceText(card: CardData): string | null {
  if (costPending(card)) return "Cost pending";
  return card.price_usd !== undefined ? formatUsd(card.price_usd) : null;
}

/**
 * 失败类卡片上那句扣费说明（需求文档 6.3：失败要写清费用状态）。老网关没有
 * charge_status 时沿用「没扣费」：平台规则是失败不收费。
 */
function chargeSentence(card: CardData): string {
  // 扣了 $0 就是没扣：不写「You were charged $0.00」（11-12 ChatGPT 回归，Seedance 失败单）。
  if (card.price_usd === 0 && (card.charge_status === "charged" || card.charge_status === "partially_charged")) {
    return "You weren't charged.";
  }
  const price = card.price_usd !== undefined ? formatUsd(card.price_usd) : null;
  switch (card.charge_status) {
    case "partially_charged":
      return price ? `You were charged ${price} for the part that ran.` : "You were charged for the part that ran.";
    case "charged":
      return price ? `You were charged ${price}.` : "You were charged.";
    case "refunded":
      return "Your charge was refunded.";
    case "pending":
      return "The charge is still being settled.";
    default:
      return "You weren't charged.";
  }
}

/**
 * 结果下面那一行（设计稿 v2「Image · Seedream 5.0 Pro · 2048 × 2048 · $0.04」）：类型、模型、
 * 主要参数、价格；没结算时价格换成「Cost pending」小标签。lead 替换开头的类型词（多张时写「4 images」）。
 */
function caption(
  card: CardData,
  media: CardMedia | undefined,
  opts: { extra?: string[]; lead?: string; bare?: boolean } = {}
): HTMLElement {
  const lead = opts.bare ? [] : [opts.lead ?? (media ? KIND_LABEL[media.kind] : typeLabel(card)), modelLabel(card)];
  const parts = [...lead, ...(card.settings ?? []), ...(opts.extra ?? [])];
  const pending = costPending(card);
  if (!pending && card.price_usd !== undefined) parts.push(formatUsd(card.price_usd));
  return h(
    "p",
    { class: "caption" },
    parts.join(" · "),
    pending ? h("span", { class: "badge caption-badge" }, "Cost pending") : null
  );
}

function notice(opts: ViewOptions): HTMLElement | null {
  return opts.notice ? h("p", { class: "note", role: "status" }, opts.notice) : null;
}

/** 参数小标签（设计稿：1080p · 10 s · 16:9 · Audio）。没有就不占位置。 */
export function chips(settings: string[] | undefined): HTMLElement | null {
  if (!settings || settings.length === 0) return null;
  return h("div", { class: "chips" }, ...settings.map((label) => h("span", { class: "chip" }, label)));
}

function secondsSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, (now - at) / 1000) : null;
}

// ---------- 生成进度 ----------

/** 进度卡标题：「Video · Dreamina Seedance 2.5」；模板写「Image ads · Marketing Studio」（设计稿 v2「模板执行中」）。 */
function progressTitle(card: CardData): string {
  return isTemplate(card) ? `${modelLabel(card)} · Marketing Studio` : `${typeLabel(card)} · ${modelLabel(card)}`;
}

function progressCard(card: CardData, opts: ViewOptions, actions: CardActions): HTMLElement {
  const title = progressTitle(card);
  const price = priceText(card);
  const refresh = opts.canRefresh
    ? button("Refresh", "secondary", actions.refresh, { disabled: opts.refreshing })
    : null;
  // 设计稿 v2：排队中、生成中加「View in Atlas」，可以去 Atlas 看这条记录。
  const viewInAtlas = button("View in Atlas", "secondary", actions.openInAtlas);

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
    chips(card.settings),
    card.state === "transfer_pending"
      ? h("p", { class: "desc" }, "Your file is ready and is being saved to Atlas.")
      : null,
    h("div", { class: "rows" }, ...rows),
    h("div", { class: "actions" }, refresh, viewInAtlas),
    notice(opts)
  );
}

/**
 * 设计稿 v2「需要重新连接」：刷新时 Atlas 登录失效了。已经提交的任务照常在跑，重新连接后接着查
 * 这一条。「Reconnect」就是再查一次：ChatGPT 见到这次调用被 401 挡下会自己弹出连接（11-02 实测），
 * 连上之后卡片接着刷新。
 */
/** 「Your video is」「Your task is」：不把「类型 · 模型名」标题拼进句子里。 */
function signedOutSubject(card: CardData): string {
  const kind = typeLabel(card).toLowerCase();
  return isTemplate(card) || kind === "generation" ? "Your task is" : `Your ${kind} is`;
}

function signedOutCard(card: CardData, opts: ViewOptions, actions: CardActions): HTMLElement {
  return h(
    "section",
    { class: "card" },
    head("Reconnect Atlas Cloud", badge("Sign in required", { danger: true })),
    h(
      "p",
      { class: "desc" },
      `Your Atlas Cloud sign-in expired. ${signedOutSubject(card)} still running, and nothing was lost. Reconnect to check on it.`
    ),
    h("div", { class: "rows" }, row("Task", shortId(card.prediction_id), { mono: true, title: card.prediction_id })),
    opts.canRefresh ? h("div", { class: "actions" }, button("Reconnect", "primary", actions.refresh, { disabled: opts.refreshing })) : null,
    h("p", { class: "note" }, RECONNECT_NOTE),
    notice(opts)
  );
}

/** 失败卡第一次画出来的时间：限流的 Retry 从这里起等 30 秒（没有完成时间时用）。 */
const firstSeen = new Map<string, number>();

function retryAtFor(card: CardData, now: number): number {
  const done = card.completed_at ? Date.parse(card.completed_at) : NaN;
  if (Number.isFinite(done)) return done + RATE_LIMIT_WAIT_MS;
  if (!firstSeen.has(card.prediction_id)) firstSeen.set(card.prediction_id, now);
  return firstSeen.get(card.prediction_id)! + RATE_LIMIT_WAIT_MS;
}

/** 设计稿「请求太频繁」：上游限流，等一会儿再试。 */
function rateLimitedCard(card: CardData, opts: ViewOptions, actions: CardActions, canRetry: boolean): HTMLElement {
  return h(
    "section",
    { class: "card" },
    head("Too many requests", badge("Rate limited", { warn: true })),
    h("p", { class: "desc" }, `${modelLabel(card)} is getting too many requests. ${chargeSentence(card)} Try again in a moment.`),
    h("div", { class: "rows" }, row("Task", shortId(card.prediction_id), { mono: true, title: card.prediction_id })),
    canRetry ? h("div", { class: "actions" }, retryButton(retryAtFor(card, Date.now()), actions.tryAgain)) : null,
    notice(opts)
  );
}

/**
 * 失败卡的「Task」和「Reason」两行。确认时就被拒、没有任务号的不画 Task；原因换成能看懂的一句、可以折行，
 * 原话放悬停提示。原来原因一长，整列被撑宽，任务号被挤到卡片外面去了（验收问题 33）。
 */
function failureRows(card: CardData): HTMLElement[] {
  const rows: HTMLElement[] = [];
  if (card.prediction_id) rows.push(row("Task", shortId(card.prediction_id), { mono: true, title: card.prediction_id }));
  if (card.error) rows.push(row("Reason", readableReason(card.error), { title: card.error, wrap: true }));
  return rows;
}

/** 设计稿「模型暂时不可用」：重试或换模型。 */
function unavailableCard(card: CardData, opts: ViewOptions, actions: CardActions, canRetry: boolean): HTMLElement {
  // 上游原话（ServerOverloaded、router not found）用户看不懂，正文已经说清楚，不再单列原因行；原话留在悬停提示里。
  const rows = card.prediction_id ? [row("Task", shortId(card.prediction_id), { mono: true, title: card.prediction_id })] : [];
  return h(
    "section",
    { class: "card" },
    head("Model unavailable", badge("Unavailable", { danger: true })),
    h("p", { class: "desc", title: card.error }, `${modelLabel(card)} is temporarily unavailable. ${chargeSentence(card)}`),
    rows.length > 0 ? h("div", { class: "rows" }, ...rows) : null,
    canRetry
      ? h(
          "div",
          { class: "actions" },
          button("Retry", "primary", actions.tryAgain),
          opts.canMessage ? button("Switch model", "secondary", actions.switchModel) : null
        )
      : null,
    notice(opts)
  );
}

function failedCard(card: CardData, opts: ViewOptions, actions: CardActions): HTMLElement {
  // 有原参数时直接重新报价，只要宿主允许调工具；否则要能发消息。
  const canRetry = opts.canMessage || (card.retry !== undefined && opts.canRefresh);
  if (isRateLimited(card.error)) return rateLimitedCard(card, opts, actions, canRetry);
  if (isModelUnavailable(card.error)) return unavailableCard(card, opts, actions, canRetry);
  const kind = typeLabel(card).toLowerCase();
  const what = kind === "generation" ? "this generation" : `this ${kind}`;
  const rows = failureRows(card);
  // 设计稿 v2：按钮改成「修改后重新报价」和「查看记录」。重新报价出一张新报价卡，在那上面改或确认。
  return h(
    "section",
    { class: "card" },
    head(progressTitle(card), badge("Failed", { danger: true })),
    h("p", { class: "desc" }, `The model couldn't finish ${what}. ${chargeSentence(card)}`),
    rows.length > 0 ? h("div", { class: "rows" }, ...rows) : null,
    h(
      "div",
      { class: "actions" },
      canRetry ? button("Edit and re-quote", "primary", actions.tryAgain) : null,
      button("View request", canRetry ? "secondary" : "primary", actions.openInAtlas)
    ),
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
// 设计稿 v2（10-29）：结果卡只留「Download」和「View request」；参数和价格写在图下面一行。

function resultActions(media: CardMedia, actions: CardActions): HTMLElement {
  return h(
    "div",
    { class: "actions" },
    button("Download", "primary", () => actions.download(media)),
    button("View request", "secondary", actions.openInAtlas)
  );
}

const PREVIEW_WORD: Record<CardMedia["kind"], string> = { image: "image", video: "video", audio: "audio", "3d": "model", other: "file" };

/**
 * 预览加载不出来（宿主拦了来源、链接一时打不开）：文件已经生成好了，可以重试预览或直接下载
 * （设计稿 v2「预览加载失败」）。
 */
function previewFailed(card: CardData, media: CardMedia, actions: CardActions, retry: () => void): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "placeholder" },
      h(
        "div",
        {},
        h("span", { class: "placeholder-icon", html: ICON_IMAGE }),
        `Your ${PREVIEW_WORD[media.kind]} is ready, but the preview didn't load.`
      )
    ),
    caption(card, media),
    h(
      "div",
      { class: "actions" },
      button("Retry preview", "primary", retry),
      button("Download", "secondary", () => actions.download(media))
    )
  );
}

function imageCard(card: CardData, media: CardMedia, actions: CardActions, fail: () => void): HTMLElement {
  const img = h("img", {
    src: media.url,
    alt: `${KIND_LABEL[media.kind]} from ${modelLabel(card)}`,
    decoding: "async",
    referrerpolicy: "no-referrer",
  });
  img.addEventListener("error", fail, { once: true });
  const frame = h("div", { class: "media" }, img);
  // 方图、竖图高度会被 420px 封顶，框却还占满卡片宽度，两侧露出框底色（深色模式下是两条深色边，
  // 11-11 Claude C4）。和竖版视频一样：框按图片比例收窄并居中，宽图不受影响。
  img.addEventListener(
    "load",
    () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0 && img.naturalHeight * 4 > img.naturalWidth * 3) {
        frame.classList.add("portrait");
        frame.style.setProperty("--media-ratio", String(img.naturalWidth / img.naturalHeight));
      }
    },
    { once: true }
  );
  return h("section", { class: "card" }, frame, caption(card, media), resultActions(media, actions));
}

/** 参数里已经有时长（10 s）就不再补视频读出来的时长。 */
function hasDuration(card: CardData): boolean {
  return (card.settings ?? []).some((label) => /^\d+(\.\d+)?\s?s$/.test(label));
}

function videoCard(card: CardData, media: CardMedia, actions: CardActions, fail: () => void): HTMLElement {
  let line = caption(card, media);
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
  const frame = h("div", { class: "media" }, video, play);
  video.addEventListener("loadedmetadata", () => {
    // 竖版视频不塞进横版框：框收窄到视频本身的宽度（高度上限见样式），两侧不留黑边。
    if (video.videoWidth > 0 && video.videoHeight > video.videoWidth) {
      frame.classList.add("portrait");
      frame.style.setProperty("--media-ratio", String(video.videoWidth / video.videoHeight));
    }
    if (!hasDuration(card) && Number.isFinite(video.duration) && video.duration > 0) {
      const next = caption(card, media, { extra: [`${Math.round(video.duration)} s`] });
      line.replaceWith(next);
      line = next;
    }
  });
  video.addEventListener("error", fail, { once: true });
  return h("section", { class: "card" }, frame, line, resultActions(media, actions));
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

// 卡片每次重绘（轮询、提示、宿主改尺寸）都会重建界面。<audio> 不挂在页面上，旧的那个重绘后
// 还在播，新画出来的播放器却停在 0:00（11-11 Claude G2）。所以同一个地址只建一个 <audio>，
// 重绘时把事件改绑到新界面上，按它此刻的播放状态画。
const audioElements = new Map<string, { audio: HTMLAudioElement; listeners?: AbortController }>();

function sharedAudio(url: string): { audio: HTMLAudioElement; signal: AbortSignal } {
  let entry = audioElements.get(url);
  if (!entry) {
    entry = { audio: h("audio", { src: url, preload: "metadata", referrerpolicy: "no-referrer" }) as HTMLAudioElement };
    audioElements.set(url, entry);
  }
  entry.listeners?.abort();
  entry.listeners = new AbortController();
  return { audio: entry.audio, signal: entry.listeners.signal };
}

function audioCard(card: CardData, media: CardMedia, actions: CardActions, fail: () => void): HTMLElement {
  const { audio, signal } = sharedAudio(media.url);
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
  const onPlay = () => {
    play.innerHTML = ICON_PAUSE;
    play.classList.remove("paused");
    play.setAttribute("aria-label", "Pause audio");
  };
  const onStop = () => {
    play.innerHTML = ICON_PLAY;
    play.classList.add("paused");
    play.setAttribute("aria-label", "Play audio");
  };
  audio.addEventListener("loadedmetadata", paint, { signal });
  audio.addEventListener("timeupdate", paint, { signal });
  audio.addEventListener("play", onPlay, { signal });
  audio.addEventListener("pause", onStop, { signal });
  audio.addEventListener("ended", onStop, { signal });
  audio.addEventListener("error", fail, { once: true, signal });
  // 重绘接上一个正在播（或播到一半）的元素：照它现在的样子画，不从 0:00 开始。
  paint();
  if (!audio.paused) onPlay();
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

  // 标题已经写了类型和模型，下面那行只写参数和价格（设计稿「32 s · $0.15」）。
  return h(
    "section",
    { class: "card" },
    h("p", { class: "title-lg" }, `${KIND_LABEL[media.kind]} · ${modelLabel(card)}`),
    h("div", { class: "audio-player" }, play, wave, time, audio),
    caption(card, media, { bare: true }),
    resultActions(media, actions)
  );
}

/** 3D 和其他文件：聊天里看不了，给文件名、格式和下载（设计稿 v2「3D」：去掉预览图，改成文件 + 下载）。 */
function fileCard(card: CardData, media: CardMedia, actions: CardActions): HTMLElement {
  const is3d = media.kind === "3d";
  const name = fileNameOf(media.url, is3d ? "3D model" : "Result file");
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase() : undefined;
  const price = priceText(card);
  const sub = [is3d ? "3D model" : "File", modelLabel(card), ext, price].filter(Boolean).join(" · ");
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "file-row" },
      h("span", { class: "file-icon", html: is3d ? ICON_CUBE : ICON_FILE }),
      h("span", { class: "file-text" }, h("span", { class: "file-name", title: name }, name), h("span", { class: "file-sub" }, sub))
    ),
    h("p", { class: "note" }, `This app can't preview ${is3d ? "3D models" : "this file"}. Download to view.`),
    resultActions(media, actions)
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

/** 对话里最多摆 4 格：2–4 个两列排，5 个以上第 4 格写「+N」（设计稿 v2「多张」）。 */
const GRID_SHOWN = 4;

/**
 * 正在看「全部结果」的任务。切全屏时宿主会通知显示模式变了，卡片整张重画；记在这里，
 * 重画出来还是全部结果，不会跳回四格。
 */
const showingAll = new Set<string>();

const PLURAL: Record<CardMedia["kind"], string> = { image: "images", video: "videos", audio: "audio files", "3d": "3D models", other: "files" };

/** 「4 images」「3 videos」；类型混着的写「5 results」。 */
function countLabel(media: CardMedia[]): string {
  const kinds = new Set(media.map((m) => m.kind));
  return `${media.length} ${kinds.size === 1 ? PLURAL[media[0]!.kind] : "results"}`;
}

/**
 * 多个结果（需求文档 6.3「按网格展示，允许分别预览和下载」）。卡里不滑动：2–4 个两列网格 +
 * 「Download all」；5 个以上摆 4 格、最后一格写「+N」，点「View all N」看全部（宿主支持时全屏），
 * 全部结果里每格能单独下载。点任何一格打开那一个结果的完整卡片。
 */
function resultGrid(card: CardData, actions: CardActions, swap: (el: HTMLElement) => void): HTMLElement {
  const total = card.media.length;
  const many = total > GRID_SHOWN;
  const lead = countLabel(card.media);

  const grid = (): HTMLElement => {
    const tiles = card.media.slice(0, GRID_SHOWN).map((media, i) => {
      const more = many && i === GRID_SHOWN - 1 ? total - GRID_SHOWN : 0;
      const label = `${KIND_LABEL[media.kind]} ${i + 1}`;
      return h(
        "button",
        {
          type: "button",
          class: "tile-open",
          "aria-label": more ? `View all ${total}` : `Open ${label}`,
          onclick: () => (more ? showAll() : focus(media, i, grid)),
        },
        tileMedia(media, `${label} from ${modelLabel(card)}`),
        more ? h("span", { class: "tile-more" }, `+${more}`) : null
      );
    });
    return h(
      "section",
      { class: "card results", "aria-label": lead },
      h("div", { class: "results-grid" }, ...tiles),
      caption(card, undefined, { lead }),
      h(
        "div",
        { class: "actions" },
        many
          ? button(`View all ${total}`, "primary", showAll)
          : button("Download all", "primary", () => actions.downloadAll(card.media)),
        button("View request", "secondary", actions.openInAtlas)
      )
    );
  };

  const all = (): HTMLElement => {
    const tiles = card.media.map((media, i) => {
      const label = `${KIND_LABEL[media.kind]} ${i + 1}`;
      return h(
        "article",
        { class: "tile" },
        h(
          "button",
          { type: "button", class: "tile-open", "aria-label": `Open ${label}`, onclick: () => focus(media, i, all) },
          tileMedia(media, `${label} from ${modelLabel(card)}`)
        ),
        h(
          "div",
          { class: "tile-bar" },
          h("span", { class: "tile-label" }, label),
          h("button", {
            type: "button",
            class: "tile-download",
            "aria-label": `Download ${label}`,
            html: ICON_DOWNLOAD,
            onclick: () => actions.download(media),
          })
        )
      );
    });
    return h(
      "div",
      {},
      h(
        "button",
        {
          type: "button",
          class: "history-back",
          onclick: () => {
            showingAll.delete(card.prediction_id);
            actions.collapse();
            swap(grid());
          },
        },
        "← Back"
      ),
      h(
        "section",
        { class: "card results", "aria-label": lead },
        head(lead, null),
        h("div", { class: "results-grid all" }, ...tiles),
        caption(card, undefined, { lead }),
        h("div", { class: "actions" }, button("Download all", "primary", () => actions.downloadAll(card.media)))
      )
    );
  };

  const showAll = (): void => {
    showingAll.add(card.prediction_id);
    actions.expand();
    swap(all());
  };

  const focus = (media: CardMedia, index: number, from: () => HTMLElement): void => {
    // 工作流按次计费，单张价没意义；单模型多张按张计费才写单价。
    const one = { ...card, media: [media], price_usd: perItemPrice(card) };
    const show = (): void => {
      const back = h("button", { type: "button", class: "history-back", onclick: () => swap(from()) }, `← All ${total} results`);
      const single = singleResult(one, media, actions, show);
      single.setAttribute("aria-label", `${KIND_LABEL[media.kind]} ${index + 1} of ${total}`);
      swap(h("div", {}, back, single));
    };
    show();
  };

  return showingAll.has(card.prediction_id) ? all() : grid();
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

/**
 * 一个结果的完整卡片。reshow：重画这张卡（「Retry preview」按它重来一遍）；预览出错时先换成
 * 「预览加载失败」。
 */
function singleResult(card: CardData, media: CardMedia, actions: CardActions, reshow: () => void): HTMLElement {
  const holder = h("div");
  const fail = () => holder.replaceChildren(previewFailed(card, media, actions, reshow));
  let view: HTMLElement;
  switch (media.kind) {
    case "image":
      view = imageCard(card, media, actions, fail);
      break;
    case "video":
      view = videoCard(card, media, actions, fail);
      break;
    case "audio":
      view = audioCard(card, media, actions, fail);
      break;
    default:
      view = fileCard(card, media, actions);
  }
  holder.append(view);
  return holder;
}

function resultCard(card: CardData, actions: CardActions, swap: (el: HTMLElement) => void): HTMLElement {
  if (card.media_expired) return expiredCard(actions);
  if (card.media.length === 0) {
    return h(
      "section",
      { class: "card" },
      head(`${typeLabel(card)} · ${modelLabel(card)}`, badge("Done")),
      h("p", { class: "desc" }, "The task finished without a file to show."),
      h("div", { class: "actions" }, button("View request", "secondary", actions.openInAtlas))
    );
  }
  if (card.media.length > 1) return resultGrid(card, actions, swap);
  const show = (): void => swap(singleResult(card, card.media[0]!, actions, show));
  return singleResult(card, card.media[0]!, actions, show);
}

// ---------- 入口 ----------

export function loadingCard(predictionId?: string): HTMLElement {
  return h(
    "section",
    { class: "card" },
    // 不写 Checking：设计稿里 Checking 只给「不确定有没有提交」那一种状态（11-11 Claude D2）。
    head("Atlas Cloud", badge("Loading", { spinner: true })),
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
      view = opts.signedOut ? signedOutCard(card, opts, actions) : progressCard(card, opts, actions);
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

/**
 * 每秒走字，不重画整张卡（不然视频、音频会被打断）：「Running for」、报价有效期倒计时、
 * 「Retry in 30 s」。
 */
export function tickTimers(root: HTMLElement): void {
  const now = Date.now();
  root.querySelectorAll<HTMLElement>("[data-elapsed-from]").forEach((el) => {
    const since = secondsSince(el.dataset.elapsedFrom, now);
    if (since !== null) el.textContent = formatElapsed(since);
  });
  root.querySelectorAll<HTMLElement>("[data-countdown-to]").forEach((el) => {
    const at = Date.parse(el.dataset.countdownTo ?? "");
    if (Number.isFinite(at)) el.textContent = formatClock(Math.max(0, at - now) / 1000);
  });
  root.querySelectorAll<HTMLButtonElement>("button[data-retry-at]").forEach((el) => paintRetry(el, now));
}
