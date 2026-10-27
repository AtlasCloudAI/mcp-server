// 历史列表卡：设计稿「全屏视图」里的「历史列表」（Your generations）。
// 对话里先是一张列表卡（最多 5 条），点「View all」展开全屏：按状态筛选、加载更多。
// 点某一条就在原地显示那条的生成卡（进度或作品），带返回按钮。

import { type CardMediaKind, type CardState, KIND_LABEL, formatUsd, kindOfUrl, modelLabel, shortId } from "./card.js";
import { badge, button, h } from "./view.js";

export const HISTORY_META_KEY = "atlascloud/history";

export type HistoryFilter = "running" | "succeeded" | "failed";

export interface HistoryCardItem {
  prediction_id: string;
  model_id: string;
  model_name?: string;
  model_type?: string;
  state: CardState;
  created_at?: string;
  thumb?: { url: string; kind: CardMediaKind };
  outputs: number;
  price_usd?: number;
  error?: string;
}

export interface HistoryCardData {
  view: "history";
  page: number;
  size: number;
  total: number;
  has_more: boolean;
  state?: HistoryFilter;
  items: HistoryCardItem[];
  /** 测试卡片的样例列表：点开条目打开对应的测试卡片，不能筛选、加载更多。 */
  sample?: boolean;
}

export interface HistoryView {
  data: HistoryCardData;
  /** 正在换筛选或加载更多。 */
  loading: boolean;
  error?: string;
}

export interface HistoryActions {
  expand(): void;
  setFilter(filter: HistoryFilter | undefined): void;
  loadMore(): void;
  open(predictionId: string): void;
}

export interface HistoryOptions {
  fullscreen: boolean;
  /** 宿主支持全屏。 */
  canExpand: boolean;
  /** 宿主允许卡片调工具（筛选、加载更多、点开单条）。 */
  canQuery: boolean;
}

const INLINE_ROWS = 5;

const ICON_CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
const ICON_WAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l5 5v12.4c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1V3.8c0-.6.4-1 1-1zm7.5 1.7V8.3h3.8L13.5 4.5z" fill="currentColor"/></svg>';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isHistoryData(value: unknown): value is HistoryCardData {
  const r = record(value);
  return !!r && r.view === "history" && Array.isArray(r.items);
}

function stateOfStatus(status: string): CardState {
  const s = status.toLowerCase();
  if (["completed", "succeeded", "success"].includes(s)) return "succeeded";
  if (["queued", "created", "waiting"].includes(s)) return "queued";
  if (["starting", "processing", "running", "pending", "in_progress"].includes(s)) return "running";
  if (s === "canceled" || s === "cancelled") return "canceled";
  return "failed";
}

/** 工具结果 → 历史卡数据。优先读 _meta，宿主没转过来就从 structuredContent 推。 */
export function historyFromToolResult(result: unknown): HistoryCardData | undefined {
  const r = record(result);
  if (!r) return undefined;
  const fromMeta = record(r._meta)?.[HISTORY_META_KEY];
  if (isHistoryData(fromMeta)) return fromMeta;
  const structured = record(r.structuredContent);
  if (!structured || !Array.isArray(structured.predictions)) return undefined;
  const items = structured.predictions.flatMap((entry): HistoryCardItem[] => {
    const p = record(entry);
    if (!p || typeof p.prediction_id !== "string") return [];
    const outputs = Array.isArray(p.outputs) ? p.outputs.filter((u): u is string => typeof u === "string") : [];
    return [
      {
        prediction_id: p.prediction_id,
        model_id: typeof p.model === "string" ? p.model : "",
        state: stateOfStatus(typeof p.status === "string" ? p.status : ""),
        ...(typeof p.created_at === "string" ? { created_at: p.created_at } : {}),
        ...(outputs[0] ? { thumb: { url: outputs[0], kind: kindOfUrl(outputs[0]) } } : {}),
        outputs: outputs.length,
        ...(typeof p.error === "string" ? { error: p.error } : {}),
      },
    ];
  });
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    view: "history",
    page: num(structured.page, 1),
    size: num(structured.size, items.length || 10),
    total: num(structured.total, items.length),
    has_more: structured.has_more === true,
    items,
  };
}

/** 「Today 12:06」「Yesterday 18:20」「Oct 21, 17:42」。 */
export function whenLabel(iso: string | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  // 卡片文案是英文，日期也固定用英文格式、24 小时制（设计稿：Today 12:06）。
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((day(now) - day(at)) / 86_400_000);
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

function itemTitle(item: HistoryCardItem): string {
  const type = item.model_type && item.model_type !== "Text" ? item.model_type : item.thumb ? KIND_LABEL[item.thumb.kind] : "Generation";
  const name = item.model_name || item.model_id ? modelLabel(item) : shortId(item.prediction_id);
  return `${type} · ${name}`;
}

function itemSub(item: HistoryCardItem): string {
  const parts = [whenLabel(item.created_at)];
  if (item.outputs > 1) parts.push(`${item.outputs} files`);
  if (item.price_usd !== undefined && item.state === "succeeded") parts.push(formatUsd(item.price_usd));
  return parts.filter(Boolean).join(" · ");
}

function thumb(item: HistoryCardItem): HTMLElement {
  const box = h("span", { class: "history-thumb" });
  const fallback = (icon: string) => box.replaceChildren(h("span", { class: "history-thumb-icon", html: icon }));
  const media = item.thumb;
  if (media?.kind === "image") {
    // 不带 Referer：ChatGPT 卡片沙箱的来源会被我们存储的防盗链拦掉（另一会话实测）。
    const img = h("img", { src: media.url, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => fallback(ICON_FILE), { once: true });
    box.append(img);
  } else if (media?.kind === "video") {
    const video = h("video", { src: `${media.url}#t=0.1`, preload: "metadata", muted: true, playsinline: "", referrerpolicy: "no-referrer" });
    video.addEventListener("error", () => fallback(ICON_PLAY), { once: true });
    box.append(video, h("span", { class: "history-thumb-play", html: ICON_PLAY }));
  } else if (media?.kind === "audio") {
    fallback(ICON_WAVE);
  } else {
    fallback(ICON_FILE);
  }
  return box;
}

function statusMark(item: HistoryCardItem): HTMLElement {
  switch (item.state) {
    case "queued":
      return badge("Queued");
    case "running":
    case "transfer_pending":
      return badge("Generating", { spinner: true });
    case "failed":
      return badge("Failed", { danger: true });
    case "canceled":
      return badge("Canceled");
    default:
      return h("span", { class: "history-chevron", html: ICON_CHEVRON });
  }
}

function rowFor(item: HistoryCardItem, opts: HistoryOptions, actions: HistoryActions): HTMLElement {
  const label = `${itemTitle(item)}, ${itemSub(item)}`;
  const content = [
    thumb(item),
    h("span", { class: "history-text" }, h("span", { class: "history-title" }, itemTitle(item)), h("span", { class: "history-sub" }, itemSub(item))),
    statusMark(item),
  ];
  // 宿主不让卡片调工具时点不开单条，只做展示。
  return opts.canQuery
    ? h("li", {}, h("button", { type: "button", class: "history-row", "aria-label": label, onclick: () => actions.open(item.prediction_id) }, ...content))
    : h("li", {}, h("div", { class: "history-row" }, ...content));
}

const FILTERS: Array<{ label: string; value: HistoryFilter | undefined }> = [
  { label: "All", value: undefined },
  { label: "Running", value: "running" },
  { label: "Done", value: "succeeded" },
  { label: "Failed", value: "failed" },
];

export function renderHistory(view: HistoryView, opts: HistoryOptions, actions: HistoryActions): HTMLElement {
  const { data } = view;
  const rows = opts.fullscreen ? data.items : data.items.slice(0, INLINE_ROWS);
  const tabs =
    opts.fullscreen && opts.canQuery
      ? h(
          "div",
          { class: "history-tabs", role: "tablist" },
          ...FILTERS.map((filter) =>
            h(
              "button",
              {
                type: "button",
                role: "tab",
                class: `history-tab${data.state === filter.value ? " active" : ""}`,
                "aria-selected": String(data.state === filter.value),
                disabled: view.loading,
                onclick: () => actions.setFilter(filter.value),
              },
              filter.label
            )
          )
        )
      : null;

  const more = data.items.length - rows.length + (data.has_more ? 1 : 0);
  const footer: (HTMLElement | null)[] = [];
  if (!opts.fullscreen && more > 0) {
    footer.push(
      opts.canExpand
        ? button("View all", "secondary", actions.expand)
        : opts.canQuery && data.has_more
          ? button("Load more", "secondary", actions.loadMore, { disabled: view.loading })
          : null
    );
  }
  if (opts.fullscreen && data.has_more && opts.canQuery) {
    footer.push(button(view.loading ? "Loading…" : "Load more", "secondary", actions.loadMore, { disabled: view.loading }));
  }

  return h(
    "section",
    { class: `card history${opts.fullscreen ? " fullscreen" : ""}` },
    h(
      "div",
      { class: "head" },
      h("p", { class: opts.fullscreen ? "title-lg" : "title" }, "Your generations"),
      h("span", { class: "history-count" }, data.total === 1 ? "1 task" : `${data.total} tasks`)
    ),
    tabs,
    rows.length > 0
      ? h("ul", { class: "history-list" }, ...rows.map((item) => rowFor(item, opts, actions)))
      : h("p", { class: "desc" }, view.loading ? "Loading…" : data.state ? "Nothing here yet." : "No generations yet."),
    view.error ? h("p", { class: "note", role: "status" }, view.error) : null,
    footer.some(Boolean) ? h("div", { class: "actions" }, ...footer) : null
  );
}

/** 详情页顶上的返回按钮。 */
export function backLink(onBack: () => void): HTMLElement {
  return h("button", { type: "button", class: "history-back", onclick: onBack }, "← All generations");
}
