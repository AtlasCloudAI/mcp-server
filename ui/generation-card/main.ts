// 生成卡入口：通过 MCP Apps 协议和宿主（ChatGPT、Claude……）对话。
// 拿到工具结果就画卡；任务没结束就自己调 atlas_card_status 刷新，直到出结果。

import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { type CardData, type CardMedia, cardFromToolResult, fileNameOf, isActive, newIdempotencyKey } from "./card.js";
import { type CardActions, type ViewOptions, errorCard, loadingCard, renderCard, tickTimers } from "./view.js";
import { type QuoteState, createQuoteActions, initialQuoteState, quoteExpired, renderQuoteCard } from "./quote.js";
import { type HistoryFilter, type HistoryView, backLink, historyFromToolResult, renderHistory } from "./history.js";
import { type Uploader, type UploadCardData, createUploader, uploadFromToolResult } from "./upload.js";
import { type AssetCardData, type Library, type LibraryDeps, assetsFromToolResult, createLibrary } from "./assets.js";

const STATUS_TOOL = "atlas_card_status";
const SITE_URL = "https://www.atlascloud.ai";
/** 卡片自己最多等这么久，之后显示「Still generating」，用户点 Keep waiting 再等一轮。 */
const POLL_BUDGET_MS = 10 * 60 * 1000;
/** 两次刷新之间至少隔这么久（服务端本身会等最多 20 秒再回答）。 */
const MIN_POLL_GAP_MS = 3_000;

const root = document.getElementById("root") as HTMLElement;
const app = new App({ name: "Atlas Cloud generation card", version: "1.0.0" }, {}, { autoResize: true });

let card: CardData | undefined;
let pendingId: string | undefined;
let loadError: string | undefined;
let stalled = false;
let refreshing = false;
let polling = false;
let pollStartedAt = Date.now();
let notice: string | undefined;
let renderedKey = "";
// 报价卡：当前处在哪一步（待确认、提交中、过期……），以及这次调用的参数（宿主丢了 _meta 时兜底用）。
let quoteState: QuoteState = { phase: "ready" };
let toolArgs: Record<string, unknown> | undefined;
let quoteTimer: ReturnType<typeof setTimeout> | undefined;
// 历史列表卡：有它时 card 是「点开的那一条」，没点开时 card 为空、显示列表。
let history: HistoryView | undefined;
// 上传卡：文件和上传进度都在它自己手里（File 对象不能拿来比较），按它的版本号判断要不要重画。
let uploader: Uploader | undefined;
// 资产库卡：有它时盖在上传卡上面（从上传卡打开的），或者它本身就是这张卡（atlas_search_assets 的结果）。
let library: Library | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


function hostCaps() {
  return app.getHostCapabilities() ?? {};
}

function viewOptions(): ViewOptions {
  const caps = hostCaps();
  const sample = card?.sample === true;
  return {
    canRefresh: sample || caps.serverTools !== undefined,
    canMessage: sample || caps.message !== undefined,
    stalled,
    refreshing,
    notice,
  };
}

// 测试卡片的诊断信息：宿主实际给卡片套的 CSP、被拦下的请求。宿主的 iframe 跨域，
// 外面看不到，只能让卡片自己报。只在示例卡片上显示，真实结果不显示。
const violations: string[] = [];
document.addEventListener("securitypolicyviolation", (event) => {
  const line = `${event.effectiveDirective || event.violatedDirective} ← ${event.blockedURI || "(inline)"}`;
  if (!violations.includes(line)) violations.push(line);
  // 只改诊断区的字，不重画卡片：重画会再请求一次被拦的图，又触发拦截，死循环。
  const box = root.querySelector(".diagnostics");
  if (box) box.replaceWith(diagnostics());
});

function cspOf(doc: Document | undefined): string {
  try {
    const metas = doc ? [...doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')] : [];
    return metas.map((m) => m.getAttribute("content") ?? "").join(" | ") || "(none)";
  } catch {
    return "(not readable)";
  }
}

function diagnostics(): HTMLElement {
  let parentDoc: Document | undefined;
  try {
    parentDoc = window.parent !== window ? window.parent.document : undefined;
  } catch {
    parentDoc = undefined;
  }
  const lines = [
    `host: ${app.getHostVersion()?.name ?? "?"} ${app.getHostVersion()?.version ?? ""}`,
    `caps: ${Object.keys(hostCaps()).join(",") || "(none)"}`,
    `origin: ${location.origin}`,
    `csp (this frame): ${cspOf(document)}`,
    `csp (parent frame): ${parentDoc ? cspOf(parentDoc) : "(cross-origin)"}`,
    `blocked: ${violations.length ? violations.join("; ") : "(none)"}`,
  ];
  const box = document.createElement("details");
  box.className = "diagnostics";
  const summary = document.createElement("summary");
  summary.textContent = `Sample card diagnostics${violations.length ? ` (${violations.length} blocked)` : ""}`;
  const pre = document.createElement("pre");
  pre.textContent = lines.join("\n");
  box.append(summary, pre);
  box.open = violations.length > 0;
  return box;
}

function displayInfo(): { fullscreen: boolean; canExpand: boolean } {
  const context = app.getHostContext();
  return {
    fullscreen: context?.displayMode === "fullscreen",
    canExpand: (context?.availableDisplayModes ?? []).includes("fullscreen") && context?.displayMode !== "fullscreen",
  };
}

/** 切显示模式；宿主不支持全屏或已经是这个模式就不动。 */
function requestMode(mode: "inline" | "fullscreen"): void {
  const context = app.getHostContext();
  if (context?.displayMode === mode) return;
  if (mode === "fullscreen" && !(context?.availableDisplayModes ?? []).includes("fullscreen")) return;
  void app.requestDisplayMode({ mode }).catch(() => undefined);
}

function render(force = false): void {
  // 资产库卡在对话里不让页面自己滚，见 styles.css「资产库卡」。
  document.documentElement.dataset.view = library ? "assets" : "";
  document.documentElement.dataset.display = app.getHostContext()?.displayMode ?? "inline";
  if (library) {
    const display = displayInfo();
    const key = `assets:${library.version}:${notice ?? ""}:${display.fullscreen}:${display.canExpand}`;
    if (!force && key === renderedKey) return;
    renderedKey = key;
    // 资产库全屏时放宽到 720（设计稿全屏视图宽 720）。
    root.classList.toggle("wide", display.fullscreen);
    root.replaceChildren(library.view(display));
    if (library.sample) root.append(diagnostics());
    return;
  }
  if (uploader) {
    const key = `upload:${uploader.version}:${notice ?? ""}`;
    if (!force && key === renderedKey) return;
    renderedKey = key;
    root.classList.remove("wide");
    root.replaceChildren(uploader.view());
    if (uploader.data.sample) root.append(diagnostics());
    return;
  }
  // 内容没变就不重画：正在播的视频、音频不能被打断。
  const opts = viewOptions();
  const historyOpts = history ? historyOptions() : undefined;
  const key = JSON.stringify({ card, pendingId, loadError, opts, quoteState, history, historyOpts });
  if (!force && key === renderedKey) return;
  renderedKey = key;
  let view: HTMLElement;
  if (history && historyOpts && !card && !pendingId) view = renderHistory(history, historyOpts, historyActions);
  else if (history) view = h2(backLink(closeDetail), card ? renderCard(card, opts, actions) : loadingCard(pendingId));
  else if (card?.state === "quote") view = renderQuoteCard(card, quoteState, opts, quoteActions);
  else if (card) view = renderCard(card, opts, actions);
  else if (loadError) view = errorCard(loadError, opts, actions);
  else view = loadingCard(pendingId);
  // 历史列表全屏时放宽到 720（设计稿全屏视图宽 720），其余照旧 560。
  root.classList.toggle("wide", historyOpts?.fullscreen === true);
  root.replaceChildren(view);
  if (card?.sample) root.append(diagnostics());
}

function setNotice(text: string | undefined, ttlMs = 4000): void {
  notice = text;
  render();
  if (text) {
    setTimeout(() => {
      if (notice === text) {
        notice = undefined;
        render();
      }
    }, ttlMs);
  }
}

/** 还在跑的任务：卡上的价格是报价时的预估，刷新没给价格时沿用。 */
const UNSETTLED_STATES = new Set<string>(["quote", "queued", "running", "transfer_pending"]);

function accept(result: unknown, carry: Partial<CardData> = {}): boolean {
  const parsed = cardFromToolResult(result, { tool: app.getHostContext()?.toolInfo?.tool.name, args: toolArgs });
  if (!parsed) return false;
  // carry：报价卡确认后把预估价带到进度卡上（服务端提交结果里没有价格）。
  // 之后每次刷新，同一个任务没给价格就沿用手上的，出结果时换成实际扣费。
  // retry（重新报价用的工具和参数）只在提交那次给，刷新结果里没有，同理沿用。
  const previous = card?.prediction_id === parsed.prediction_id ? card : undefined;
  const kept = {
    ...(previous?.price_usd !== undefined ? { price_usd: previous.price_usd } : {}),
    ...(previous?.retry ? { retry: previous.retry } : {}),
  };
  const next = { ...kept, ...carry, ...parsed };
  if (parsed.price_usd !== undefined) next.price_usd = parsed.price_usd;
  // 网关给了扣费状态、任务也结束了：价格只认结果里的，预估价不能顶替实扣，没结算完
  // 显示「待结算」（需求文档 6.3）。老网关没有 charge_status，照旧沿用。
  else if (parsed.charge_status !== undefined && !UNSETTLED_STATES.has(parsed.state)) delete next.price_usd;
  // 刷新拿到的结果不带 sample 标记，示例卡保持示例。
  card = card?.sample ? { ...next, sample: true } : next;
  loadError = undefined;
  if (card.state === "quote") watchQuote(card);
  render();
  return true;
}

/** 新报价：回到待确认，到点自动变成「已过期」。 */
function watchQuote(quoteCard: CardData): void {
  quoteState = initialQuoteState(quoteCard);
  if (quoteTimer) clearTimeout(quoteTimer);
  const at = quoteCard.quote?.expires_at ? Date.parse(quoteCard.quote.expires_at) : NaN;
  if (!Number.isFinite(at) || quoteState.phase !== "ready") return;
  quoteTimer = setTimeout(() => {
    // 价格变了那一步拿的也是新报价，同样会过期。
    const waiting = quoteState.phase === "ready" || quoteState.phase === "price_changed";
    if (card === quoteCard && waiting && quoteExpired(quoteCard.quote)) {
      quoteState = { phase: "expired" };
      render();
    }
  }, Math.max(0, at - Date.now()) + 250);
}

async function refreshOnce(): Promise<void> {
  if (!card || card.sample) {
    setNotice("This is a sample card, so there is nothing to refresh.");
    return;
  }
  refreshing = true;
  render();
  try {
    const result = await app.callServerTool({ name: STATUS_TOOL, arguments: { prediction_id: card.prediction_id } });
    if (result.isError) {
      const text = result.content?.find((c) => c.type === "text");
      setNotice(text && "text" in text ? String(text.text).slice(0, 160) : "Couldn't refresh. Try again in a moment.");
    } else {
      accept(result);
    }
  } catch {
    setNotice("Couldn't refresh. Try again in a moment.");
  } finally {
    refreshing = false;
    render();
  }
}

async function pollLoop(): Promise<void> {
  if (polling) return;
  if (!card || card.sample || !isActive(card.state) || hostCaps().serverTools === undefined) return;
  polling = true;
  pollStartedAt = Date.now();
  stalled = false;
  try {
    while (card && isActive(card.state)) {
      if (Date.now() - pollStartedAt > POLL_BUDGET_MS) {
        stalled = true;
        render();
        return;
      }
      const started = Date.now();
      let failed = false;
      try {
        const result = await app.callServerTool({
          name: STATUS_TOOL,
          arguments: { prediction_id: card.prediction_id },
        });
        failed = result.isError === true || !accept(result);
      } catch {
        // 网络抖一下不算失败，歇一会儿下一轮再试
        failed = true;
      }
      // 服务端本身会等一会儿再回答，正常情况只补足最小间隔；出错时多歇几秒。
      const gap = MIN_POLL_GAP_MS - (Date.now() - started);
      await sleep(Math.max(gap, failed ? 5_000 : 0));
    }
  } finally {
    polling = false;
  }
}

async function openUrl(url: string): Promise<void> {
  if (hostCaps().openLinks !== undefined) {
    try {
      const { isError } = await app.openLink({ url });
      if (!isError) return;
    } catch {
      // 退回到浏览器自己打开
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

const MIME: Record<string, string> = {
  image: "image/*",
  video: "video/*",
  audio: "audio/*",
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 沙箱 iframe 常常没有剪贴板权限，退回到老办法
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function sendUserMessage(text: string): void {
  if (card?.sample) {
    setNotice("This is a sample card, so nothing was sent.");
    return;
  }
  app
    .sendMessage({ role: "user", content: [{ type: "text", text }] })
    .then((res) => {
      if (res.isError) setNotice("Couldn't send that. Type it in the chat instead.");
    })
    .catch(() => setNotice("Couldn't send that. Type it in the chat instead."));
}

const actions: CardActions = {
  download(media: CardMedia) {
    void (async () => {
      if (hostCaps().downloadFile !== undefined) {
        try {
          const { isError } = await app.downloadFile({
            contents: [
              {
                type: "resource_link",
                uri: media.url,
                name: fileNameOf(media.url, "atlas-cloud-result"),
                ...(MIME[media.kind] ? { mimeType: MIME[media.kind] } : {}),
              },
            ],
          });
          if (!isError) return;
        } catch {
          // 宿主不支持或用户取消：退回到打开链接
        }
      }
      await openUrl(media.url);
    })();
  },
  openInAtlas() {
    void openUrl(card?.open_url || SITE_URL);
  },
  copyLink: copyText,
  refresh() {
    void refreshOnce().then(() => pollLoop());
  },
  keepWaiting() {
    stalled = false;
    render();
    void pollLoop();
  },
  tryAgain() {
    // 知道原来的工具和参数：用新的幂等键再报一次价（不扣费），卡片变回报价卡等用户确认。
    // 不知道（比如从查结果进来的卡片）就请模型重试。
    const retry = card?.retry;
    if (!retry || card?.sample || hostCaps().serverTools === undefined) {
      sendUserMessage("That generation failed. Please try it again with the same model and settings.");
      return;
    }
    void app
      .callServerTool({ name: retry.tool, arguments: { ...retry.arguments, idempotency_key: newIdempotencyKey() } })
      .then((result) => {
        if (result.isError || !accept(result)) setNotice("Couldn't get a new quote. Try again in a moment.");
        else void pollLoop();
      })
      .catch(() => setNotice("Couldn't get a new quote. Try again in a moment."));
  },
  switchModel() {
    sendUserMessage("That generation failed. Please suggest a different model for the same request.");
  },
};

const quoteActions = createQuoteActions({
  app,
  card: () => card,
  setState(state) {
    quoteState = state;
    render();
  },
  accept,
  startPolling: () => void pollLoop(),
  notice: (text) => setNotice(text),
  openUrl: (url) => void openUrl(url),
});

// ---- 历史列表卡 ----

function h2(...children: HTMLElement[]): HTMLElement {
  const box = document.createElement("div");
  box.append(...children);
  return box;
}

function historyOptions() {
  const context = app.getHostContext();
  return {
    fullscreen: context?.displayMode === "fullscreen",
    canExpand: (context?.availableDisplayModes ?? []).includes("fullscreen") && context?.displayMode !== "fullscreen",
    canQuery: hostCaps().serverTools !== undefined,
  };
}

const LIST_TOOL = "atlas_list_predictions";

async function queryHistory(args: { page: number; state?: HistoryFilter }, append: boolean): Promise<void> {
  if (!history) return;
  if (history.data.sample) {
    history = { ...history, error: "This is a sample list, so there is nothing more to load." };
    render();
    return;
  }
  history = { ...history, loading: true, error: undefined };
  render();
  try {
    const result = await app.callServerTool({
      name: LIST_TOOL,
      arguments: { page: args.page, size: history.data.size, ...(args.state ? { state: args.state } : {}) },
    });
    const next = result.isError ? undefined : historyFromToolResult(result);
    if (!next || !history) throw new Error("bad result");
    history = {
      loading: false,
      data: append ? { ...next, items: [...history.data.items, ...next.items] } : next,
    };
  } catch {
    if (history) history = { ...history, loading: false, error: "Couldn't load your generations. Try again in a moment." };
  }
  render();
}

const historyActions = {
  expand() {
    void app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined);
  },
  setFilter(filter: HistoryFilter | undefined) {
    void queryHistory({ page: 1, state: filter }, false);
  },
  loadMore() {
    if (history) void queryHistory({ page: history.data.page + 1, state: history.data.state }, true);
  },
  open(predictionId: string) {
    void openDetail(predictionId);
  },
};

/** 点开一条：先显示「Checking」，再拿到那条的生成卡；还在跑就接着自己刷新。 */
async function openDetail(predictionId: string): Promise<void> {
  pendingId = predictionId;
  card = undefined;
  if (history) history = { ...history, loading: true };
  render();
  try {
    // 测试卡片里的历史样例：条目号是 selftest_<样例名>，打开对应的测试卡片，不调真实接口。
    const sample = history?.data.sample === true && predictionId.startsWith("selftest_");
    const result = sample
      ? await app.callServerTool({ name: "atlas_card_selftest", arguments: { variant: predictionId.slice("selftest_".length) } })
      : await app.callServerTool({ name: STATUS_TOOL, arguments: { prediction_id: predictionId } });
    if (!result.isError && accept(result)) {
      if (history) history = { ...history, loading: false };
      render();
      void pollLoop();
      return;
    }
    throw new Error("bad result");
  } catch {
    if (history) history = { ...history, loading: false, error: "Couldn't open that generation. Try again in a moment." };
    pendingId = undefined;
    render();
  }
}

function closeDetail(): void {
  card = undefined; // 停掉这一条的轮询
  pendingId = undefined;
  render();
}

// ---- 上传卡和资产库卡 ----

function startUploader(data: UploadCardData): void {
  uploader = createUploader(data, {
    app,
    render: () => render(),
    notice: (text) => setNotice(text),
    noticeText: () => notice,
    // 宿主不让卡片调工具时打不开资产库（测试卡片用样例，不调真实接口）。
    ...(data.sample || hostCaps().serverTools !== undefined ? { openLibrary: () => void openLibraryFromUpload() } : {}),
  });
}

function libraryDeps(extra: Pick<LibraryDeps, "uploadInstead"> & Partial<LibraryDeps>): LibraryDeps {
  return {
    app,
    render: () => render(),
    notice: (text) => setNotice(text),
    noticeText: () => notice,
    expand: () => requestMode("fullscreen"),
    ...extra,
  };
}

function closeLibrary(): void {
  library = undefined;
  requestMode("inline");
  render(true);
}

/** 上传卡里点「Choose from Asset Library」：全屏打开资产库，选好或取消都回到上传卡。 */
async function openLibraryFromUpload(): Promise<void> {
  const from = uploader;
  if (!from) return;
  let initial: AssetCardData | undefined;
  if (from.data.sample) {
    // 测试卡片：拿测试工具的样例资产库，不调真实接口。
    try {
      initial = assetsFromToolResult(await app.callServerTool({ name: "atlas_card_selftest", arguments: { variant: "assets" } }));
    } catch {
      initial = undefined;
    }
    if (!initial) {
      setNotice("This is a sample card, so there is no Asset Library to open.");
      return;
    }
  }
  library = createLibrary(
    initial,
    libraryDeps({
      onCancel: closeLibrary,
      onPicked(picked) {
        closeLibrary();
        from.addPicked(picked);
        void from.useFiles();
      },
      uploadInstead() {
        closeLibrary();
        from.pick();
      },
    })
  );
  requestMode("fullscreen");
  render(true);
}

/** 资产库卡（atlas_search_assets 的结果）里资产库为空时的「Upload from device」：换成上传卡。 */
async function switchToUpload(): Promise<void> {
  if (library?.sample) {
    setNotice("This is a sample card, so nothing is uploaded.");
    return;
  }
  if (hostCaps().serverTools === undefined) {
    setNotice("Ask in the chat to upload a file.");
    return;
  }
  try {
    const result = await app.callServerTool({ name: "atlas_get_upload_url", arguments: {} });
    const data = result.isError ? undefined : uploadFromToolResult(result);
    if (!data) throw new Error("bad result");
    startUploader(data);
    closeLibrary();
  } catch {
    setNotice("Couldn't open the upload card. Ask in the chat to upload a file.");
  }
}

function applyContext(context: McpUiHostContext | undefined): void {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

function detectHost(): void {
  const name = app.getHostVersion()?.name?.toLowerCase() ?? "";
  if (name.includes("claude")) document.documentElement.dataset.host = "claude";
  else if (name.includes("chatgpt") || name.includes("openai")) document.documentElement.dataset.host = "chatgpt";
}

// 宿主不告诉主题时跟系统走。
const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
function systemTheme(): void {
  if (!app.getHostContext()?.theme) {
    document.documentElement.dataset.theme = darkQuery?.matches ? "dark" : "light";
  }
}

app.ontoolinput = (params) => {
  toolArgs = params.arguments;
  const id = params.arguments?.prediction_id;
  if (typeof id === "string" && !card) {
    pendingId = id;
    render();
  }
};

app.ontoolresult = (params) => {
  const upload = params.isError ? undefined : uploadFromToolResult(params);
  if (upload) {
    startUploader(upload);
    render();
    return;
  }
  const assets = params.isError ? undefined : assetsFromToolResult(params);
  if (assets) {
    library = createLibrary(
      assets,
      libraryDeps({ uploadInstead: () => void switchToUpload(), onHandedOff: () => requestMode("inline") })
    );
    render();
    return;
  }
  const list = params.isError ? undefined : historyFromToolResult(params);
  if (list) {
    history = { data: list, loading: false };
    card = undefined;
    render();
    return;
  }
  if (params.isError) {
    const text = params.content?.find((c) => c.type === "text");
    loadError = text && "text" in text ? String(text.text).slice(0, 240) : "Atlas Cloud returned an error.";
    render();
    return;
  }
  if (accept(params)) void pollLoop();
};

app.onhostcontextchanged = (params) => {
  applyContext(params);
  render(true);
};

app.onteardown = async () => {
  card = undefined; // 停掉轮询
  return {};
};

render(true);
systemTheme();
darkQuery?.addEventListener?.("change", systemTheme);
setInterval(() => tickTimers(root), 1000);

app
  .connect()
  .then(() => {
    detectHost();
    applyContext(app.getHostContext());
    systemTheme();
    render(true);
  })
  .catch(() => {
    loadError = "This card couldn't connect to the chat app.";
    render(true);
  });
