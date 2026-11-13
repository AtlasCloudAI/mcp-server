// 资产库卡：设计稿「全屏视图」里的「从资产库选取 assets list」和「资产库为空 assets empty」。
// 两个入口：模型调 atlas_search_assets，结果直接显示成这张卡；或者上传卡里点「Choose from Asset Library」，
// 卡片自己调 atlas_search_assets 打开它（全屏），选完回到上传卡。
// 选好后卡片调 atlas_use_assets 换临时原图地址，交给模型（或交回上传卡）。服务端数据见 src/apps/asset-library.ts。

import type { App } from "@modelcontextprotocol/ext-apps";
import { isLopsided } from "../../src/apps/card-params.js";
import { handOff } from "./handoff.js";
import { prefillNote, say, userLang } from "./voice.js";
import { RECONNECT_NOTE, isSignedOut } from "./card.js";
import { thrownErrorText } from "./quote.js";
import { type UploadItem, type UploadKind, type Uploader, ICON_SPINNER, ICON_UPLOAD, createUploader } from "./upload.js";
import { badge, button, h, head } from "./view.js";

export const ASSETS_META_KEY = "atlascloud/assets";
const SEARCH_TOOL = "atlas_search_assets";
const USE_TOOL = "atlas_use_assets";
/** 卡片自己翻页时一页取几个：全屏 6 列，4 行。 */
const PAGE_SIZE = 24;
/** 缩略图过期换地址时最多往下翻几页（每页 50 个）。 */
const REFRESH_PAGES = 6;
/** 对话里（非全屏）最多显示两行：平时一行 4 个，窄屏一行 3 个（和 styles.css 的断点一致）。 */
function inlineTiles(): number {
  return window.matchMedia?.("(max-width: 420px)").matches ? 6 : 8;
}

export type AssetKind = "image" | "video" | "audio" | "3d" | "other";
// 设计稿 v2 的筛选按资产库二期：图片、视频、音频、3D、角色、模板。角色和模板不是单个文件
// （没有能直接交给模型的地址），选中后怎么用还没定，先不放。
export type AssetFilter = "image" | "video" | "audio" | "3d";

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
  /** 这个词一个都没搜到，列的是最近的素材。 */
  unmatched_query?: string;
  media_type?: AssetFilter;
  items: AssetCardItem[];
  next_cursor?: string;
  max_pick: number;
  /** 资产库没开通（充值后才能用）。 */
  locked?: boolean;
  sample?: boolean;
  /** 测试卡片：显示「需要重新连接」。 */
  sample_signed_out?: boolean;
}

/** 换好地址、可以交给模型的素材。 */
export interface PickedAsset {
  asset_id: string;
  label: string;
  kind: AssetKind;
  url: string;
  thumb?: string;
  /** 图片的尺寸和横竖（「1600×1200, landscape (4:3)」）：模型看不到图，要竖屏时据此先说清楚。 */
  shape?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function kindOf(value: unknown): AssetKind {
  return value === "image" || value === "video" || value === "audio" || value === "3d" ? value : "other";
}

const FILTER_VALUES = new Set<unknown>(["image", "video", "audio", "3d"]);

/** 工具结果 → 资产库卡数据。优先读 _meta，宿主没转过来就从 structuredContent 推。 */
export function assetsFromToolResult(result: unknown): AssetCardData | undefined {
  const r = record(result);
  if (!r) return undefined;
  const fromMeta = record(record(r._meta)?.[ASSETS_META_KEY]);
  if (fromMeta?.view === "assets" && Array.isArray(fromMeta.items)) return fromMeta as unknown as AssetCardData;
  const s = record(r.structuredContent);
  // atlas_use_assets 的结果也有 assets，但没有 count：靠 count 区分。
  if (!s || typeof s.count !== "number" || !Array.isArray(s.assets)) return undefined;
  if (s.activated === false) return { view: "assets", items: [], max_pick: 10, locked: true };
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
  return {
    view: "assets",
    items,
    ...(typeof s.next_cursor === "string" ? { next_cursor: s.next_cursor } : {}),
    ...(typeof s.unmatched_query === "string" ? { unmatched_query: s.unmatched_query } : {}),
    max_pick: 10,
  };
}

/**
 * 签名地址什么时候过期（毫秒时间戳）。资产库的缩略图是 OSS 签名地址，约 1 小时有效：OSS v4 写成
 * x-oss-date + x-oss-expires（秒），v1 写成 Expires（秒级时间戳）。不是签名地址就返回 undefined。
 */
export function signedUrlExpiry(url: string): number | undefined {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return undefined;
  }
  const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(params.get("x-oss-date") ?? "");
  const ttl = params.get("x-oss-expires");
  if (date && ttl && /^\d+$/.test(ttl)) {
    const [, y, mo, d, hh, mm, ss] = date.map(Number);
    return Date.UTC(y, mo - 1, d, hh, mm, ss) + Number(ttl) * 1000;
  }
  const expires = params.get("Expires");
  return expires && /^\d+$/.test(expires) ? Number(expires) * 1000 : undefined;
}

/** 地址已经过期，或不到半分钟就过期（来不及加载完）。 */
export function signedUrlExpired(url: string | undefined, now = Date.now()): boolean {
  const expiry = url ? signedUrlExpiry(url) : undefined;
  return expiry !== undefined && expiry - 30_000 <= now;
}

/** 图片尺寸写给模型看的样子，和服务端一致：「1600×1200, landscape (4:3)」；没有比例就只写横竖。 */
export function shapeText(width: number, height: number, ratio?: string): string {
  const value = width / height;
  const orientation = Math.abs(value - 1) < 0.03 ? "square" : value > 1 ? "landscape" : "portrait";
  return `${width}×${height}, ${orientation}${ratio ? ` (${ratio})` : ""}`;
}

/** atlas_use_assets 的结果：换到的地址（图片带尺寸）和不可用的编号。 */
export function usedFromToolResult(
  result: unknown
): { assets: Array<{ asset_id: string; url: string; shape?: string }>; missing: string[] } | undefined {
  const s = record(record(result)?.structuredContent);
  if (!s || !Array.isArray(s.assets)) return undefined;
  const assets = s.assets.flatMap((entry) => {
    const a = record(entry);
    if (!a || typeof a.asset_id !== "string" || typeof a.url !== "string") return [];
    const sized = typeof a.width === "number" && typeof a.height === "number" && a.width > 0 && a.height > 0;
    const shape = sized ? shapeText(a.width as number, a.height as number, typeof a.ratio === "string" ? a.ratio : undefined) : undefined;
    return [{ asset_id: a.asset_id, url: a.url, ...(shape ? { shape } : {}) }];
  });
  const missing = Array.isArray(s.missing) ? s.missing.filter((id): id is string => typeof id === "string") : [];
  return { assets, missing };
}

function resultErrorText(result: { content?: Array<{ type: string; text?: unknown }> }): string {
  const text = (result.content ?? []).find((block) => block.type === "text");
  return (text && typeof text.text === "string" ? text.text : "").replace(/^Error:\s*/, "").slice(0, 240);
}

const KIND_WORD: Record<AssetKind, string> = { image: "image", video: "video", audio: "audio", "3d": "3D model", other: "file" };

/** 资产库文件放进生成参数时的写法：服务端换成新的临时地址（src/tools/assets.ts resolveAssetReferences）。 */
export const ASSET_REF_NOTE =
  "In a generation tool's params, put the asset:// reference where the file goes; the server swaps in a fresh file URL, " +
  "so it does not expire. For anything else that needs a link, atlas_use_assets returns one.";

/**
 * 交给模型的文字：名字、类型、尺寸和 asset:// 编号，不放签名地址。验收问题 36（ChatGPT，11-03）：参数里的签名地址
 * 带 x-oss-credential，ChatGPT 当成「访问凭证」，批准框标出来，有一次整个调用被 OpenAI 的安全检查拦下。
 * Claude 预填消息里也不再是一长串链接（问题 14）。
 */
export function assetsForModel(picked: Pick<PickedAsset, "asset_id" | "label" | "kind" | "url" | "shape">[]): string {
  const lines = picked.map((a) => `- ${a.label} (${KIND_WORD[a.kind]}${a.shape ? `, ${a.shape}` : ""}): asset://${a.asset_id}`);
  return (
    `The user picked ${picked.length === 1 ? "1 file" : `${picked.length} files`} from their Atlas Asset Library in the card. ` +
    `Use ${picked.length === 1 ? "it" : "them"} as the media inputs for their request. ${ASSET_REF_NOTE}\n${lines.join("\n")}`
  );
}

/** 消息里的文件清单（Claude 这类模型看不到上下文的宿主用），一行一个：名字、类型和尺寸、asset:// 编号。 */
export function assetRefLines(picked: Pick<PickedAsset, "asset_id" | "label" | "kind" | "shape">[]): string {
  return picked.map((a) => `- ${a.label} (${KIND_WORD[a.kind]}${a.shape ? `, ${a.shape}` : ""}): asset://${a.asset_id}`).join("\n");
}

export interface LibraryDeps {
  app: App;
  render(): void;
  notice(text: string): void;
  noticeText(): string | undefined;
  /** 宿主支持全屏时展开。 */
  expand(): void;
  /** 资产库为空或没找到时的「Upload a file」。 */
  uploadInstead(): void;
  /** 资产库没开通时的「Top up」。 */
  topUp(): void;
  /** 从上传卡打开：选好的素材交回上传卡（由它交给模型）。没有它就自己交给模型。 */
  onPicked?(picked: PickedAsset[]): void;
  /** 从上传卡打开：「Cancel」回到上传卡。 */
  onCancel?(): void;
  /** 上传卡上已经有文件：选的是往里加，主按钮写「Add N selected」，不写「Use」。 */
  addToRequest?: boolean;
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
  { label: "Audio", value: "audio" },
  { label: "3D", value: "3d" },
];

const FILTER_WORD: Record<AssetFilter, string> = { image: "images", video: "videos", audio: "audio", "3d": "3D models" };

/** 资产库没开通（AssetD 回 asset_library_not_activated，服务端换成这句话）。 */
function lockedError(text: string): boolean {
  return /asset_library_not_activated|asset library isn't activated/i.test(text);
}

function fitIfLopsided(img: HTMLImageElement): void {
  if (isLopsided(img.naturalWidth, img.naturalHeight)) img.classList.add("asset-fit");
}

/** initial 为空时（从上传卡打开）先显示加载中，自己去取第一页。 */
export function createLibrary(initial: AssetCardData | undefined, deps: LibraryDeps): Library {
  let data: AssetCardData = initial ?? { view: "assets", items: [], max_pick: 10 };
  let filter: AssetFilter | undefined = FILTER_VALUES.has(data.media_type) ? data.media_type : undefined;
  let locked = data.locked === true;
  let loading = false;
  // 不能全屏的客户端（Cursor 这类）分页看，不再「Load more」越拉越长（设计 11-10 第 9 项）。从 0 开始。
  let page = 0;
  let using = false;
  let error: string | undefined;
  /**
   * Atlas 登录失效了（设计稿 v2「需要重新连接」）：「Reconnect」重做失败的那一步（翻页或换地址），
   * ChatGPT 见到这次调用被 401 挡下会自己弹出连接（11-02 实测）。选中的素材留着。
   */
  let reconnect: (() => void) | undefined;
  /** 选中的素材，按点选顺序。 */
  const selected = new Map<string, AssetCardItem>();
  /** 交给模型的那组编号；选择一变就清掉，按钮恢复。 */
  let handedOff = "";
  // 宿主交不了选择（Cursor）：卡片上留一句话，教用户在对话里怎么说。
  let manualHandOff: string | undefined;
  let version = 0;
  const sample = data.sample === true;
  // 测试卡片不调接口：筛选在手上的样例里做。
  const sampleItems = sample ? data.items : [];
  if (data.sample_signed_out) {
    reconnect = () => {
      reconnect = undefined;
      changed();
    };
  }

  const caps = () => deps.app.getHostCapabilities() ?? {};
  const changed = () => {
    version += 1;
    deps.render();
  };
  const selectionKey = () => [...selected.keys()].join(",");
  /** 「Added to chat」之后：格子（含上传格）都不能再点。 */
  const handedOffNow = () => handedOff !== "" && handedOff === selectionKey();

  /**
   * 缩略图换新地址。缩略图是约 1 小时有效的签名地址，宿主重开旧对话时给卡片的还是当时的工具结果，
   * 地址早过期了，每格只剩图标（11-06 ChatGPT 里重开 11-04 的对话）。按原来的条件重新搜，一页页往下找，
   * 直到手上这些素材都找到（搜的词没搜到时列的是「当时最近的」，过几天就排到后面去了），最多翻
   * REFRESH_PAGES 页。只换地址，列表和选中的不动。每张卡只换一次，换完还坏就留图标，不来回重试。
   */
  let thumbs: "fresh" | "refreshing" | "refreshed" = "fresh";
  async function refreshThumbs(): Promise<void> {
    if (sample || thumbs !== "fresh" || data.items.length === 0 || caps().serverTools === undefined) return;
    thumbs = "refreshing";
    changed();
    try {
      const wanted = new Set(data.items.map((item) => item.asset_id));
      const oldest = Math.min(...data.items.map((item) => Date.parse(item.created_at ?? "") || Infinity));
      const fresh = new Map<string, AssetCardItem>();
      let cursor: string | undefined;
      for (let pageNo = 0; pageNo < REFRESH_PAGES; pageNo++) {
        const result = await deps.app.callServerTool({
          name: SEARCH_TOOL,
          arguments: {
            limit: 50,
            ...(filter ? { media_type: filter } : {}),
            ...(data.query && !data.unmatched_query ? { query: data.query } : {}),
            ...(cursor ? { cursor } : {}),
          },
        });
        const page = result.isError ? undefined : assetsFromToolResult(result);
        if (!page) break;
        for (const item of page.items) if (wanted.has(item.asset_id)) fresh.set(item.asset_id, item);
        cursor = page.next_cursor;
        // 都找到了、没有下一页、或这一页已经比手上最早的素材还早（按时间倒序），就不用再翻。
        const pageOldest = Math.min(...page.items.map((item) => Date.parse(item.created_at ?? "") || Infinity));
        if (fresh.size === wanted.size || !cursor || (Number.isFinite(oldest) && pageOldest < oldest)) break;
      }
      const renew = (item: AssetCardItem): AssetCardItem => {
        const next = fresh.get(item.asset_id);
        if (!next) return item;
        const renewed = { ...item };
        if (next.thumb_url) renewed.thumb_url = next.thumb_url;
        if (next.preview_url) renewed.preview_url = next.preview_url;
        return renewed;
      };
      data = { ...data, items: data.items.map(renew) };
      for (const [id, item] of selected) selected.set(id, renew(item));
    } catch {
      // 换不到就留图标；选素材、用素材照常。
    } finally {
      thumbs = "refreshed";
      changed();
    }
  }
  if (!sample && data.items.some((item) => signedUrlExpired(item.thumb_url ?? item.preview_url))) {
    setTimeout(() => void refreshThumbs(), 0);
  }

  // ---- 上传格 ----
  // 找不到想要的图，最自然的是传一张新的：网格第一格是上传格（设计稿 11-06）。点它打开本地文件选择，
  // 不做拖拽（拖进卡片会被 ChatGPT 接成附件）；传进资产库后排在第一个并自动选中，仍受最多 10 个的限制。
  // 传文件的那套（取地址、传、进度）用上传卡的 Uploader，只是不画它的卡。

  /** 筛选到哪一类就只收哪一类。3D 传不了（上传只收图片、视频、音频），不放上传格。 */
  const UPLOAD_KIND: Partial<Record<AssetFilter, UploadKind>> = { image: "image", video: "video", audio: "audio" };
  let uploader: Uploader | undefined;
  /** 从没有地址开始：选完文件再去换地址。上限先按资产库的写（和服务端默认一致），换到地址后以服务端给的为准。 */
  const LIBRARY_UPLOAD = {
    view: "upload" as const,
    upload_url: "",
    expires_at: new Date(0).toISOString(),
    max_bytes: 50 * 1_048_576,
    max_video_bytes: 100 * 1_048_576,
    max_image_pixels: 24_000_000,
    library: true,
    lazy_url: true,
  };

  function canUpload(): boolean {
    return (filter === undefined || filter in UPLOAD_KIND) && (sample || caps().serverTools !== undefined);
  }

  /** 正在传的（排队、传、转存）。 */
  function uploading(): UploadItem[] {
    return (uploader?.items ?? []).filter((i) => i.status === "queued" || i.status === "uploading" || i.status === "saving");
  }

  function startUpload(): void {
    if (using || handedOffNow() || uploading().length > 0) return;
    uploader ??= createUploader(
      { ...LIBRARY_UPLOAD, max_files: data.max_pick, ...(sample ? { sample: true } : {}) },
      { app: deps.app, render: settleUploads, notice: deps.notice, noticeText: deps.noticeText, onProgress: showProgress }
    );
    uploader.pickOnly(filter ? UPLOAD_KIND[filter] : undefined);
  }

  function progressText(): string {
    const active = uploading();
    if (active.length === 0) return "";
    if (active.every((i) => i.status === "saving")) return "Saving…";
    const percent = Math.round((active.reduce((sum, i) => sum + i.progress, 0) / active.length) * 100);
    return active.length > 1 ? `${active.length} files · ${percent}%` : `${percent}%`;
  }

  /** 进度只改上传格上的字，不重画整张卡（缩略图会闪）。 */
  function showProgress(): void {
    const el = document.querySelector<HTMLElement>("[data-upload-progress]");
    if (el) el.textContent = progressText();
    else changed();
  }

  /** 传完的进网格第一个并选中；传不了的说明原因。上传器每次状态变化都来这里清点一遍。 */
  function settleUploads(): void {
    if (!uploader) return;
    const gone: string[] = [];
    const problems: string[] = [];
    const unsaved: string[] = [];
    let crowded = false;
    for (const item of uploader.items) {
      if (item.status === "done") {
        gone.push(item.id);
        if (!item.asset_id) {
          unsaved.push(item.name);
          continue;
        }
        const asset: AssetCardItem = {
          asset_id: item.asset_id,
          label: item.name,
          kind: item.kind,
          origin: "upload",
          ...(item.thumb ? { thumb_url: item.thumb } : {}),
          created_at: new Date().toISOString(),
        };
        data = { ...data, items: [asset, ...data.items.filter((i) => i.asset_id !== asset.asset_id)] };
        if (selected.size < data.max_pick) selected.set(asset.asset_id, asset);
        else crowded = true;
      } else if (item.status === "invalid" || item.status === "failed") {
        gone.push(item.id);
        problems.push(`${item.name}: ${item.error ?? "Upload failed"}`);
      }
    }
    if (uploader.stalled && uploader.signedOut) {
      // 文件留着，重新连上后接着传。
      reconnect = () => {
        reconnect = undefined;
        uploader?.resume();
        changed();
      };
    } else if (uploader.stalled) {
      for (const item of uploading()) gone.push(item.id);
      problems.push(`Couldn't get an upload link${uploader.error ? `: ${uploader.error}` : ""}. Try again in a moment.`);
    }
    if (gone.length > 0) uploader.release(gone);
    if (unsaved.length > 0) problems.push("Your upload space is full, so the file wasn't saved to your Asset Library.");
    if (crowded) problems.push(`Saved to your Asset Library. Pick up to ${data.max_pick} files at a time, so it isn't selected.`);
    if (problems.length > 0) deps.notice(problems.length > 1 ? `${problems[0]} (+${problems.length - 1} more)` : (problems[0] ?? ""));
    changed();
  }

  /** text：全屏搜索框里搜的词（空串等于不搜）；不给就沿用手上的。 */
  async function query(next: { filter: AssetFilter | undefined; append: boolean; clearQuery?: boolean; text?: string }): Promise<void> {
    const keepQuery = next.clearQuery ? undefined : next.text !== undefined ? next.text.trim() || undefined : data.query;
    if (sample) {
      filter = next.filter;
      if (!next.append) page = 0;
      const words = keepQuery?.toLowerCase();
      data = {
        ...data,
        items: sampleItems.filter((item) => (!filter || item.kind === filter) && (!words || item.label.toLowerCase().includes(words))),
        ...(keepQuery ? { query: keepQuery } : {}),
      };
      if (!keepQuery) delete data.query;
      changed();
      return;
    }
    if (caps().serverTools === undefined) {
      deps.notice("This app doesn't let the card load assets. Ask in the chat instead.");
      return;
    }
    loading = true;
    error = undefined;
    reconnect = undefined;
    filter = next.filter;
    if (!next.append) page = 0;
    changed();
    try {
      const result = await deps.app.callServerTool({
        name: SEARCH_TOOL,
        arguments: {
          limit: PAGE_SIZE,
          ...(filter ? { media_type: filter } : {}),
          // 没搜到改列最近的那一页，「Load more」接着列最近的，不再带搜索词。
          ...(keepQuery && !(next.append && data.unmatched_query) ? { query: keepQuery } : {}),
          ...(next.append && data.next_cursor ? { cursor: data.next_cursor } : {}),
        },
      });
      if (result.isError) throw new Error(resultErrorText(result) || "Atlas Cloud returned an error");
      const page = assetsFromToolResult(result);
      if (!page) throw new Error("Atlas Cloud sent back something this card can't read");
      if (page.locked) {
        locked = true;
        return;
      }
      const items = next.append ? [...data.items, ...page.items] : page.items;
      const unmatched = next.append ? data.unmatched_query : page.unmatched_query;
      data = { ...page, items, ...(keepQuery ? { query: keepQuery } : {}), ...(unmatched ? { unmatched_query: unmatched } : {}), max_pick: data.max_pick };
      if (!unmatched) delete data.unmatched_query;
      if (!keepQuery) delete data.query;
    } catch (e) {
      const text = thrownErrorText(e);
      if (lockedError(text)) locked = true;
      else if (isSignedOut(text, true)) reconnect = () => void query(next);
      else error = text || "Couldn't load your assets. Try again in a moment.";
    } finally {
      loading = false;
      changed();
    }
  }

  function toggle(item: AssetCardItem): void {
    if (handedOffNow()) return;
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
    const canCallTools = caps().serverTools !== undefined;
    // 交回上传卡要地址给缩略图，只能靠工具；直接交给模型时资产编号就够了（见下）。
    if (!canCallTools && deps.onPicked) {
      deps.notice("This app doesn't let the card use assets. Ask in the chat to use them.");
      return;
    }
    using = true;
    reconnect = undefined;
    changed();
    try {
      // 先调 atlas_use_assets：拿到图片尺寸（模型据此定横竖），也能查出已经删掉的文件。
      // 宿主不让卡片调工具、或者调用被宿主挡掉（2026-11-12 WorkBuddy 回「Sensitive MCP egress review is
      // unavailable.」）时，直接交资产编号：消息里写的是 asset:// 引用，生成时服务端自己换新链接，只是少了尺寸。
      let used: NonNullable<ReturnType<typeof usedFromToolResult>>;
      try {
        if (!canCallTools) throw new Error("card can't call tools here");
        const result = await deps.app.callServerTool({ name: USE_TOOL, arguments: { asset_ids: picks.map((p) => p.asset_id) } });
        const parsed = usedFromToolResult(result);
        if (!parsed || parsed.assets.length === 0) throw new Error(resultErrorText(result) || "Couldn't get these files ready");
        used = parsed;
      } catch (e) {
        if (deps.onPicked || isSignedOut(thrownErrorText(e), true)) throw e;
        used = { assets: picks.map((p) => ({ asset_id: p.asset_id, url: "" })), missing: [] };
      }
      const byId = new Map(picks.map((p) => [p.asset_id, p]));
      const ready = used.assets.flatMap((u): PickedAsset[] => {
        const p = byId.get(u.asset_id);
        return p
          ? [{ asset_id: p.asset_id, label: p.label, kind: p.kind, url: u.url, ...(p.thumb_url ? { thumb: p.thumb_url } : {}), ...(u.shape ? { shape: u.shape } : {}) }]
          : [];
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
      const outcome = await handOff(
        deps.app,
        assetsForModel(ready),
        say.pickedFromLibrary(userLang(deps.app), ready.length, labels),
        assetRefLines(ready)
      );
      if (outcome === "sent" || outcome === "context") {
        handedOff = selectionKey();
        deps.onHandedOff?.();
      }
      const claudeNote = prefillNote(deps.app, outcome);
      if (claudeNote) deps.notice(claudeNote);
      else if (outcome === "context") deps.notice("Files are ready. Tell the chat what to make with them.");
      if (outcome === "failed") deps.notice("Couldn't send the files to the chat. Try again.");
      if (outcome === "unsupported") {
        manualHandOff = `This app can't take files straight from the card. In the chat, say: "Use ${labels} from my Asset Library."`;
        deps.onHandedOff?.();
      }
    } catch (e) {
      const text = thrownErrorText(e);
      if (isSignedOut(text, true)) reconnect = () => void use();
      else deps.notice(text || "Couldn't use these files. Try again in a moment.");
    } finally {
      using = false;
      changed();
    }
  }

  // ---- 视图 ----

  function media(item: AssetCardItem): HTMLElement {
    const box = h("span", { class: "asset-media" });
    // 没有缩略图（音频、3D、缩略图坏了）：图标下面写文件名，不然几个灰格子分不清。
    const icon = () =>
      box.replaceChildren(
        h("span", { class: "asset-icon" }, h("span", { html: ICONS[item.kind], style: "display:contents" }), h("span", { class: "asset-name" }, item.label))
      );
    // 加载失败先当成地址过期，换一次新地址（refreshThumbs）；换过还坏才是真没有缩略图。
    const broken = () => {
      icon();
      void refreshThumbs();
    };
    const url = item.thumb_url ?? (item.kind === "video" ? item.preview_url : undefined);
    if (url && thumbs !== "refreshed" && signedUrlExpired(url)) {
      // 过期的地址不去加载：灰格子等新地址，免得先闪一下图标。
      if (thumbs === "fresh") void refreshThumbs();
    } else if (item.thumb_url) {
      // 不带 Referer：存储的防盗链会拦卡片沙箱的来源（生成卡同一个坑）。
      const img = h("img", { src: item.thumb_url, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
      img.addEventListener("error", broken, { once: true });
      img.addEventListener("load", () => fitIfLopsided(img), { once: true });
      box.append(img);
    } else if (item.kind === "video" && item.preview_url) {
      const video = h("video", { src: `${item.preview_url}#t=0.1`, preload: "metadata", muted: true, playsinline: "", referrerpolicy: "no-referrer" });
      video.addEventListener("error", broken, { once: true });
      box.append(video);
    } else {
      icon();
    }
    return box;
  }

  function tile(item: AssetCardItem, frozen: boolean): HTMLElement {
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
          disabled: frozen,
          onclick: () => toggle(item),
        },
        media(item),
        item.kind === "video" ? h("span", { class: "asset-play", html: ICONS.video }) : null,
        on ? h("span", { class: "asset-check", html: ICON_CHECK }) : null
      )
    );
  }

  /** 网格第一格：和缩略图同尺寸，浅灰底，上传图标加「Upload a file」；传的时候显示进度。 */
  function uploadTile(frozen: boolean): HTMLElement {
    const busy = uploading().length > 0;
    return h(
      "li",
      {},
      h(
        "button",
        {
          type: "button",
          class: "asset-tile asset-upload",
          "aria-label": busy ? "Uploading" : "Upload a file",
          disabled: frozen || busy,
          onclick: startUpload,
        },
        h(
          "span",
          { class: "asset-upload-body" },
          h("span", { class: "asset-upload-icon", html: busy ? ICON_SPINNER : ICON_UPLOAD }),
          h("span", { class: "asset-upload-label" }, busy ? "Uploading" : "Upload a file"),
          busy ? h("span", { class: "asset-upload-sub", "data-upload-progress": "" }, progressText()) : null
        )
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

  /** 空状态：设计稿 v2「资产库为空」「没有搜索结果」「资产库未开通」三种。 */
  function emptyState(icon: string, title: string, desc: string, actions: HTMLElement[]): HTMLElement {
    return h(
      "div",
      { class: "asset-empty" },
      h("span", { class: "asset-empty-icon", html: icon }),
      h("p", { class: "asset-empty-title" }, title),
      h("p", { class: "asset-empty-desc" }, desc),
      h("div", { class: "actions" }, ...actions)
    );
  }

  function empty(): HTMLElement {
    const showAll = () => button("Show all", "secondary", () => void query({ filter: undefined, append: false, clearQuery: true }), { small: true });
    const upload = (variant: "primary" | "secondary") => button("Upload a file", variant, deps.uploadInstead, { small: true });
    if (data.query) {
      return emptyState(ICONS.image, `No matches for “${data.query}”`, "Try different words, or upload a new file.", [upload("primary"), showAll()]);
    }
    if (filter) return emptyState(ICONS[filter], `No ${FILTER_WORD[filter]} yet`, "Files you upload or generate will appear here.", [upload("primary"), showAll()]);
    return emptyState(ICONS.image, "Your Asset Library is empty", "Files you upload or generate will appear here.", [upload("primary")]);
  }

  function lockedState(): HTMLElement {
    return emptyState(ICON_LOCK, "Top up to use your Asset Library", "The Asset Library is available after you add balance to your account.", [
      button("Top up", "primary", deps.topUp, { small: true }),
      button("Upload from device", "secondary", deps.uploadInstead, { small: true }),
    ]);
  }

  /** 全屏里才有搜索框（设计稿 v2：对话里找素材靠用户描述，模型去搜）。 */
  function searchBox(): HTMLElement {
    const input = h("input", {
      type: "search",
      class: "asset-search-input",
      placeholder: "Search your files",
      "aria-label": "Search your files",
      value: data.query ?? "",
      disabled: loading,
    });
    return h(
      "form",
      {
        class: "asset-search",
        role: "search",
        onsubmit: (event: Event) => {
          event.preventDefault();
          void query({ filter, append: false, text: input.value });
        },
      },
      h("span", { class: "asset-search-icon", html: ICON_SEARCH }),
      input
    );
  }

  /** 分页模式：第 p 页在 items 里的起止。第一页的第一格是上传格时少放一个资产。 */
  function pageRange(p: number, perPage: number, withUpload: boolean): [number, number] {
    const first = perPage - (withUpload ? 1 : 0);
    const start = p === 0 ? 0 : first + (p - 1) * perPage;
    return [start, start + (p === 0 ? first : perPage)];
  }

  /** 翻页条：「‹  Page 2  ›」。下一页还没取到就先去取，取到再翻过去。 */
  function pager(perPage: number, withUpload: boolean): HTMLElement | null {
    const [, end] = pageRange(page, perPage, withUpload);
    const hasNext = end < data.items.length || Boolean(data.next_cursor);
    if (page === 0 && !hasNext) return null;
    const go = (target: number) => {
      page = target;
      changed();
    };
    const next = async () => {
      const [, nextEnd] = pageRange(page + 1, perPage, withUpload);
      if (nextEnd > data.items.length && data.next_cursor) await query({ filter, append: true });
      if (pageRange(page + 1, perPage, withUpload)[0] < data.items.length) go(page + 1);
    };
    return h(
      "div",
      { class: "asset-pager", role: "navigation", "aria-label": "Asset pages" },
      h("button", { type: "button", class: "asset-page-btn", "aria-label": "Previous page", disabled: page === 0 || loading, onclick: () => go(page - 1) }, "‹"),
      h("span", { class: "asset-page-label" }, loading ? "Loading…" : `Page ${page + 1}`),
      h("button", { type: "button", class: "asset-page-btn", "aria-label": "Next page", disabled: !hasNext || loading, onclick: () => void next() }, "›")
    );
  }

  function footer(opts: LibraryViewOptions, shown: number): HTMLElement | null {
    const n = selected.size;
    const handed = handedOffNow();
    const more = data.items.length - shown;
    const left = h("span", { class: "asset-count" }, n > 0 ? `${n} selected` : `Pick up to ${data.max_pick}`);
    const buttons: (HTMLElement | null)[] = [];
    if (!opts.fullscreen && more > 0 && opts.canExpand) buttons.push(button("View all", "secondary", deps.expand));
    else if (opts.fullscreen && data.next_cursor) {
      buttons.push(button(loading ? "Loading…" : "Load more", "secondary", () => void query({ filter, append: true }), { disabled: loading }));
    }
    if (handed) buttons.push(button("Added to chat", "primary", () => undefined, { disabled: true }));
    else {
      const verb = deps.addToRequest ? "Add" : "Use";
      buttons.push(button(using ? "Getting files…" : n > 0 ? `${verb} ${n} selected` : `${verb} selected`, "primary", () => void use(), { disabled: n === 0 || using }));
    }
    if (deps.onCancel) buttons.push(button("Cancel", "secondary", deps.onCancel));
    return h("div", { class: "asset-foot" }, left, h("div", { class: "asset-foot-actions" }, ...buttons));
  }

  function view(opts: LibraryViewOptions): HTMLElement {
    // 选择变了（或换了一页）就不再是交给模型的那一组。
    if (handedOff !== "" && handedOff !== selectionKey()) handedOff = "";
    const frozen = handedOffNow();
    // 上传格占网格的第一格：对话里还是两行，资产少露一个。
    const withUpload = canUpload() && data.items.length > 0;
    const paged = !opts.fullscreen && !opts.canExpand;
    const perPage = inlineTiles();
    // 选中项被筛掉、或这一页因为换了筛选不存在了：回到还有东西的最后一页。
    while (paged && page > 0 && pageRange(page, perPage, withUpload)[0] >= data.items.length) page--;
    const withUploadHere = withUpload && (!paged || page === 0);
    const shown = opts.fullscreen
      ? data.items
      : paged
        ? data.items.slice(...pageRange(page, perPage, withUpload))
        : data.items.slice(0, perPage - (withUpload ? 1 : 0));
    // 最后一页不满时补空格：卡片高度不变，底部的「Use N selected」不跟着跳。
    const filler = paged && page > 0 ? Math.max(0, perPage - shown.length) : 0;
    const notice = deps.noticeText();
    const title = h("div", { class: "head" }, h("p", { class: opts.fullscreen ? "title-lg" : "title" }, "Asset Library"));
    if (locked) {
      return h("section", { class: `card assets${opts.fullscreen ? " fullscreen" : ""}` }, title, lockedState(), notice ? h("p", { class: "note", role: "status" }, notice) : null);
    }
    if (reconnect) {
      const actions = [button("Reconnect", "primary", reconnect, { small: true })];
      if (deps.onCancel) actions.push(button("Cancel", "secondary", deps.onCancel, { small: true }));
      return h(
        "section",
        { class: `card assets${opts.fullscreen ? " fullscreen" : ""}` },
        head("Asset Library", badge("Sign in required", { danger: true }), opts.fullscreen),
        emptyState(ICON_LINK, "Reconnect Atlas Cloud", "Your Atlas Cloud sign-in expired. Reconnect to keep using your Asset Library.", actions),
        h("p", { class: "note" }, RECONNECT_NOTE),
        notice ? h("p", { class: "note", role: "status" }, notice) : null
      );
    }
    const body =
      data.items.length > 0
        ? h(
            "ul",
            { class: "asset-grid" },
            withUploadHere ? uploadTile(frozen) : null,
            ...shown.map((item) => tile(item, frozen)),
            ...Array.from({ length: filler }, () => h("li", { class: "asset-slot", "aria-hidden": "true" }))
          )
        : loading
          ? h("p", { class: "desc" }, "Loading your assets…")
          : error
            ? null
            : empty();
    return h(
      "section",
      { class: `card assets${opts.fullscreen ? " fullscreen" : ""}` },
      title,
      opts.fullscreen ? searchBox() : null,
      data.unmatched_query && data.items.length > 0
        ? h("p", { class: "desc asset-query" }, `Nothing matched “${data.unmatched_query}”, so these are your latest files.`)
        : data.query && !opts.fullscreen
        ? h(
            "p",
            { class: "desc asset-query" },
            `Results for “${data.query}” · `,
            h("button", { type: "button", class: "asset-clear", onclick: () => void query({ filter, append: false, clearQuery: true }) }, "Show all")
          )
        : null,
      // 库里一个文件都没有时不放筛选（设计稿「资产库为空」）。
      data.items.length === 0 && !filter && !data.query && !loading ? null : tabs(),
      body,
      error ? h("p", { class: "note", role: "status" }, error) : null,
      paged && data.items.length > 0 ? pager(perPage, withUpload) : null,
      data.items.length > 0 ? footer(opts, shown.length) : null,
      manualHandOff ? h("p", { class: "note" }, manualHandOff) : null,
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

const ICON_LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10V7.5a4.5 4.5 0 0 1 9 0V10h.5c.8 0 1.5.7 1.5 1.5v7c0 .8-.7 1.5-1.5 1.5H7c-.8 0-1.5-.7-1.5-1.5v-7c0-.8.7-1.5 1.5-1.5h.5zm1.8 0h5.4V7.5a2.7 2.7 0 0 0-5.4 0V10z" fill="currentColor"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.2 13.8a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.1 1.1m-1.9 4a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.1-1.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_SEARCH ='<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="currentColor"/><path d="m4.8 8.2 2.1 2.1 4.3-4.4" fill="none" style="stroke:var(--ac-primary-text,#fff)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICONS: Record<AssetKind, string> = {
  image: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h14c.8 0 1.5.7 1.5 1.5v14c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5V5c0-.8.7-1.5 1.5-1.5zm0 1.5v10.4l4.2-4.2c.4-.4 1-.4 1.4 0l2.3 2.3 1.8-1.8c.4-.4 1-.4 1.4 0L19 14.6V5H5zm9.5 1.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" fill="currentColor"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  "3d": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 3.8 7.4v9.2l8.2 4.6 8.2-4.6V7.4L12 2.8zm0 2.3 5.9 3.3L12 11.7 6.1 8.4 12 5.1zM5.8 10.1l5.2 2.9v5.8l-5.2-2.9v-5.8zm7.2 8.7V13l5.2-2.9v5.8L13 18.8z" fill="currentColor"/></svg>',
  other: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l5 5v12.4c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1V3.8c0-.6.4-1 1-1zm7.5 1.7V8.3h3.8L13.5 4.5z" fill="currentColor"/></svg>',
};
