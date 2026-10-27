// 浏览器端：每张卡一个沙箱 iframe + 一个 AppBridge，和真宿主走同一套协议。
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const CARD_URI = "ui://atlascloud/generation-card.html";
const VARIANTS = [
  "image",
  "images",
  "video",
  "audio",
  "workflow",
  "queued",
  "running",
  "failed",
  "canceled",
  "blocked",
  "expired",
  "quote",
  "quote_partial",
  "quote_unpriced",
  "quote_expired",
  "quote_low_balance",
  "history",
];

// 报价卡的模拟场景（不花钱）：开头是一张真能点的报价卡（去掉 sample 标记），
// 卡片点 Generate 时按场景回「已提交」、「报价过期」或「余额不足」。
const QUOTE_MOCKS = {
  "quote-submit": "submit",
  "quote-expires": "expired",
  "quote-no-balance": "balance",
  "quote-fail-retry": "fail",
  // ChatGPT 的做法：工具报错时不回错误结果，而是让卡片这次调用直接失败（报错原文夹在信息里）。
  "quote-chatgpt-error": "throw-route",
  "quote-chatgpt-uncertain": "throw-uncertain",
};

const chatgptStyleError = (text) =>
  new Error(
    `Error code: INVALID_ARGUMENT; Error: RuntimeException: Error calling MCP tool: [TextContent(type='text', text='${text}', annotations=None, meta=None)]`
  );

function mockQuoteCaller(outcome) {
  let polls = 0;
  const unsample = (result, overrides = {}) => {
    const card = { ...result._meta["atlascloud/card"], ...overrides };
    delete card.sample;
    return { ...result, _meta: { "atlascloud/card": card } };
  };
  return async (name, args) => {
    if (name === "atlas_card_selftest" || (name === "atlas_generate_video" && !args.confirmed)) {
      if (name === "atlas_generate_video") log("      mock re-quote", JSON.stringify({ idempotency_key: args.idempotency_key, params: args.params }));
      return unsample(await callTool("atlas_card_selftest", { variant: "quote" }));
    }
    if (name === "atlas_generate_video") {
      log("      mock got", JSON.stringify({ keys: Object.keys(args).sort(), idempotency_key: args.idempotency_key, params: args.params }));
      await new Promise((r) => setTimeout(r, 1200));
      if (outcome === "throw-route") throw chatgptStyleError("Error: model[black-forest-labs/flux-schnell] router not found");
      if (outcome === "throw-uncertain") {
        throw chatgptStyleError(
          "Error: A previous request with this idempotency key ended without a confirmed response; check predictions or billing before starting a new request"
        );
      }
      if (outcome === "expired") {
        return { isError: true, content: [{ type: "text", text: "Generation confirmation expired. Request a new quote. No billable request was submitted." }] };
      }
      if (outcome === "balance") {
        return { isError: true, content: [{ type: "text", text: "Error: Insufficient balance. Please top up your account at: https://www.atlascloud.ai/console/billing" }] };
      }
      // 提交结果带上 retry（服务端包装层会这么给），失败后卡片用它重新报价。
      return unsample(await callTool("atlas_card_selftest", { variant: "running" }), {
        prediction_id: "mock_quote",
        retry: { tool: "atlas_generate_video", arguments: { model: args.model, params: args.params } },
      });
    }
    if (name === "atlas_card_status") {
      polls += 1;
      await new Promise((r) => setTimeout(r, 1500));
      const done = outcome === "fail" ? "failed" : "video";
      return unsample(await callTool("atlas_card_selftest", { variant: polls < 2 ? "running" : done }), { prediction_id: "mock_quote" });
    }
    return callTool(name, args);
  };
}

const $ = (selector) => document.querySelector(selector);
const logEl = $("#log");

function log(...parts) {
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString();
  line.textContent = `${time}  ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  logEl.prepend(line);
}

async function callTool(name, args) {
  const response = await fetch("/api/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

let resource;
async function cardResource() {
  if (!resource) {
    const body = await fetch(`/api/resource?uri=${encodeURIComponent(CARD_URI)}`).then((r) => r.json());
    resource = body.contents[0];
  }
  return resource;
}

// 和真宿主一样只放行资源里声明的来源：没声明的图片、视频会加载失败。
function cspFor(meta) {
  const domains = (meta?.ui?.csp?.resourceDomains ?? []).join(" ");
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${domains}`,
    `media-src blob: ${domains}`,
    `font-src data: ${domains}`,
    "connect-src 'none'",
  ].join("; ");
}

function settings() {
  return {
    host: $("#host").value,
    theme: $("#theme").value,
    width: Number($("#width").value),
  };
}

// 不花钱验证卡片的自动刷新：开头给一张「生成中」，卡片调 atlas_card_status 时
// 前两次仍回「生成中」，第三次回成片。数据取自测试卡片，去掉 sample 标记让卡片照常轮询。
function mockPollCaller() {
  let polls = 0;
  const strip = (result) => {
    const card = { ...result._meta["atlascloud/card"], prediction_id: "mock_poll" };
    delete card.sample;
    return { ...result, _meta: { "atlascloud/card": card } };
  };
  return async (name, args) => {
    if (name === "atlas_card_status") {
      polls += 1;
      await new Promise((r) => setTimeout(r, 1500));
      const variant = polls < 3 ? "running" : "video";
      return strip(await callTool("atlas_card_selftest", { variant }));
    }
    return strip(await callTool("atlas_card_selftest", { variant: "running" }));
  };
}

async function mountCard(slot, tool, args, caller = callTool) {
  const res = await cardResource();
  const s = settings();
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  iframe.setAttribute("title", `${tool} card`);
  iframe.className = "card-frame";
  slot.replaceChildren(iframe);

  const hostContext = {
    theme: s.theme,
    platform: "web",
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
    locale: "en-US",
    containerDimensions: { maxWidth: s.width },
  };
  const bridge = new AppBridge(
    null,
    { name: s.host === "claude" ? "Claude" : "ChatGPT", version: "1.0.0" },
    { openLinks: {}, serverTools: {}, downloadFile: {}, message: { text: {} }, updateModelContext: { text: {} } },
    { hostContext }
  );
  bridge.onsizechange = ({ height }) => {
    if (height) iframe.style.height = `${Math.ceil(height)}px`;
  };
  bridge.oncalltool = async (params) => {
    log("card → tools/call", params.name, params.arguments ?? {});
    const result = await caller(params.name, params.arguments ?? {});
    log("      ← state", result?._meta?.["atlascloud/card"]?.state ?? (result.isError ? "error" : "?"));
    return result;
  };
  // 全屏：把这张卡的外框放大到 720 宽，再告诉卡片现在是全屏。
  bridge.onrequestdisplaymode = async ({ mode }) => {
    log("card → display mode", mode);
    const pane = slot.closest(".chat");
    if (pane) pane.style.width = mode === "fullscreen" ? "748px" : "";
    bridge.setHostContext({ ...hostContext, displayMode: mode });
    return { mode };
  };
  bridge.onopenlink = async ({ url }) => {
    log("card → open link", url);
    window.open(url, "_blank", "noopener");
    return {};
  };
  bridge.ondownloadfile = async ({ contents }) => {
    log("card → download", contents.map((c) => c.uri ?? c.resource?.uri));
    return {};
  };
  bridge.onupdatemodelcontext = async (params) => {
    log("card → model context", (params.content ?? []).map((c) => c.text ?? c.type).join(" "));
    return {};
  };
  bridge.onmessage = async (params) => {
    log("card → message", params.content.map((c) => c.text ?? c.type).join(" "));
    return {};
  };
  bridge.oninitialized = async () => {
    await bridge.sendToolInput({ arguments: args });
    try {
      const result = await caller(tool, args);
      await bridge.sendToolResult(result);
      log(`${tool}`, args, "→", result?._meta?.["atlascloud/card"]?.state ?? "no card data");
    } catch (error) {
      log(`${tool} failed`, String(error));
    }
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
  iframe.srcdoc = res.text.replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="${cspFor(res._meta)}">`
  );
}

function hostFrame(label) {
  const wrap = document.createElement("section");
  wrap.className = "pane";
  wrap.innerHTML = `<h2></h2><div class="chat"><div class="app-name"><span class="logo">A</span>Atlas Cloud</div><div class="slot"></div></div>`;
  wrap.querySelector("h2").textContent = label;
  return wrap;
}

function applyHostLook() {
  const s = settings();
  document.body.dataset.host = s.host;
  document.body.dataset.theme = s.theme;
  document.documentElement.style.setProperty("--card-width", `${s.width}px`);
}

async function renderAll() {
  applyHostLook();
  const grid = $("#grid");
  grid.replaceChildren();
  const id = $("#prediction").value.trim();
  const jobs = [];
  if (id) {
    const pane = hostFrame(`atlas_get_prediction · ${id}`);
    grid.append(pane);
    jobs.push(mountCard(pane.querySelector(".slot"), "atlas_get_prediction", { prediction_id: id }));
  }
  const only = $("#variant").value;
  for (const [label, outcome] of Object.entries(QUOTE_MOCKS)) {
    if (only && only !== label) continue;
    const pane = hostFrame(`mock · ${label}`);
    grid.append(pane);
    jobs.push(mountCard(pane.querySelector(".slot"), "atlas_generate_video", { model: "bytedance/seedance-2.5/text-to-video", idempotency_key: "mock-key" }, mockQuoteCaller(outcome)));
  }
  if (!only || only === "poll") {
    const pane = hostFrame("mock · running → refresh → result");
    grid.append(pane);
    jobs.push(mountCard(pane.querySelector(".slot"), "atlas_get_prediction", { prediction_id: "mock_poll" }, mockPollCaller()));
  }
  for (const variant of only ? (only === "poll" || only in QUOTE_MOCKS ? [] : [only]) : VARIANTS) {
    const pane = hostFrame(`atlas_card_selftest · ${variant}`);
    grid.append(pane);
    jobs.push(mountCard(pane.querySelector(".slot"), "atlas_card_selftest", { variant }));
  }
  await Promise.all(jobs);
}

const variantSelect = $("#variant");
for (const variant of ["poll", ...Object.keys(QUOTE_MOCKS), ...VARIANTS]) {
  const option = document.createElement("option");
  option.value = variant;
  option.textContent = variant;
  variantSelect.append(option);
}

const params = new URLSearchParams(location.search);
for (const key of ["host", "theme", "width", "variant", "prediction"]) {
  if (params.has(key)) $(`#${key}`).value = params.get(key);
}
for (const el of document.querySelectorAll("select")) el.addEventListener("change", renderAll);
$("#load").addEventListener("click", renderAll);

fetch("/api/tools")
  .then((r) => r.json())
  .then(({ tools }) => {
    const withCard = tools.filter((t) => t._meta?.ui?.resourceUri).map((t) => t.name);
    log("tools with card:", withCard.join(", "));
  });
renderAll();
