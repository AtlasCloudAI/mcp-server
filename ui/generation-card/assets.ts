// 资产库卡：设计稿「全屏视图」里的「从资产库选取 assets list」和「资产库为空 assets empty」。
// 两个入口：模型调 atlas_search_assets，结果直接显示成这张卡；或者上传卡里点「Choose from Asset Library」，
// 卡片自己调 atlas_search_assets 打开它（全屏），选完回到上传卡。
// 选好后卡片调 atlas_use_assets 换临时原图地址，交给模型（或交回上传卡）。服务端数据见 src/apps/asset-library.ts。

import type { App } from "@modelcontextprotocol/ext-apps";
import { handOff } from "./handoff.js";
import { thrownErrorText } from "./quote.js";
import { button, h } from "./view.js";

export const ASSETS_META_KEY = "atlascloud/assets";
const SEARCH_TOOL = "atlas_search_assets";
const USE_TOOL = "atlas_use_assets";
/** 卡片自己翻页时一页取几个：全屏 6 列，4 行。 */
const PAGE_SIZE = 24;
/** 对话里（非全屏）最多显示两行：平时一行 4 个，窄屏一行 3 个（和 styles.css 的断点一致）。 */
function inlineTiles(): number {
  return window.matchMedia?.("(max-width: 420px)").matches ? 6 : 8;
}

export type AssetKind = "image" | "video" | "audio" | "other";
export type AssetFilter = "image" | "video";

export interface AssetCardItem {
  asset_id: string;
  label: string;
  kind: AssetKind;
  origin: "upload" | "generated" | "input";
  thumb_url?: string;
  preview_url?: string;
  created_at?: string;
  model?: string;
}

export interface AssetCardData {
  view: "assets";
  query?: string;
  media_type?: "image" | "video" | "audio";
  items: AssetCardItem[];
  next_cursor?: string;
  max_pick: number;
  sample?: boolean;
}

/** 换好地址、可以交给模型的素材。 */
export interface PickedAsset {
  asset_id: string;
  label: string;
  kind: AssetKind;
  url: string;
  thumb?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function kindOf(value: unknown): AssetKind {
  return value === "image" || value === "video" || value === "audio" ? value : "other";
}

/** 工具结果 → 资产库卡数据。优先读 _meta，宿主没转过来就从 structuredContent 推。 */
export function assetsFromToolResult(result: unknown): AssetCardData | undefined {
  const r = record(result);
  if (!r) return undefined;
  const fromMeta = record(record(r._meta)?.[ASSETS_META_KEY]);
  if (fromMeta?.view === "assets" && Array.isArray(fromMeta.items)) return fromMeta as unknown as AssetCardData;
  const s = record(r.structuredContent);
  // atlas_use_assets 的结果也有 assets，但没有 count：靠 count 区分。
  if (!s || typeof s.count !== "number" || !Array.isArray(s.assets)) return undefined;
  const items = s.assets.flatMap((entry): AssetCardItem[] => {
    const a = record(entry);
    if (!a || typeof a.asset_id !== "string") return [];
    const origin = a.origin === "upload" || a.origin === "input" ? a.origin : "generated";
    return [
      {
        asset_id: a.asset_id,
        label: typeof a.name === "string" ? a.name : a.asset_id,
        kind: kindOf(a.media_type),
        origin,
        ...(typeof a.thumbnail_url === "string" ? { thumb_url: a.thumbnail_url } : {}),
        ...(typeof a.created_at === "string" ? { created_at: a.created_at } : {}),
      },
    ];
  });
  return { view: "assets", items, ...(typeof s.next_cursor === "string" ? { next_cursor: s.next_cursor } : {}), max_pick: 10 };
}

/** atlas_use_assets 的结果：换到的地址和不可用的编号。 */
export function usedFromToolResult(result: unknown): { assets: Array<{ asset_id: string; url: string }>; missing: string[] } | undefined {
  const s = record(record(result)?.structuredContent);
  if (!s || !Array.isArray(s.assets)) return undefined;
  const assets = s.assets.flatMap((entry) => {
    const a = record(entry);
    return a && typeof a.asset_id === "string" && typeof a.url === "string" ? [{ asset_id: a.asset_id, url: a.url }] : [];
  });
  const missing = Array.isArray(s.missing) ? s.missing.filter((id): id is string => typeof id === "string") : [];
  return { assets, missing };
}

function resultErrorText(result: { content?: Array<{ type: string; text?: unknown }> }): string {
  const text = (result.content ?? []).find((block) => block.type === "text");
  return (text && typeof text.text === "string" ? text.text : "").replace(/^Error:\s*/, "").slice(0, 240);
}

const KIND_WORD: Record<AssetKind, string> = { image: "image", video: "video", audio: "audio", other: "file" };

/** 交给模型的文字：名字、类型、编号、地址。地址是临时的，过期了模型用编号再换。 */
export function assetsForModel(picked: Pick<PickedAsset, "asset_id" | "label" | "kind" | "url">[]): string {
  const lines = picked.map((a) => `- ${a.label} (${KIND_WORD[a.kind]}, ${a.asset_id}): ${a.url}`);
  return (
    `The user picked ${picked.length === 1 ? "1 file" : `${picked.length} files`} from their Atlas Asset Library in the card. ` +
    "Use these URLs as the media inputs for their request. They are temporary (about 15 minutes); if one has expired, " +
    `call atlas_use_assets with its asset ID for a fresh URL:\n${lines.join("\n")}`
  );
}

export interface LibraryDeps {
  app: App;
  render(): void;
  notice(text: string): void;
  noticeText(): string | undefined;
  /** 宿主支持全屏时展开。 */
  expand(): void;
  /** 资产库为空或没找到时的「Upload from device」。 */
  uploadInstead(): void;
  /** 从上传卡打开：选好的素材交回上传卡（由它交给模型）。没有它就自己交给模型。 */
  onPicked?(picked: PickedAsset[]): void;
  /** 从上传卡打开：「Cancel」回到上传卡。 */
  onCancel?(): void;
  /** 自己交给模型之后（全屏时退回对话里，用户才看得到对话）。 */
  onHandedOff?(): void;
}

export interface LibraryViewOptions {
  fullscreen: boolean;
  canExpand: boolean;
}

export interface Library {
  /** 每次状态变化加一，main.ts 据此判断要不要重画。 */
  readonly version: number;
  readonly sample: boolean;
  view(opts: LibraryViewOptions): HTMLElement;
}

const FILTERS: Array<{ label: string; value: AssetFilter | undefined }> = [
  { label: "All", value: undefined },
  { label: "Images", value: "image" },
  { label: "Videos", value: "video" },
];

/** initial 为空时（从上传卡打开）先显示加载中，自己去取第一页。 */
export function createLibrary(initial: AssetCardData | undefined, deps: LibraryDeps): Library {
  let data: AssetCardData = initial ?? { view: "assets", items: [], max_pick: 10 };
  let filter: AssetFilter | undefined = data.media_type === "image" || data.media_type === "video" ? data.media_type : undefined;
  let loading = false;
  let using = false;
  let error: string | undefined;
  /** 选中的素材，按点选顺序。 */
  const selected = new Map<string, AssetCardItem>();
  /** 交给模型的那组编号；选择一变就清掉，按钮恢复。 */
  let handedOff = "";
  let version = 0;
  const sample = data.sample === true;
  // 测试卡片不调接口：筛选在手上的样例里做。
  const sampleItems = sample ? data.items : [];

  const caps = () => deps.app.getHostCapabilities() ?? {};
  const changed = () => {
    version += 1;
    deps.render();
  };
  const selectionKey = () => [...selected.keys()].join(",");

  async function query(next: { filter: AssetFilter | undefined; append: boolean; clearQuery?: boolean }): Promise<void> {
    if (sample) {
      filter = next.filter;
      data = { ...data, items: sampleItems.filter((item) => !filter || item.kind === filter) };
      changed();
      return;
    }
    if (caps().serverTools === undefined) {
      deps.notice("This app doesn't let the card load assets. Ask in the chat instead.");
      return;
    }
    const keepQuery = next.clearQuery ? undefined : data.query;
    loading = true;
    error = undefined;
    filter = next.filter;
    changed();
    try {
      const result = await deps.app.callServerTool({
        name: SEARCH_TOOL,
        arguments: {
          limit: PAGE_SIZE,
          ...(filter ? { media_type: filter } : {}),
          ...(keepQuery ? { query: keepQuery } : {}),
          ...(next.append && data.next_cursor ? { cursor: data.next_cursor } : {}),
        },
      });
      if (result.isError) throw new Error(resultErrorText(result) || "Atlas Cloud returned an error");
      const page = assetsFromToolResult(result);
      if (!page) throw new Error("Atlas Cloud sent back something this card can't read");
      const items = next.append ? [...data.items, ...page.items] : page.items;
      data = { ...page, items, ...(keepQuery ? { query: keepQuery } : {}), max_pick: data.max_pick };
      if (!keepQuery) delete data.query;
    } catch (e) {
      error = thrownErrorText(e) || "Couldn't load your assets. Try again in a moment.";
    } finally {
      loading = false;
      changed();
    }
  }

  function toggle(item: AssetCardItem): void {
    if (selected.has(item.asset_id)) {
      selected.delete(item.asset_id);
    } else {
      if (selected.size >= data.max_pick) {
        deps.notice(`Pick up to ${data.max_pick} files at a time.`);
        return;
      }
      selected.set(item.asset_id, item);
    }
    changed();
  }

  async function use(): Promise<void> {
    const picks = [...selected.values()];
    if (picks.length === 0 || using) return;
    if (sample) {
      if (deps.onPicked) {
        deps.onPicked(picks.map((p) => ({ asset_id: p.asset_id, label: p.label, kind: p.kind, url: p.thumb_url ?? p.preview_url ?? "", ...(p.thumb_url ? { thumb: p.thumb_url } : {}) })));
        return;
      }
      deps.notice("This is a sample card, so nothing was sent.");
      return;
    }
    if (caps().serverTools === undefined) {
      deps.notice("This app doesn't let the card use assets. Ask in the chat to use them.");
      return;
    }
    using = true;
    changed();
    try {
      const result = await deps.app.callServerTool({ name: USE_TOOL, arguments: { asset_ids: picks.map((p) => p.asset_id) } });
      const used = usedFromToolResult(result);
      if (!used || used.assets.length === 0) throw new Error(resultErrorText(result) || "Couldn't get these files ready");
      const byId = new Map(picks.map((p) => [p.asset_id, p]));
      const ready = used.assets.flatMap((u): PickedAsset[] => {
        const p = byId.get(u.asset_id);
        return p ? [{ asset_id: p.asset_id, label: p.label, kind: p.kind, url: u.url, ...(p.thumb_url ? { thumb: p.thumb_url } : {}) }] : [];
      });
      if (used.missing.length > 0) {
        for (const id of used.missing) selected.delete(id);
        deps.notice(`${used.missing.length === 1 ? "1 file is" : `${used.missing.length} files are`} no longer available and ${used.missing.length === 1 ? "was" : "were"} left out.`);
      }
      if (deps.onPicked) {
        deps.onPicked(ready);
        return;
      }
      const labels = ready.map((a) => a.label).join(", ");
      const outcome = await handOff(deps.app, assetsForModel(ready), {
        short: `I've picked ${ready.length === 1 ? "1 file" : `${ready.length} files`} from my Asset Library in the Atlas card (${labels}). Please use ${ready.length === 1 ? "it" : "them"}.`,
        ask: `Please use ${ready.length === 1 ? "it" : "them"}.`,
      });
      if (outcome === "sent" || outcome === "context") {
        handedOff = selectionKey();
        deps.onHandedOff?.();
      }
      if (outcome === "context") deps.notice("Files are ready. Tell the chat what to make with them.");
      if (outcome === "failed") deps.notice("Couldn't send the files to the chat. Try again.");
      if (outcome === "unsupported") deps.notice("This app can't take files from the card. Ask in the chat to use them.");
    } catch (e) {
      deps.notice(thrownErrorText(e) || "Couldn't use these files. Try again in a moment.");
    } finally {
      using = false;
      changed();
    }
  }

  // ---- 视图 ----

  function media(item: AssetCardItem): HTMLElement {
    const box = h("span", { class: "asset-media" });
    const icon = () => box.replaceChildren(h("span", { class: "asset-icon", html: ICONS[item.kind] }));
    if (item.thumb_url) {
      // 不带 Referer：存储的防盗链会拦卡片沙箱的来源（生成卡同一个坑）。
      const img = h("img", { src: item.thumb_url, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
      img.addEventListener("error", icon, { once: true });
      box.append(img);
    } else if (item.kind === "video" && item.preview_url) {
      const video = h("video", { src: `${item.preview_url}#t=0.1`, preload: "metadata", muted: true, playsinline: "", referrerpolicy: "no-referrer" });
      video.addEventListener("error", icon, { once: true });
      box.append(video);
    } else {
      icon();
    }
    return box;
  }

  function tile(item: AssetCardItem): HTMLElement {
    const on = selected.has(item.asset_id);
    return h(
      "li",
      {},
      h(
        "button",
        {
          type: "button",
          class: `asset-tile${on ? " selected" : ""}`,
          "aria-pressed": String(on),
          "aria-label": item.label,
          title: item.label,
          onclick: () => toggle(item),
        },
        media(item),
        item.kind === "video" ? h("span", { class: "asset-play", html: ICONS.video }) : null,
        on ? h("span", { class: "asset-check", html: ICON_CHECK }) : null
      )
    );
  }

  function tabs(): HTMLElement {
    return h(
      "div",
      { class: "history-tabs", role: "tablist" },
      ...FILTERS.map((f) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            class: `history-tab${filter === f.value ? " active" : ""}`,
            "aria-selected": String(filter === f.value),
            disabled: loading,
            onclick: () => void query({ filter: f.value, append: false }),
          },
          f.label
        )
      )
    );
  }

  function empty(): HTMLElement {
    const narrowed = data.query !== undefined || filter !== undefined;
    return h(
      "div",
      { class: "asset-empty" },
      h("span", { class: "asset-empty-icon", html: ICONS.image }),
      h("p", { class: "asset-empty-title" }, narrowed ? (data.query ? `No assets match “${data.query}”.` : "Nothing here yet.") : "Your Asset Library is empty."),
      h(
        "div",
        { class: "actions" },
        narrowed ? button("Show all", "secondary", () => void query({ filter: undefined, append: false, clearQuery: true }), { small: true }) : null,
        button("Upload from device", "secondary", deps.uploadInstead, { small: true })
      )
    );
  }

  function footer(opts: LibraryViewOptions, shown: number): HTMLElement | null {
    const n = selected.size;
    const handed = handedOff !== "" && handedOff === selectionKey();
    const more = data.items.length - shown;
    const left = h("span", { class: "asset-count" }, n > 0 ? `${n} selected` : `Pick up to ${data.max_pick}`);
    const buttons: (HTMLElement | null)[] = [];
    if (!opts.fullscreen && more > 0 && opts.canExpand) buttons.push(button("View all", "secondary", deps.expand));
    else if ((opts.fullscreen || !opts.canExpand) && data.next_cursor) {
      buttons.push(button(loading ? "Loading…" : "Load more", "secondary", () => void query({ filter, append: true }), { disabled: loading }));
    }
    if (handed) buttons.push(button("Added to chat", "primary", () => undefined, { disabled: true }));
    else buttons.push(button(using ? "Getting files…" : n > 0 ? `Use ${n} selected` : "Use selected", "primary", () => void use(), { disabled: n === 0 || using }));
    if (deps.onCancel) buttons.push(button("Cancel", "secondary", deps.onCancel));
    return h("div", { class: "asset-foot" }, left, h("div", { class: "asset-foot-actions" }, ...buttons));
  }

  function view(opts: LibraryViewOptions): HTMLElement {
    // 选择变了（或换了一页）就不再是交给模型的那一组。
    if (handedOff !== "" && handedOff !== selectionKey()) handedOff = "";
    const shown = opts.fullscreen || !opts.canExpand ? data.items : data.items.slice(0, inlineTiles());
    const notice = deps.noticeText();
    const body =
      data.items.length > 0
        ? h("ul", { class: "asset-grid" }, ...shown.map(tile))
        : loading
          ? h("p", { class: "desc" }, "Loading your assets…")
          : error
            ? null
            : empty();
    return h(
      "section",
      { class: `card assets${opts.fullscreen ? " fullscreen" : ""}` },
      h("div", { class: "head" }, h("p", { class: opts.fullscreen ? "title-lg" : "title" }, "Asset Library")),
      data.query
        ? h(
            "p",
            { class: "desc asset-query" },
            `Results for “${data.query}” · `,
            h("button", { type: "button", class: "asset-clear", onclick: () => void query({ filter, append: false, clearQuery: true }) }, "Show all")
          )
        : null,
      tabs(),
      body,
      error ? h("p", { class: "note", role: "status" }, error) : null,
      data.items.length > 0 ? footer(opts, shown.length) : null,
      notice ? h("p", { class: "note", role: "status" }, notice) : null
    );
  }

  if (!initial) void query({ filter: undefined, append: false });

  return {
    get version() {
      return version;
    },
    sample,
    view,
  };
}

const ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="currentColor"/><path d="m4.8 8.2 2.1 2.1 4.3-4.4" fill="none" style="stroke:var(--ac-primary-text,#fff)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICONS: Record<AssetKind, string> = {
  image: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h14c.8 0 1.5.7 1.5 1.5v14c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5V5c0-.8.7-1.5 1.5-1.5zm0 1.5v10.4l4.2-4.2c.4-.4 1-.4 1.4 0l2.3 2.3 1.8-1.8c.4-.4 1-.4 1.4 0L19 14.6V5H5zm9.5 1.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" fill="currentColor"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  other: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l5 5v12.4c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1V3.8c0-.6.4-1 1-1zm7.5 1.7V8.3h3.8L13.5 4.5z" fill="currentColor"/></svg>',
};
