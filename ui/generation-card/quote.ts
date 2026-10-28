// 报价确认卡：设计稿「报价确认 · Quote Confirm」。
// 用户在卡里点 Generate，卡片带着确认令牌再调一次同一个生成工具（和模型在对话里确认走同一条路，
// 服务端照常核对报价）。提交成功后卡片变成进度卡，接着自己刷新到出结果。
// 不替用户往对话里发「确认」——那句话在 ChatGPT 里会被它自带的生图接走。

import type { App } from "@modelcontextprotocol/ext-apps";
import {
  type CardData,
  type QuoteInfo,
  RATE_LIMIT_WAIT_MS,
  formatClock,
  formatUsd,
  isModelUnavailable,
  isRateLimited,
  modelLabel,
  newIdempotencyKey,
  typeLabel,
} from "./card.js";
import { type ViewOptions, badge, button, h, head, retryButton, row } from "./view.js";

const BILLING_URL = "https://www.atlascloud.ai/console/billing";
const CHECK_TOOL = "atlas_card_check_submission";
/** 核实「到底提交没有」：每 5 秒问一次，两分钟还说不准就交给用户。服务端 90 秒查不到就会说没开始。 */
const CHECK_GAP_MS = 5_000;
const CHECK_BUDGET_MS = 120_000;

// quoting：重新报价中（不花钱）；submitting：带确认令牌提交中。两种按钮文案不同，别让用户以为在扣费。
// verifying：提交没拿到确定的回答，卡片在自己核实；核实两分钟还说不准才变成 uncertain，交给用户。
// canceled：用户在卡里取消了，什么都没提交。
// price_changed：确认时价格已经变了，卡片重新报了价，等用户按新价再确认。
// settings_changed：确认令牌和这次请求对不上、重新报价也没成，只能再要一份报价。
// rate_limited / model_unavailable：提交被拒，原因是限流 / 模型暂时用不了。
export type QuotePhase =
  | "ready"
  | "quoting"
  | "submitting"
  | "verifying"
  | "expired"
  | "low_balance"
  | "price_changed"
  | "settings_changed"
  | "rate_limited"
  | "model_unavailable"
  | "uncertain"
  | "canceled"
  | "error";

export interface QuoteState {
  phase: QuotePhase;
  /** phase = "error" / "model_unavailable" 时的原话。 */
  message?: string;
  /** low_balance：服务端随报错带回的可用余额（美元）。 */
  balanceUsd?: number;
  /** price_changed：用户先前同意的价格。 */
  previousUsd?: number;
  /** rate_limited：到这个时刻（毫秒）才放开 Retry。 */
  retryAt?: number;
}

export interface QuoteDeps {
  app: App;
  card(): CardData | undefined;
  setState(state: QuoteState): void;
  /** 收下一个工具结果（新报价或已提交），返回是否认得。carry 里的字段在结果没给时补上。 */
  accept(result: unknown, carry?: Partial<CardData>): boolean;
  /** 已提交后开始自己刷新。 */
  startPolling(): void;
  notice(text: string): void;
  openUrl(url: string): void;
}

export interface QuoteActions {
  /** 带确认令牌提交这份报价。 */
  confirm(): void;
  /** 用同一个幂等键重新报价（报价过期时：那一单从没提交过）。 */
  requote(): void;
  /**
   * 用新的幂等键重新报价。提交出过错之后只能这样：防重复扣费的锁会挡住同一个键的任何重试。
   * 只报价、不扣费，用户还要再确认一次。
   */
  requoteFresh(): void;
  editSettings(): void;
  /** 模型用不了：请模型换一个。 */
  switchModel(): void;
  /** 不生成了：卡片收起，告诉模型这一单作废。 */
  cancel(): void;
  /** 再核实一次刚才那一单开没开始。 */
  checkAgain(): void;
  topUp(): void;
  openInAtlas(): void;
}

function priceLabel(quote: QuoteInfo | undefined): string | null {
  return quote?.estimated_usd !== undefined ? formatUsd(quote.estimated_usd) : null;
}

function errorText(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks.find((block) => block.type === "text")?.text?.replace(/^Error:\s*/, "").slice(0, 240) ?? "";
}

/**
 * 卡片发起的工具调用失败时拿到的原因。ChatGPT 不把工具的错误结果交回卡片，而是让这次调用
 * 直接失败，报错原文夹在错误信息里（10-27 test 实测）：
 *   Error calling MCP tool: [TextContent(type='text', text='Error: …', …)]
 * 取出里面那段 text；取不到就用整条信息。
 */
export function thrownErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const inner = message.match(/text=(['"])([\s\S]*?)\1,\s*annotations/) ?? message.match(/text=(['"])([\s\S]*?)\1/);
  const text = inner ? inner[2] : message;
  return text.replace(/^Error:\s*/, "").trim().slice(0, 240);
}

/** 服务端在余额不足的报错后面附的那句 "Available balance: $8.50."（src/apps/generation-quote.ts）。 */
function balanceIn(text: string): number | undefined {
  const match = text.match(/available balance:?\s*(-?)\$(\d[\d,]*(?:\.\d+)?)/i);
  if (!match) return undefined;
  const value = Number.parseFloat(match[2]!.replace(/,/g, ""));
  return Number.isFinite(value) ? (match[1] ? -value : value) : undefined;
}

/** 按报错原文决定卡片显示哪种状态。 */
export function failureState(text: string, now = Date.now()): QuoteState {
  if (/confirmation expired|quote (has )?expired|expired\. request a new quote/i.test(text)) return { phase: "expired" };
  if (/insufficient balance|top up/i.test(text)) {
    const balance = balanceIn(text);
    return balance === undefined ? { phase: "low_balance" } : { phase: "low_balance", balanceUsd: balance };
  }
  // 提交没拿到确定的回答（服务端那句 "without a confirmed response"），或者防重复扣费的锁说上一次
  // 还没完：可能已经开跑，也可能没有。卡片先自己核实。
  // 上游收下了却没给任务号（"did not return a prediction ID"）也一样：可能已经在跑。
  if (/without a confirmed response|still in progress|did not return a prediction id/i.test(text)) return { phase: "verifying" };
  // 确认令牌和这次请求对不上（src/services/generation-confirmation.ts）。卡片带的参数不会变，
  // 多半是价格变了：卡片会先按同一个幂等键重新报价，比一比价格（见 createQuoteActions）。
  if (/does not match this request|confirmation is invalid|no quote was found for these exact arguments/i.test(text)) {
    return { phase: "settings_changed" };
  }
  if (isRateLimited(text)) return { phase: "rate_limited", retryAt: now + RATE_LIMIT_WAIT_MS };
  if (isModelUnavailable(text)) return { phase: "model_unavailable", message: text };
  return { phase: "error", message: text || undefined };
}

/**
 * 调用本身失败（不是工具回了错误结果）。能从报错里取出服务端的原话，就按原话判断；
 * 取不出来（宿主超时把调用掐了、连接断了），请求可能已经到了服务端，先核实。
 */
export function thrownFailureState(error: unknown): QuoteState {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!/text=(['"])/.test(message)) return { phase: "verifying" };
  return failureState(thrownErrorText(error));
}

/** 报价已过期：先看卡片自己的计时，没有计时就等服务端说。 */
export function quoteExpired(quote: QuoteInfo | undefined, now = Date.now()): boolean {
  if (!quote?.expires_at) return false;
  const at = Date.parse(quote.expires_at);
  return Number.isFinite(at) && at <= now;
}

export function initialQuoteState(card: CardData, now = Date.now()): QuoteState {
  const quote = card.quote;
  // 测试卡片直接显示某个问题状态。
  switch (quote?.problem) {
    case "insufficient_balance":
      return quote.sample_balance_usd !== undefined
        ? { phase: "low_balance", balanceUsd: quote.sample_balance_usd }
        : { phase: "low_balance" };
    case "price_changed":
      return quote.sample_previous_usd !== undefined
        ? { phase: "price_changed", previousUsd: quote.sample_previous_usd }
        : { phase: "price_changed" };
    case "settings_changed":
      return { phase: "settings_changed" };
    case "rate_limited":
      return { phase: "rate_limited", retryAt: now + RATE_LIMIT_WAIT_MS };
    case "model_unavailable":
      return { phase: "model_unavailable" };
  }
  return { phase: quoteExpired(quote) ? "expired" : "ready" };
}

/** 重新报价拿到的新价格和用户先前同意的不一样（按显示出来的金额比，不比浮点尾数）。 */
export function priceChanged(approvedUsd: number | undefined, fresh: QuoteInfo | undefined): boolean {
  return (
    approvedUsd !== undefined &&
    fresh?.estimated_usd !== undefined &&
    formatUsd(approvedUsd) !== formatUsd(fresh.estimated_usd)
  );
}

export function createQuoteActions(deps: QuoteDeps): QuoteActions {
  const sample = () => deps.card()?.sample === true;
  /** 最近一次带确认令牌提交的时间，核实时告诉服务端从哪儿往后找。 */
  let submittedAt: string | undefined;
  let checking = false;
  /** 令牌对不上后重新报来的那份报价：再对不上就不再自动重报，交给用户。 */
  let repricedQuote: QuoteInfo | undefined;

  /** 服务端核实接口说开始了：接着显示进度。 */
  function startedFrom(result: unknown, quote: QuoteInfo): boolean {
    const before = deps.card();
    const carry = quote.estimated_usd !== undefined ? { price_usd: quote.estimated_usd } : {};
    if (!deps.accept(result, carry)) return false;
    const after = deps.card();
    if (!after || after.state === "quote") return false;
    deps.setState({ phase: "ready" });
    tellModel(deps.app, before, after);
    deps.startPolling();
    return true;
  }

  async function verify(): Promise<void> {
    const quote = deps.card()?.quote;
    if (!quote || checking) return;
    checking = true;
    deps.setState({ phase: "verifying" });
    const started = Date.now();
    try {
      while (Date.now() - started < CHECK_BUDGET_MS && deps.card()?.quote === quote) {
        try {
          const result = await deps.app.callServerTool({
            name: CHECK_TOOL,
            arguments: {
              tool: quote.tool,
              idempotency_key: quote.idempotency_key,
              arguments: quote.arguments,
              ...(modelOf(deps.card(), quote) ? { model: modelOf(deps.card(), quote) } : {}),
              ...(submittedAt ? { submitted_at: submittedAt } : {}),
            },
          });
          const outcome = (result.structuredContent as { outcome?: string; message?: string } | undefined) ?? {};
          if (!result.isError && outcome.outcome === "started" && startedFrom(result, quote)) return;
          if (!result.isError && outcome.outcome === "not_started") {
            deps.setState({
              phase: "error",
              message: `${outcome.message ?? "This generation didn't start."} Nothing was charged.`,
            });
            return;
          }
        } catch {
          // 核实本身失败（网络抖动）：下一轮再问。
        }
        await sleep(CHECK_GAP_MS);
      }
      if (deps.card()?.quote === quote) deps.setState({ phase: "uncertain" });
    } finally {
      checking = false;
    }
  }

  function fail(quote: QuoteInfo, confirmed: boolean, state: QuoteState): void {
    // 确认令牌对不上：这一单没提交。按同一个幂等键重新报价（不扣费），价格变了就请用户按新价再确认。
    if (confirmed && state.phase === "settings_changed" && quote !== repricedQuote) {
      void call({ approvedUsd: quote.estimated_usd, repricing: true });
      return;
    }
    if (state.phase === "verifying") void verify();
    else deps.setState(state);
  }

  /**
   * 调一次生成工具。confirm：带确认令牌提交；freshKey：换新的幂等键再报价；
   * repricing：令牌对不上之后的重新报价，approvedUsd 是用户先前同意的价格。
   */
  async function call(
    opts: { confirm?: boolean; freshKey?: boolean; repricing?: boolean; approvedUsd?: number } = {}
  ): Promise<void> {
    const quote = deps.card()?.quote;
    if (!quote) return;
    if (sample()) {
      deps.notice("This is a sample card, so nothing was submitted.");
      return;
    }
    const withConfirmation = opts.confirm === true;
    deps.setState({ phase: withConfirmation ? "submitting" : "quoting" });
    if (withConfirmation) submittedAt = new Date().toISOString();
    try {
      const result = await deps.app.callServerTool({
        name: quote.tool,
        arguments: {
          ...quote.arguments,
          idempotency_key: opts.freshKey ? newIdempotencyKey() : quote.idempotency_key,
          ...(withConfirmation ? { confirmation_token: quote.confirmation_token, confirmed: true } : {}),
        },
      });
      if (result.isError) {
        fail(quote, withConfirmation, failureState(errorText(result)));
        return;
      }
      const before = deps.card();
      const carry = withConfirmation && quote.estimated_usd !== undefined ? { price_usd: quote.estimated_usd } : {};
      if (!deps.accept(result, carry)) {
        deps.setState({ phase: "error", message: "Atlas Cloud sent back something this card can't show." });
        return;
      }
      const after = deps.card();
      if (after?.state === "quote") {
        // 又拿到一份报价（重新报价，或服务端要求重新确认）：回到待确认；令牌对不上之后重报的，
        // 价格变了就显示新旧价格。
        if (opts.repricing) {
          repricedQuote = after.quote;
          if (priceChanged(opts.approvedUsd, after.quote)) {
            deps.setState({ phase: "price_changed", previousUsd: opts.approvedUsd });
            return;
          }
          deps.setState({ phase: "ready" });
          deps.notice("The quote was refreshed. Nothing was charged. Approve it again to generate.");
          return;
        }
        deps.setState({ phase: "ready" });
        return;
      }
      deps.setState({ phase: "ready" });
      if (after && withConfirmation) tellModel(deps.app, before, after);
      deps.startPolling();
    } catch (error) {
      // 不能说「什么都没提交」：请求可能已经到了服务端（ChatGPT 把工具报错也当成调用失败）。
      fail(quote, withConfirmation, thrownFailureState(error));
    }
  }

  return {
    confirm: () => void call({ confirm: true }),
    requote: () => void call(),
    requoteFresh: () => void call({ freshKey: true }),
    editSettings() {
      if (sample()) {
        deps.notice("This is a sample card, so nothing was sent.");
        return;
      }
      deps.app
        .sendMessage({ role: "user", content: [{ type: "text", text: "Before generating, I'd like to change the settings." }] })
        .catch(() => deps.notice("Couldn't send that. Type it in the chat instead."));
    },
    switchModel() {
      if (sample()) {
        deps.notice("This is a sample card, so nothing was sent.");
        return;
      }
      deps.app
        .sendMessage({
          role: "user",
          content: [{ type: "text", text: `${modelLabel(deps.card() ?? {})} is unavailable right now. Please suggest a different model for the same request.` }],
        })
        .catch(() => deps.notice("Couldn't send that. Type it in the chat instead."));
    },
    cancel() {
      const before = deps.card();
      deps.setState({ phase: "canceled" });
      if (!sample()) tellModelCanceled(deps.app, before);
    },
    checkAgain: () => void verify(),
    topUp: () => deps.openUrl(BILLING_URL),
    openInAtlas: () => deps.openUrl(deps.card()?.open_url || "https://www.atlascloud.ai"),
  };
}

/**
 * 卡片里确认的这一单，模型并不知道（工具结果只回到卡片）。告诉它一声，
 * 免得它再报一次价、或者把用户后面那句「好了吗」当成没提交。
 */
function tellModel(app: App, quoteCard: CardData | undefined, submitted: CardData): void {
  if (app.getHostCapabilities()?.updateModelContext === undefined) return;
  const price = priceLabel(quoteCard?.quote);
  const text =
    `The user approved the Atlas Cloud quote in the card` +
    (price ? ` (${modelLabel(submitted)}, about ${price})` : ` (${modelLabel(submitted)})`) +
    `. The card submitted it as prediction ${submitted.prediction_id} and is tracking it, so do not ` +
    `submit it again. Call atlas_get_prediction with this ID if the user asks about the result.`;
  void app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => undefined);
}

/** 用户在卡里取消了：模型不知道，告诉它别再替用户提交这一单。 */
function tellModelCanceled(app: App, quoteCard: CardData | undefined): void {
  if (!quoteCard || app.getHostCapabilities()?.updateModelContext === undefined) return;
  const price = priceLabel(quoteCard.quote);
  const text =
    `The user canceled the Atlas Cloud quote in the card` +
    (price ? ` (${modelLabel(quoteCard)}, about ${price})` : ` (${modelLabel(quoteCard)})`) +
    `. Nothing was submitted or charged. Do not submit this generation unless the user asks for it again.`;
  void app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => undefined);
}

/** 核实时按哪个模型找：卡片上的模型 ID，没有就用报价参数里的。 */
function modelOf(card: CardData | undefined, quote: QuoteInfo): string | undefined {
  if (card?.model_id) return card.model_id;
  return typeof quote.arguments.model === "string" ? quote.arguments.model : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chips(settings: string[]): HTMLElement | null {
  if (settings.length === 0) return null;
  return h("div", { class: "chips" }, ...settings.map((label) => h("span", { class: "chip" }, label)));
}

/** 「报价 10 分钟内有效」里的时长。 */
function validFor(seconds: number | undefined): string | null {
  if (!seconds || seconds < 60) return null;
  if (seconds % 3600 === 0) return seconds === 3600 ? "1 hour" : `${seconds / 3600} hours`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** 有效期倒计时（每秒由 tickTimers 走字）；拿不到失效时间就不显示。 */
function countdown(quote: QuoteInfo | undefined, now = Date.now()): HTMLElement | null {
  const at = quote?.expires_at ? Date.parse(quote.expires_at) : NaN;
  if (!Number.isFinite(at) || at <= now) return null;
  return h("span", { "data-countdown-to": quote!.expires_at }, formatClock((at - now) / 1000));
}

function signedUsd(value: number): string {
  return value < 0 ? `-${formatUsd(-value)}` : formatUsd(value);
}

export function renderQuoteCard(
  card: CardData,
  state: QuoteState,
  opts: ViewOptions,
  actions: QuoteActions
): HTMLElement {
  const quote = card.quote;
  const price = priceLabel(quote);
  const subtitle = h("p", { class: "desc", style: "margin-top:2px" }, `${modelLabel(card)} · ${typeLabel(card)}`);

  if (state.phase === "expired") {
    const duration = validFor(quote?.valid_seconds);
    return h(
      "section",
      { class: "card" },
      head("Quote expired", badge("Expired")),
      h(
        "p",
        { class: "desc" },
        duration ? `This quote expired after ${duration}. Nothing was charged.` : "This quote expired. Nothing was charged."
      ),
      quote ? h("div", { class: "actions" }, button("Get a new quote", "primary", actions.requote)) : null,
      notice(opts)
    );
  }

  if (state.phase === "low_balance") {
    const rows = [
      price ? row("Estimated cost", price) : null,
      state.balanceUsd !== undefined ? row("Balance", signedUsd(state.balanceUsd)) : null,
    ].filter((el): el is HTMLElement => el !== null);
    return h(
      "section",
      { class: "card" },
      head("Not enough balance", badge("Low balance", { danger: true })),
      subtitle,
      rows.length > 0 ? h("div", { class: "rows" }, ...rows) : null,
      h("p", { class: "desc" }, "Top up your Atlas Cloud balance or choose cheaper settings. Nothing was charged."),
      h(
        "div",
        { class: "actions" },
        button("Top up", "primary", actions.topUp),
        opts.canMessage ? button("Edit settings", "secondary", actions.editSettings) : null,
        // 充值回来接着生成：只报价、不扣费，用户还要再确认一次。
        quote ? button("Get a new quote", "secondary", actions.requoteFresh) : null
      ),
      notice(opts)
    );
  }

  if (state.phase === "price_changed") {
    const was = state.previousUsd !== undefined ? formatUsd(state.previousUsd) : null;
    return h(
      "section",
      { class: "card" },
      head("Price changed", badge("Price changed", { warn: true })),
      subtitle,
      chips(quote?.settings ?? []),
      h(
        "p",
        { class: "quote-price" },
        was ? h("s", { class: "was" }, was) : null,
        was ? h("span", { class: "arrow", "aria-hidden": "true" }, "→") : null,
        price ?? "Cost unavailable"
      ),
      h("p", { class: "desc" }, "The price changed after you approved. Nothing was charged yet."),
      h(
        "div",
        { class: "actions" },
        button(price ? `Generate · ${price}` : "Generate anyway", "primary", actions.confirm),
        button("Cancel", "secondary", actions.cancel)
      ),
      notice(opts)
    );
  }

  if (state.phase === "settings_changed") {
    return h(
      "section",
      { class: "card" },
      head("Settings changed", badge("Re-quote needed", { warn: true })),
      subtitle,
      h("p", { class: "desc" }, "Settings changed after this quote. Get a new quote to continue. Nothing was charged."),
      quote ? h("div", { class: "actions" }, button("Get a new quote", "primary", actions.requoteFresh)) : null,
      notice(opts)
    );
  }

  if (state.phase === "rate_limited") {
    return h(
      "section",
      { class: "card" },
      head("Too many requests", badge("Rate limited", { warn: true })),
      subtitle,
      h("p", { class: "desc" }, "Atlas Cloud is limiting requests right now. Nothing was charged. Try again in a moment."),
      // 被拒的那一单用过的幂等键不能再用：Retry 换新键重新报价，用户再确认一次。
      quote ? h("div", { class: "actions" }, retryButton(state.retryAt ?? Date.now(), actions.requoteFresh)) : null,
      notice(opts)
    );
  }

  if (state.phase === "model_unavailable") {
    return h(
      "section",
      { class: "card" },
      head("Model unavailable", badge("Unavailable", { danger: true })),
      h(
        "p",
        { class: "desc", title: state.message },
        `${modelLabel(card)} is temporarily unavailable. Nothing was charged.`
      ),
      h(
        "div",
        { class: "actions" },
        quote ? button("Retry", "primary", actions.requoteFresh) : null,
        opts.canMessage ? button("Switch model", "secondary", actions.switchModel) : null
      ),
      notice(opts)
    );
  }

  if (state.phase === "verifying") {
    return h(
      "section",
      { class: "card" },
      head("Checking whether it started", badge("Checking", { spinner: true })),
      subtitle,
      h(
        "p",
        { class: "desc" },
        "Atlas Cloud didn't confirm this submission, so we're checking whether it went through. Don't submit it again, or you may be charged twice."
      ),
      notice(opts)
    );
  }

  if (state.phase === "uncertain") {
    return h(
      "section",
      { class: "card" },
      head("Not sure it started", badge("Check first")),
      subtitle,
      h(
        "p",
        { class: "desc" },
        "We couldn't confirm whether this job is running. Check again, or look at your generations in Atlas: a new quote starts a separate job."
      ),
      h(
        "div",
        { class: "actions" },
        quote ? button("Check again", "primary", actions.checkAgain) : null,
        button("Open in Atlas", quote ? "secondary" : "primary", actions.openInAtlas),
        quote ? button("Get a new quote", "secondary", actions.requoteFresh) : null
      ),
      notice(opts)
    );
  }

  if (state.phase === "canceled") {
    return h(
      "section",
      { class: "card" },
      head("Generation canceled", badge("Canceled")),
      h("p", { class: "desc" }, `${modelLabel(card)} · Nothing was submitted or charged.`)
    );
  }

  if (state.phase === "error") {
    return h(
      "section",
      { class: "card" },
      head("Couldn't start the generation", badge("Failed", { danger: true })),
      subtitle,
      h("p", { class: "desc" }, state.message ?? "Atlas Cloud didn't accept this request."),
      quote ? h("div", { class: "actions" }, button("Get a new quote", "primary", actions.requoteFresh)) : null,
      notice(opts)
    );
  }

  const submitting = state.phase === "submitting";
  const busy = submitting || state.phase === "quoting";
  const status = busy
    ? badge(submitting ? "Submitting" : "Getting quote", { spinner: true })
    : price === null
      ? badge("No estimate", { warn: true })
      : quote?.partial
        ? badge("Estimate only", { warn: true })
        : badge("Needs approval");

  // 设计稿：价格下面一行「Estimated · valid for 9:42」；提交中只写 Estimated。
  const timer = busy ? null : countdown(quote);
  const validity = timer ? [" · valid for ", timer] : [];
  const amount =
    price === null
      ? [
          h("p", { class: "quote-price unavailable" }, "Cost unavailable"),
          h("p", { class: "desc" }, "You'll be charged the model's standard rate.", ...validity),
        ]
      : [
          h("p", { class: "quote-price" }, quote?.partial ? `≈ ${price}` : price),
          h(
            "p",
            { class: "note quote-note" },
            quote?.partial ? "Some settings can't be priced exactly. The final cost may differ" : "Estimated",
            ...validity
          ),
        ];

  // 没有工具名（宿主没把卡片数据转过来）就没法在卡里确认，请用户在对话里回复。
  const canConfirm = quote !== undefined && quote.tool !== "";
  const generateLabel = busy
    ? submitting
      ? "Submitting…"
      : "Getting quote…"
    : price === null
      ? "Generate anyway"
      : `Generate · ${quote?.partial ? "≈ " : ""}${price}`;
  return h(
    "section",
    { class: "card" },
    head("Approve this generation", status),
    subtitle,
    chips(quote?.settings ?? []),
    ...amount,
    canConfirm
      ? h(
          "div",
          { class: "actions" },
          button(generateLabel, "primary", actions.confirm, { disabled: busy }),
          !busy && opts.canMessage ? button("Edit settings", "secondary", actions.editSettings) : null,
          !busy ? button("Cancel", "secondary", actions.cancel) : null
        )
      : h("p", { class: "note" }, "Reply in the chat to approve or change this."),
    notice(opts)
  );
}

function notice(opts: ViewOptions): HTMLElement | null {
  return opts.notice ? h("p", { class: "note", role: "status" }, opts.notice) : null;
}
