// 报价确认卡：参数小标签、由生成工具结果拼卡片数据、包装层、工具元数据，
// 以及卡片前端的报价兜底解析和过期判断。
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inputsOf, promptOf } from "../src/apps/card-params.js";
import {
  CARD_GENERATION_TOOLS,
  generationResultCard,
  settingsChips,
  withAvailableBalance,
  withGenerationCard,
  withQuoteDetails,
} from "../src/apps/generation-quote.js";
import {
  RATE_LIMIT_WAIT_MS,
  cardFromToolResult,
  formatUsd,
  isModelUnavailable,
  isRateLimited,
} from "../ui/generation-card/card.js";
import {
  failureState,
  initialQuoteState,
  priceChanged,
  quoteExpired,
  thrownErrorText,
  thrownFailureState,
} from "../ui/generation-card/quote.js";

const UI_MIME = "text/html;profile=mcp-app";
// 地址里带页面内容哈希，跟着构建变，测试里读服务端导出的那个。
let CARD_URI = "";

function withEnv(values: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** clientRendersCards 只读 server.server.getClientCapabilities()。 */
function fakeServer(rendersCards: boolean): McpServer {
  const capabilities = rendersCards
    ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } } }
    : {};
  return { server: { getClientCapabilities: () => capabilities } } as unknown as McpServer;
}

const QUOTE_RESULT = {
  structuredContent: {
    model_id: "bytedance/seedance-2.5/text-to-video",
    model_name: "Seedance 2.5 Text-to-Video",
    kind: "video",
    status: "confirmation_required",
    confirmation_token: "c2.1793083000.abcdefghijklmnop",
    confirmation_valid_seconds: 600,
    idempotency_key: "7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11",
    pricing: { actual: { base_price: "0.1" } },
    estimated_cost_usd: 1.514799,
  },
  content: [{ type: "text" as const, text: "Confirmation required." }],
};

const VIDEO_ARGS = {
  idempotency_key: "7d0b2f5e-0d8c-4a43-9c55-6f1f2d6a0b11",
  model: "bytedance/seedance-2.5/text-to-video",
  params: { prompt: "a paper boat", resolution: "720p", duration: 5, ratio: "16:9", generate_audio: true },
};


before(async () => {
  CARD_URI = (await import("../src/apps/generation-card.js")).GENERATION_CARD_URI;
});

test("参数小标签：按设计稿顺序，只认常见字段，认不出就不显示", () => {
  assert.deepEqual(
    settingsChips({ prompt: "x", resolution: "1080p", duration: 10, aspect_ratio: "16:9", generate_audio: true }),
    ["1080p", "10 s", "16:9", "Audio"]
  );
  assert.deepEqual(settingsChips({ size: "1024*1024" }), ["1024×1024"]);
  assert.deepEqual(settingsChips({ image_size: { width: 1280, height: 720 } }), ["1280×720"]);
  assert.deepEqual(settingsChips({ ratio: "9:16", sound: true }), ["9:16", "Audio"]);
  assert.deepEqual(settingsChips({ num_images: 4 }), ["4 images"]);
  assert.deepEqual(settingsChips({ num_images: 1, audio: "https://x.test/a.mp3" }), []);
  assert.deepEqual(settingsChips(undefined), []);
});

test("报价结果拼成报价卡：确认要的东西齐全，参数里去掉确认字段", () => {
  const card = generationResultCard("atlas_generate_video", { ...VIDEO_ARGS, confirmed: false }, QUOTE_RESULT.structuredContent);
  assert.equal(card?.state, "quote");
  assert.equal(card?.prediction_id, "");
  assert.equal(card?.model_name, "Seedance 2.5 Text-to-Video");
  assert.equal(card?.model_type, "Video");
  assert.equal(card?.quote?.tool, "atlas_generate_video");
  assert.deepEqual(card?.quote?.arguments, { model: VIDEO_ARGS.model, params: VIDEO_ARGS.params });
  assert.equal(card?.quote?.idempotency_key, VIDEO_ARGS.idempotency_key);
  assert.equal(card?.quote?.confirmation_token, "c2.1793083000.abcdefghijklmnop");
  assert.equal(card?.quote?.estimated_usd, 1.514799);
  assert.deepEqual(card?.quote?.settings, ["720p", "5 s", "16:9", "Audio"]);
  const validFor = Date.parse(card!.quote!.expires_at!) - Date.now();
  assert.ok(validFor > 590_000 && validFor <= 600_000, `expires in ${validFor} ms`);
});

test("快速生成的参数平铺在顶层，也能做出小标签", () => {
  const card = generationResultCard(
    "atlas_quick_generate",
    { idempotency_key: "k", type: "Video", prompt: "x", duration: 8, aspect_ratio: "9:16" },
    { ...QUOTE_RESULT.structuredContent, estimated_cost_usd: undefined, estimate_partial: true }
  );
  assert.deepEqual(card?.quote?.settings, ["8 s", "9:16"]);
  assert.equal(card?.quote?.estimated_usd, undefined);
  assert.equal(card?.quote?.partial, true);
});

test("已提交的结果拼成进度卡；同步出结果的直接是作品卡；认不出的不挂卡", () => {
  const submitted = generationResultCard("atlas_generate_image", { idempotency_key: "k", confirmed: true, confirmation_token: "c", model: "black-forest-labs/flux-schnell", params: { prompt: "x" } }, {
    prediction_id: "p1",
    model_id: "black-forest-labs/flux-schnell",
    model_name: "Flux Schnell",
    kind: "image",
    status: "submitted",
  });
  assert.equal(submitted?.state, "running");
  assert.equal(submitted?.prediction_id, "p1");
  assert.equal(submitted?.model_type, "Image");
  // 失败后卡片用它重新报价：原工具和参数，去掉确认字段。
  assert.deepEqual(submitted?.retry, {
    tool: "atlas_generate_image",
    arguments: { model: "black-forest-labs/flux-schnell", params: { prompt: "x" } },
  });

  const finished = generationResultCard("atlas_generate_image", {}, {
    prediction_id: "p2",
    model_id: "black-forest-labs/flux-schnell",
    model_name: "Flux Schnell",
    kind: "image",
    status: "completed",
    outputs: ["https://atlas-media.oss-us-west-1.aliyuncs.com/x.jpg"],
  });
  assert.equal(finished?.state, "succeeded");
  assert.equal(finished?.media[0]?.kind, "image");

  assert.equal(generationResultCard("atlas_generate_image", {}, undefined), undefined);
  assert.equal(generationResultCard("atlas_generate_image", {}, { status: "submitted" }), undefined);
});

test("包装层：卡片关着原样返回；打开时挂卡片，客户端能渲染卡片才多一句提示", async () => {
  const handler = async () => ({ ...QUOTE_RESULT, content: [...QUOTE_RESULT.content] });

  let restore = withEnv({ MCP_UI_CARDS: undefined });
  try {
    const off = await withGenerationCard(fakeServer(true), "atlas_generate_video", handler)(VIDEO_ARGS, {});
    assert.equal(off._meta, undefined);
    assert.equal(off.content.length, 1);
  } finally {
    restore();
  }

  restore = withEnv({ MCP_UI_CARDS: "1" });
  try {
    const plain = await withGenerationCard(fakeServer(false), "atlas_generate_video", handler)(VIDEO_ARGS, {});
    assert.equal((plain._meta?.["atlascloud/card"] as { state: string }).state, "quote");
    assert.equal(plain.content.length, 1);

    const rich = await withGenerationCard(fakeServer(true), "atlas_generate_video", handler)(VIDEO_ARGS, {});
    assert.equal(rich.content.length, 2);
    assert.match((rich.content[1] as { text: string }).text, /Generate button/);

    const failed = await withGenerationCard(fakeServer(true), "atlas_generate_video", async () => ({
      isError: true,
      content: [{ type: "text" as const, text: "Error" }],
    }))(VIDEO_ARGS, {});
    assert.equal(failed._meta, undefined);
  } finally {
    restore();
  }
});

test("卡片打开时四个生成工具都挂卡片页面，转写不挂", async () => {
  const restore = withEnv({ MCP_UI_CARDS: "1" });
  const { createAtlasCloudServer } = await import("../src/server.js");
  const server = createAtlasCloudServer("stdio");
  const client = new Client({ name: "quote-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const name of CARD_GENERATION_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.equal((tool?._meta?.ui as { resourceUri?: string })?.resourceUri, CARD_URI, name);
    }
    const transcribe = tools.find((candidate) => candidate.name === "atlas_transcribe_audio");
    assert.equal(transcribe?._meta?.ui, undefined);
  } finally {
    await client.close();
    await server.close();
    restore();
  }
});

test("卡片前端：宿主丢了 _meta 时用工具名和参数拼报价卡；没有工具名就只显示报价", () => {
  const card = cardFromToolResult(QUOTE_RESULT, { tool: "atlas_generate_video", args: { ...VIDEO_ARGS, confirmed: true } });
  assert.equal(card?.state, "quote");
  assert.equal(card?.quote?.tool, "atlas_generate_video");
  assert.deepEqual(card?.quote?.arguments, { model: VIDEO_ARGS.model, params: VIDEO_ARGS.params });
  assert.equal(card?.quote?.estimated_usd, 1.514799);

  const noTool = cardFromToolResult(QUOTE_RESULT);
  assert.equal(noTool?.state, "quote");
  assert.equal(noTool?.quote, undefined);

  // 生成工具「已提交」的结构化结果，前端兜底也认成进行中。
  const submitted = cardFromToolResult({ structuredContent: { prediction_id: "p1", status: "submitted" } });
  assert.equal(submitted?.state, "running");
});

test("卡片前端：报价过期判断、初始状态、金额两位小数", () => {
  const base = { tool: "t", arguments: {}, idempotency_key: "k", confirmation_token: "c", settings: [] };
  assert.equal(quoteExpired({ ...base, expires_at: new Date(Date.now() - 1000).toISOString() }), true);
  assert.equal(quoteExpired({ ...base, expires_at: new Date(Date.now() + 60_000).toISOString() }), false);
  assert.equal(quoteExpired({ ...base }), false);

  const card = { state: "quote" as const, prediction_id: "", media: [] };
  assert.deepEqual(initialQuoteState({ ...card, quote: { ...base } }), { phase: "ready" });
  assert.deepEqual(
    initialQuoteState({ ...card, quote: { ...base, expires_at: new Date(Date.now() - 1).toISOString() } }),
    { phase: "expired" }
  );
  assert.deepEqual(initialQuoteState({ ...card, quote: { ...base, problem: "insufficient_balance" } }), {
    phase: "low_balance",
  });

  assert.equal(formatUsd(1.514799), "$1.51");
  assert.equal(formatUsd(24.12), "$24.12");
  assert.equal(formatUsd(0.003), "$0.003");
  assert.equal(formatUsd(0.2593), "$0.2593");
});

test("卡片前端：ChatGPT 把工具报错变成调用失败时，取出原文并显示对应状态", () => {
  // 10-27 在 test 环境的 ChatGPT 里抓到的真实报错（call_mcp 返回 400）。
  const wrap = (text: string) =>
    new Error(
      `Error code: INVALID_ARGUMENT; Error: RuntimeException: Error calling MCP tool: [TextContent(type='text', text='${text}', annotations=None, meta=None)]`
    );
  const notRouted = thrownErrorText(wrap("Error: model[black-forest-labs/flux-schnell] router not found"));
  assert.equal(notRouted, "model[black-forest-labs/flux-schnell] router not found");
  // 网关没有这个模型的路由：设计稿「模型暂时不可用」（Retry / Switch model）。
  assert.deepEqual(failureState(notRouted), { phase: "model_unavailable", message: notRouted });

  const uncertain = thrownErrorText(
    wrap(
      "Error: A previous request with this idempotency key ended without a confirmed response; check predictions or billing before starting a new request"
    )
  );
  // 上一次没拿到确定回答：卡片先自己核实，不直接把「不确定」丢给用户。
  assert.deepEqual(failureState(uncertain), { phase: "verifying" });

  assert.deepEqual(
    failureState(thrownErrorText(wrap("Generation confirmation expired. Request a new quote. No billable request was submitted."))),
    { phase: "expired" }
  );
  assert.deepEqual(
    failureState("Insufficient balance. Please top up your account at: https://www.atlascloud.ai/console/billing"),
    { phase: "low_balance" }
  );
  // 取不到里层文字时用整条信息；什么都没有时不编造原因。
  assert.equal(thrownErrorText(new Error("Request timed out")), "Request timed out");
  assert.deepEqual(failureState(thrownErrorText(undefined)), { phase: "error", message: undefined });
});

test("卡片前端：提交没拿到确定的回答时先核实，服务端明确拒收时直接报错", () => {
  const wrap = (text: string) =>
    new Error(`Error calling MCP tool: [TextContent(type='text', text="${text}", annotations=None, meta=None)]`);
  // 服务端给结果不明的提交加的那句话（src/utils/error-handler.ts）。
  const unconfirmed =
    "Error: Atlas Cloud didn't answer in time. The request ended without a confirmed response, so it may already have gone through. Check recent predictions or billing before sending it again.";
  assert.deepEqual(failureState(unconfirmed.replace(/^Error:\s*/, "")), { phase: "verifying" });
  assert.deepEqual(thrownFailureState(wrap(unconfirmed)), { phase: "verifying" });
  // 宿主把调用掐了、连接断了：取不到服务端原话，请求可能已经到了，也先核实。
  assert.deepEqual(thrownFailureState(new Error("MCP error -32001: Request timed out")), { phase: "verifying" });
  assert.deepEqual(thrownFailureState(undefined), { phase: "verifying" });
  assert.deepEqual(
    failureState("The Atlas Cloud API accepted the video request but did not return a prediction ID. No automatic retry was attempted."),
    { phase: "verifying" }
  );
  // 取得到原话且是明确的拒绝：按原因显示，不去核实。
  assert.deepEqual(thrownFailureState(wrap("Error: model[x/y] router not found")), {
    phase: "model_unavailable",
    message: "model[x/y] router not found",
  });
  const rejected =
    "A previous request with this idempotency key was rejected by Atlas Cloud before it started, so nothing was charged; use a new idempotency key to try again";
  assert.deepEqual(failureState(rejected), { phase: "error", message: rejected });
});

test("卡片前端：余额不足带回余额、令牌对不上、限流、模型不可用各有自己的状态", () => {
  // 服务端在余额不足的报错后面附上可用余额（src/apps/generation-quote.ts 的 withAvailableBalance）。
  assert.deepEqual(
    failureState("Insufficient balance. Please top up your account at: https://www.atlascloud.ai/console/billing Available balance: $8.50."),
    { phase: "low_balance", balanceUsd: 8.5 }
  );
  assert.deepEqual(failureState("Insufficient balance. Available balance: -$1,203.40."), {
    phase: "low_balance",
    balanceUsd: -1203.4,
  });

  // 确认令牌对不上（src/services/generation-confirmation.ts 的原话）：卡片先重新报价比价格。
  const mismatch =
    "Generation confirmation does not match this request: the arguments, price or user changed, or the token was not copied exactly. Request a new quote. No billable request was submitted.";
  assert.deepEqual(failureState(mismatch), { phase: "settings_changed" });
  assert.deepEqual(failureState("Generation confirmation is invalid. Request a new quote. No billable request was submitted."), {
    phase: "settings_changed",
  });

  // 服务端 429 的那句（src/utils/error-handler.ts）：30 秒后才放开 Retry。
  assert.deepEqual(failureState("Rate limit exceeded. Please wait and try again later.", 1_000), {
    phase: "rate_limited",
    retryAt: 1_000 + RATE_LIMIT_WAIT_MS,
  });

  assert.equal(isRateLimited("Too Many Requests (429): the provider rate limit was exceeded"), true);
  assert.equal(isRateLimited("prediction a429b failed"), false);
  assert.equal(isModelUnavailable("The model is temporarily unavailable: ServerOverloaded"), true);
  assert.equal(isModelUnavailable("Upstream returned 503 Service Unavailable"), true);
  assert.equal(isModelUnavailable("No available channel for model x/y"), true);
  // 读不到输入说明、拿不到价格不算模型不可用。
  assert.equal(isModelUnavailable('The live input schema for model "x/y" is unavailable.'), false);
  assert.equal(isModelUnavailable("Current pricing metadata is unavailable for this model."), false);
  assert.equal(isModelUnavailable(undefined), false);
});

test("卡片前端：重新报价后按显示金额判断价格变没变；测试卡片直接给问题状态", () => {
  const base = { tool: "t", arguments: {}, idempotency_key: "k", confirmation_token: "c", settings: [] };
  assert.equal(priceChanged(24.12, { ...base, estimated_usd: 26.4 }), true);
  assert.equal(priceChanged(1.514799, { ...base, estimated_usd: 1.5148 }), false);
  assert.equal(priceChanged(undefined, { ...base, estimated_usd: 26.4 }), false);
  assert.equal(priceChanged(24.12, { ...base }), false);

  const card = { state: "quote" as const, prediction_id: "", media: [] };
  assert.deepEqual(initialQuoteState({ ...card, quote: { ...base, problem: "insufficient_balance", sample_balance_usd: 0.42 } }), {
    phase: "low_balance",
    balanceUsd: 0.42,
  });
  assert.deepEqual(initialQuoteState({ ...card, quote: { ...base, problem: "price_changed", sample_previous_usd: 1.34 } }), {
    phase: "price_changed",
    previousUsd: 1.34,
  });
  assert.deepEqual(initialQuoteState({ ...card, quote: { ...base, problem: "rate_limited" } }, 5), {
    phase: "rate_limited",
    retryAt: 5 + RATE_LIMIT_WAIT_MS,
  });
  assert.deepEqual(initialQuoteState({ ...card, quote: { ...base, problem: "model_unavailable" } }), {
    phase: "model_unavailable",
  });
});

test("余额不足的报错后面附上可用余额；查不到就原样返回，其他报错不查", async () => {
  const restore = withEnv({ ATLASCLOUD_API_KEY: "test-key" });
  const calls: string[] = [];
  let reply: () => Response = () =>
    new Response(JSON.stringify({ object: "balance", scope: "user", available: { value: "8.5", currency: "USD" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fetcher = (async (url: string | URL) => {
    calls.push(String(url));
    return reply();
  }) as unknown as typeof fetch;
  const lowBalance = () => ({
    isError: true,
    content: [{ type: "text" as const, text: "Error: Insufficient balance. Please top up your account at: https://www.atlascloud.ai/console/billing" }],
  });
  try {
    const withBalance = await withAvailableBalance(lowBalance(), { fetcher });
    assert.match((withBalance.content[0] as { text: string }).text, /billing Available balance: \$8\.50\.$/);
    assert.match(calls[0] ?? "", /\/balance$/);

    reply = () => new Response(JSON.stringify({ error: "insufficient_scope" }), { status: 403 });
    const unchanged = await withAvailableBalance(lowBalance(), { fetcher });
    assert.deepEqual(unchanged, lowBalance());

    calls.length = 0;
    const other = { isError: true, content: [{ type: "text" as const, text: "Error: Rate limit exceeded." }] };
    assert.equal(await withAvailableBalance(other, { fetcher }), other);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

/** /public/v1/account 和 /balance 的假接口；status 给 404/403 模拟后端没上或没权限。 */
function accountFetcher(
  calls: string[],
  status: { account?: number; balance?: number } = {},
  accountName = "Ada Lovelace"
): typeof fetch {
  return (async (url: string | URL) => {
    const path = String(url);
    calls.push(path);
    const json = (body: unknown, code = 200) =>
      new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
    if (path.endsWith("/account")) {
      return status.account
        ? json({ error: "not_found" }, status.account)
        : json({
            object: "account",
            account: { id: "acc_1", name: accountName, type: "personal" },
            user: { name: "Ada Lovelace", email: "ada@example.com" },
          });
    }
    return status.balance
      ? json({ error: "insufficient_scope" }, status.balance)
      : json({
          object: "balance",
          scope: "user",
          account: { id: "acc_1", name: accountName, type: "personal" },
          available: { value: "8.5", currency: "USD" },
        });
  }) as unknown as typeof fetch;
}

const QUOTE_WITH_PARAMS = {
  ...QUOTE_RESULT,
  structuredContent: {
    ...QUOTE_RESULT.structuredContent,
    estimate_reason: "settles_on_usage",
    // 服务端补了默认值：调用方没给分辨率和时长。
    params: { prompt: "a paper boat", resolution: "720p", duration: 5, ratio: "16:9" },
  },
};

test("报价补上主要参数和扣费账户：文字和结构化结果都有，卡片显示账户和余额", async () => {
  const restore = withEnv({ ATLASCLOUD_API_KEY: "test-key", MCP_UI_CARDS: "1" });
  const calls: string[] = [];
  try {
    const result = await withQuoteDetails(
      { ...QUOTE_WITH_PARAMS, content: [...QUOTE_WITH_PARAMS.content] },
      { fetcher: accountFetcher(calls) }
    );
    const extra = (result.content[1] as { text: string }).text;
    assert.match(extra, /\*\*Settings\*\*: 720p · 5 s · 16:9/);
    assert.match(extra, /\*\*Billing account\*\*: Ada Lovelace \(personal account, ada@example\.com\) · \$8\.50 available/);
    assert.deepEqual((result.structuredContent as Record<string, unknown>).billing_account, {
      name: "Ada Lovelace",
      type: "personal",
      user_name: "Ada Lovelace",
      user_email: "ada@example.com",
      available_usd: 8.5,
    });
    assert.equal(calls.length, 2);

    const card = await withGenerationCard(
      fakeServer(false),
      "atlas_generate_video",
      async () => ({ ...QUOTE_WITH_PARAMS, content: [...QUOTE_WITH_PARAMS.content] }),
      { fetcher: accountFetcher([]) }
    )({ ...VIDEO_ARGS, params: { prompt: "a paper boat" } }, {});
    const quote = (card._meta?.["atlascloud/card"] as { quote: Record<string, unknown> }).quote;
    // 参数标签按实际提交的参数，不按调用方给的（这里调用方没给分辨率）。
    assert.deepEqual(quote.settings, ["720p", "5 s", "16:9"]);
    assert.deepEqual(quote.account, { name: "Ada Lovelace", email: "ada@example.com", balance_usd: 8.5 });
    assert.equal(quote.settles_on_usage, true);
  } finally {
    restore();
  }
});

test("扣费账户查不到：后端没上 /account 时退回余额接口里的账户名；都没有就只补参数；不是报价不查", async () => {
  const restore = withEnv({ ATLASCLOUD_API_KEY: "test-key" });
  try {
    const noAccountApi = await withQuoteDetails(
      { ...QUOTE_WITH_PARAMS, content: [...QUOTE_WITH_PARAMS.content] },
      { fetcher: accountFetcher([], { account: 404 }) }
    );
    assert.match((noAccountApi.content[1] as { text: string }).text, /Billing account\*\*: Ada Lovelace \(personal account\) · \$8\.50 available/);

    const nothing = await withQuoteDetails(
      { ...QUOTE_WITH_PARAMS, content: [...QUOTE_WITH_PARAMS.content] },
      { fetcher: accountFetcher([], { account: 404, balance: 403 }) }
    );
    const text = (nothing.content[1] as { text: string }).text;
    assert.match(text, /Settings/);
    assert.doesNotMatch(text, /Billing account/);
    assert.equal((nothing.structuredContent as Record<string, unknown>).billing_account, undefined);

    // 只有账户、余额没权限：显示账户不显示余额。
    const noBalance = await withQuoteDetails(
      { ...QUOTE_WITH_PARAMS, content: [...QUOTE_WITH_PARAMS.content] },
      { fetcher: accountFetcher([], { balance: 403 }) }
    );
    assert.match((noBalance.content[1] as { text: string }).text, /ada@example\.com\)\nInclude/);

    const calls: string[] = [];
    const submitted = { structuredContent: { status: "submitted", prediction_id: "p" }, content: [] };
    assert.equal(await withQuoteDetails(submitted, { fetcher: accountFetcher(calls) }), submitted);
    const failed = { isError: true, content: [{ type: "text" as const, text: "Error" }] };
    assert.equal(await withQuoteDetails(failed, { fetcher: accountFetcher(calls) }), failed);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("卡片前端：宿主丢了 _meta 时，报价兜底也带上扣费账户和结算方式", () => {
  const card = cardFromToolResult(
    {
      structuredContent: {
        ...QUOTE_WITH_PARAMS.structuredContent,
        billing_account: { name: "Ada Lovelace", user_email: "ada@example.com", available_usd: -1.25 },
      },
    },
    { tool: "atlas_generate_video", args: VIDEO_ARGS }
  );
  assert.deepEqual(card?.quote?.account, { name: "Ada Lovelace", email: "ada@example.com", balance_usd: -1.25 });
  assert.equal(card?.quote?.settles_on_usage, true);
});

test("个人账户没有名字时用用户名兜底（test 上实测 account.name 为空）", async () => {
  const restore = withEnv({ ATLASCLOUD_API_KEY: "test-key" });
  try {
    const result = await withQuoteDetails(
      { ...QUOTE_WITH_PARAMS, content: [...QUOTE_WITH_PARAMS.content] },
      { fetcher: accountFetcher([], {}, "") }
    );
    assert.match(
      (result.content[1] as { text: string }).text,
      /Billing account\*\*: Ada Lovelace \(personal account, ada@example\.com\) · \$8\.50 available/
    );
  } finally {
    restore();
  }
});

test("任务内容和输入素材：提示词截断，参数里的链接不认字段名、去重、最多 8 个", () => {
  assert.equal(promptOf({ prompt: "  a   paper\nboat  " }), "a paper boat");
  assert.equal(promptOf({ text: "hello" }), "hello");
  assert.equal(promptOf({ user_prompt: "Orange earbuds, summer campaign" }), "Orange earbuds, summer campaign");
  assert.equal(promptOf({ image: "https://x/a.jpg" }), undefined);
  const long = promptOf({ prompt: "x".repeat(400) })!;
  assert.equal(long.length, 280);
  assert.ok(long.endsWith("…"));

  const inputs = inputsOf({
    prompt: "https://not-an-input.example/a.jpg",
    model: "https://x/model",
    image: "https://cdn.example/products/front%20shot.jpg",
    reference_images: ["https://cdn.example/products/front%20shot.jpg", "https://cdn.example/b.png"],
    refers: [{ url: "https://cdn.example/clip.mp4" }],
    duration: 5,
    note: "not a link",
  });
  assert.deepEqual(inputs, [
    { url: "https://cdn.example/products/front%20shot.jpg", name: "front shot.jpg" },
    { url: "https://cdn.example/b.png", name: "b.png" },
    { url: "https://cdn.example/clip.mp4", name: "clip.mp4" },
  ]);
  const many = inputsOf({ images: Array.from({ length: 12 }, (_, i) => `https://cdn.example/${i}.jpg`) });
  assert.equal(many.length, 8);
  assert.equal(inputsOf({ image: "https://cdn.example/" })[0]!.name, "Input 1");
});

test("报价卡带任务内容和素材缩略图；提交后的进度卡带实际提交的参数标签", () => {
  const quote = generationResultCard("atlas_generate_video", VIDEO_ARGS, {
    ...QUOTE_RESULT.structuredContent,
    params: { prompt: "a paper boat", image: "https://cdn.example/boat.jpg", resolution: "720p", duration: 5 },
  });
  assert.equal(quote?.quote?.prompt, "a paper boat");
  assert.deepEqual(quote?.quote?.inputs, [{ url: "https://cdn.example/boat.jpg", name: "boat.jpg", kind: "image" }]);

  // 调用方只给了提示词，服务端补了 720p、5 秒：进度卡按实际提交的显示。
  const submitted = generationResultCard(
    "atlas_generate_video",
    { ...VIDEO_ARGS, params: { prompt: "a paper boat" } },
    {
      prediction_id: "p1",
      model_id: "bytedance/seedance-2.5/text-to-video",
      model_name: "Seedance 2.5",
      kind: "video",
      status: "submitted",
      params: { prompt: "a paper boat", resolution: "720p", duration: 5, ratio: "16:9" },
    }
  );
  assert.equal(submitted?.state, "running");
  assert.deepEqual(submitted?.settings, ["720p", "5 s", "16:9"]);
});
