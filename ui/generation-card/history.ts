// 历史列表卡：设计稿「全屏视图」里的「历史列表」（Your generations）。
// 对话里先是一张列表卡（最多 5 条），点「View all」展开全屏：按状态筛选、加载更多。
// 点某一条就在原地显示那条的生成卡（进度或作品），带返回按钮。

import { type CardMediaKind, type CardState, KIND_LABEL, formatUsd, kindOfUrl, modelLabel, shortId } from "./card.js";
import { ICON_IMAGE, badge, button, h } from "./view.js";

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
  /** 「Reuse prompt」发回对话的提示词。 */
  prompt?: string;
  /** 这一单的输入素材（asset://编号或公开链接），「Reuse prompt」一起交回去。 */
  inputs?: { name: string; ref: string; field?: string }[];
  /** 链接已经用不了的输入文件个数，Reuse 时请用户重新选。 */
  inputs_unavailable?: number;
  /** 这一单的其他参数（尺寸、时长…），Reuse 时一起交回去。 */
  settings?: Record<string, string | number | boolean>;
}

/**
 * 历史详情：失败单的扣费以账单为准。11-12 ChatGPT 回归：Food Motion 失败了，账单里记着扣了 $0.8865
 * （历史接口 billing.amount 同样是 0.8865，列表上写了），查结果接口却回 not_charged，详情卡就写了
 * 「You weren't charged」，列表和详情对不上。账单记了钱、详情又没说扣了，就按账单写扣了多少。
 */
export function withBillingRecord<T extends { state: CardState; price_usd?: number; charge_status?: string }>(
  card: T,
  item: Pick<HistoryCardItem, "price_usd"> | undefined
): T {
  const billed = item?.price_usd;
  if (billed === undefined || !(billed > 0)) return card;
  if (card.state !== "failed" && card.state !== "canceled") return card;
  if (card.charge_status === "charged" || card.charge_status === "partially_charged") {
    return card.price_usd !== undefined && card.price_usd > 0 ? card : { ...card, price_usd: billed };
  }
  if (card.charge_status === "refunded") return card;
  return { ...card, charge_status: "charged", price_usd: billed };
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
const TYPE_ICON: Record<string, string> = { Video: ICON_PLAY, Audio: ICON_WAVE, Image: ICON_IMAGE };
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

/** atlas_list_predictions 结构化结果里的提示词超过 160 字时截成 157 字 + "..."（src/tools/predictions.ts）。 */
export function isTruncatedSnippet(text: string): boolean {
  return text.length >= 160 && text.endsWith("...");
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
    // Cursor 不转 _meta（11-13 实测）：列表行的实扣、详情的「Reuse prompt」都从这里取。提示词在结构化结果里是片段，
    // 截断过的（157 字 + "..."）不当原文用，点开详情时由 atlas_card_status 带回的完整提示词补上。
    const snippet = typeof p.prompt === "string" ? p.prompt.trim() : "";
    const prompt = snippet && !isTruncatedSnippet(snippet) ? snippet : undefined;
    return [
      {
        prediction_id: p.prediction_id,
        model_id: typeof p.model === "string" ? p.model : "",
        state: stateOfStatus(typeof p.status === "string" ? p.status : ""),
        ...(typeof p.created_at === "string" ? { created_at: p.created_at } : {}),
        ...(outputs[0] ? { thumb: { url: outputs[0], kind: kindOfUrl(outputs[0]) } } : {}),
        outputs: outputs.length,
        ...(typeof p.charged_usd === "number" && Number.isFinite(p.charged_usd) ? { price_usd: p.charged_usd } : {}),
        ...(typeof p.error === "string" ? { error: p.error } : {}),
        ...(prompt ? { prompt } : {}),
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
  // 设计稿：失败的写清楚扣没扣钱，还在跑的写费用待定。
  if (item.state === "failed" || item.state === "canceled") parts.push(item.price_usd ? formatUsd(item.price_usd) : "Not charged");
  if (item.state === "queued" || item.state === "running" || item.state === "transfer_pending") parts.push("Cost pending");
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
    // 还没有结果（生成中、失败）：按模型类型给图标，和有结果的行一致，不用通用的文件图标。
    fallback(TYPE_ICON[item.model_type ?? ""] ?? ICON_FILE);
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
    // 失败的、还在跑的也能点开：徽标后面同样带箭头。
    opts.canQuery && item.state !== "succeeded" && item.state !== "canceled"
      ? h("span", { class: "history-chevron", html: ICON_CHEVRON })
      : null,
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
    // 错误放在列表上面：点开一条失败时卡片会闪回列表，放在最底下看起来就像点了没反应（11-12 Jia 复测 P9）。
    view.error ? h("p", { class: "note danger history-error", role: "status" }, view.error) : null,
    rows.length > 0
      ? h("ul", { class: "history-list" }, ...rows.map((item) => rowFor(item, opts, actions)))
      : h("p", { class: "desc" }, view.loading ? "Loading…" : data.state ? "Nothing here yet." : "No generations yet."),
    footer.some(Boolean) ? h("div", { class: "actions" }, ...footer) : null
  );
}

/** 历史详情底部的按钮。keep-download：保留结果卡自己的下载按钮（单个 Download，多张 Download all）。 */
export type DetailButton = "keep-download" | "reuse" | "copy" | "view-request";

/**
 * 历史详情的按钮（设计 11-12 Figma 06 页「历史 · 点开…的记录」）：成功的 Download + Reuse prompt，
 * 失败的 Reuse prompt + View request，生成中只有 View request。卡片不能替用户发消息时 Reuse prompt
 * 换成 Copy prompt。Reuse prompt 不再当结果卡按钮行的第三个按钮。没有提示词的条目（内容过了保留期）
 * 不放这一个按钮。
 */
export function historyDetailButtons(state: string | undefined, hasPrompt: boolean, canMessage: boolean): DetailButton[] {
  const prompt: DetailButton[] = hasPrompt ? [canMessage ? "reuse" : "copy"] : [];
  switch (state) {
    case "queued":
    case "running":
    case "transfer_pending":
      return ["view-request"];
    case "failed":
      return [...prompt, "view-request"];
    case "canceled":
      return [];
    default:
      return ["keep-download", ...prompt];
  }
}

/** 详情页顶上的返回按钮。 */
export function backLink(onBack: () => void): HTMLElement {
  return h("button", { type: "button", class: "history-back", onclick: onBack }, "← All generations");
}
