// 生成卡入口：通过 MCP Apps 协议和宿主（ChatGPT、Claude……）对话。
// 拿到工具结果就画卡；任务没结束就自己调 atlas_card_status 刷新，直到出结果。

import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { type CardData, type CardMedia, cardFromToolResult, fileNameOf, isActive } from "./card.js";
import { type CardActions, type ViewOptions, errorCard, loadingCard, renderCard, tickElapsed } from "./view.js";

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

function render(force = false): void {
  // 内容没变就不重画：正在播的视频、音频不能被打断。
  const opts = viewOptions();
  const key = JSON.stringify({ card, pendingId, loadError, opts });
  if (!force && key === renderedKey) return;
  renderedKey = key;
  let view: HTMLElement;
  if (card) view = renderCard(card, opts, actions);
  else if (loadError) view = errorCard(loadError, opts, actions);
  else view = loadingCard(pendingId);
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

function accept(result: unknown): boolean {
  const next = cardFromToolResult(result);
  if (!next) return false;
  // 刷新拿到的结果不带 sample 标记，示例卡保持示例。
  card = card?.sample ? { ...next, sample: true } : next;
  loadError = undefined;
  render();
  return true;
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
    sendUserMessage("That generation failed. Please try it again with the same model and settings.");
  },
  switchModel() {
    sendUserMessage("That generation failed. Please suggest a different model for the same request.");
  },
};

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
  const id = params.arguments?.prediction_id;
  if (typeof id === "string" && !card) {
    pendingId = id;
    render();
  }
};

app.ontoolresult = (params) => {
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
setInterval(() => tickElapsed(root), 1000);

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
