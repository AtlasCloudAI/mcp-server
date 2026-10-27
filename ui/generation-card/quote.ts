// 报价确认卡：设计稿「报价确认 · Quote Confirm」。
// 用户在卡里点 Generate，卡片带着确认令牌再调一次同一个生成工具（和模型在对话里确认走同一条路，
// 服务端照常核对报价）。提交成功后卡片变成进度卡，接着自己刷新到出结果。
// 不替用户往对话里发「确认」——那句话在 ChatGPT 里会被它自带的生图接走。

import type { App } from "@modelcontextprotocol/ext-apps";
import { type CardData, type QuoteInfo, cardFromToolResult, formatUsd, modelLabel, typeLabel } from "./card.js";
import { type ViewOptions, badge, button, h, head, row } from "./view.js";

const BILLING_URL = "https://www.atlascloud.ai/console/billing";

export type QuotePhase = "ready" | "submitting" | "expired" | "low_balance" | "error";

export interface QuoteState {
  phase: QuotePhase;
  /** phase = "error" 时显示的原因。 */
  message?: string;
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
  confirm(): void;
  requote(): void;
  editSettings(): void;
  topUp(): void;
}

function priceLabel(quote: QuoteInfo | undefined): string | null {
  return quote?.estimated_usd !== undefined ? formatUsd(quote.estimated_usd) : null;
}

function errorText(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks.find((block) => block.type === "text")?.text?.replace(/^Error:\s*/, "").slice(0, 240) ?? "";
}

/** 报价已过期：先看卡片自己的计时，没有计时就等服务端说。 */
export function quoteExpired(quote: QuoteInfo | undefined, now = Date.now()): boolean {
  if (!quote?.expires_at) return false;
  const at = Date.parse(quote.expires_at);
  return Number.isFinite(at) && at <= now;
}

export function initialQuoteState(card: CardData): QuoteState {
  if (card.quote?.problem === "insufficient_balance") return { phase: "low_balance" };
  return { phase: quoteExpired(card.quote) ? "expired" : "ready" };
}

export function createQuoteActions(deps: QuoteDeps): QuoteActions {
  const sample = () => deps.card()?.sample === true;

  async function call(withConfirmation: boolean): Promise<void> {
    const quote = deps.card()?.quote;
    if (!quote) return;
    if (sample()) {
      deps.notice("This is a sample card, so nothing was submitted.");
      return;
    }
    deps.setState({ phase: "submitting" });
    try {
      const result = await deps.app.callServerTool({
        name: quote.tool,
        arguments: {
          ...quote.arguments,
          idempotency_key: quote.idempotency_key,
          ...(withConfirmation ? { confirmation_token: quote.confirmation_token, confirmed: true } : {}),
        },
      });
      if (result.isError) {
        const text = errorText(result);
        if (/expired/i.test(text)) deps.setState({ phase: "expired" });
        else if (/insufficient balance|top up/i.test(text)) deps.setState({ phase: "low_balance" });
        else deps.setState({ phase: "error", message: text || "Atlas Cloud didn't accept this request." });
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
        // 又拿到一份报价（重新报价，或服务端要求重新确认）：回到待确认。
        deps.setState({ phase: "ready" });
        return;
      }
      deps.setState({ phase: "ready" });
      if (after && withConfirmation) tellModel(deps.app, before, after);
      deps.startPolling();
    } catch {
      deps.setState({ phase: "error", message: "Couldn't reach Atlas Cloud. Nothing was submitted." });
    }
  }

  return {
    confirm: () => void call(true),
    requote: () => void call(false),
    editSettings() {
      if (sample()) {
        deps.notice("This is a sample card, so nothing was sent.");
        return;
      }
      deps.app
        .sendMessage({ role: "user", content: [{ type: "text", text: "Before generating, I'd like to change the settings." }] })
        .catch(() => deps.notice("Couldn't send that. Type it in the chat instead."));
    },
    topUp: () => deps.openUrl(BILLING_URL),
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

function chips(settings: string[]): HTMLElement | null {
  if (settings.length === 0) return null;
  return h("div", { class: "chips" }, ...settings.map((label) => h("span", { class: "chip" }, label)));
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
    return h(
      "section",
      { class: "card" },
      head("Quote expired", badge("Expired")),
      h("p", { class: "desc" }, "Quotes are valid for a few minutes. Nothing was charged."),
      quote ? h("div", { class: "actions" }, button("Get new quote", "primary", actions.requote)) : null,
      notice(opts)
    );
  }

  if (state.phase === "low_balance") {
    return h(
      "section",
      { class: "card" },
      head("Not enough balance", badge("Low balance", { danger: true })),
      subtitle,
      price ? h("div", { class: "rows" }, row("Cost", price)) : null,
      h("p", { class: "desc" }, "Top up your Atlas Cloud balance or choose cheaper settings. Nothing was charged."),
      h(
        "div",
        { class: "actions" },
        button("Top up", "primary", actions.topUp),
        opts.canMessage ? button("Edit settings", "secondary", actions.editSettings) : null
      ),
      notice(opts)
    );
  }

  if (state.phase === "error") {
    return h(
      "section",
      { class: "card" },
      head("Couldn't start the generation", badge("Not submitted", { danger: true })),
      subtitle,
      h("p", { class: "desc" }, state.message ?? "Nothing was charged."),
      quote ? h("div", { class: "actions" }, button("Try again", "primary", actions.confirm)) : null,
      notice(opts)
    );
  }

  const submitting = state.phase === "submitting";
  const status = submitting
    ? badge("Submitting", { spinner: true })
    : price === null
      ? badge("No estimate")
      : quote?.partial
        ? badge("Partial estimate")
        : badge("Needs approval");

  const amount =
    price === null
      ? [
          h("p", { class: "quote-price unavailable" }, "Cost unavailable"),
          h("p", { class: "desc" }, "You'll be charged at the model's standard rate."),
        ]
      : [
          h("p", { class: "quote-price" }, quote?.partial ? `≈ ${price}` : price),
          quote?.partial ? h("p", { class: "note" }, "Part of the price couldn't be worked out, so the charge may be higher.") : null,
        ];

  // 没有工具名（宿主没把卡片数据转过来）就没法在卡里确认，请用户在对话里回复。
  const canConfirm = quote !== undefined && quote.tool !== "";
  const generateLabel = submitting ? "Submitting…" : price === null ? "Generate anyway" : `Generate · ${price}`;
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
          button(generateLabel, "primary", actions.confirm, { disabled: submitting }),
          !submitting && opts.canMessage ? button("Edit settings", "secondary", actions.editSettings) : null
        )
      : h("p", { class: "note" }, "Reply in the chat to approve or change this."),
    notice(opts)
  );
}

function notice(opts: ViewOptions): HTMLElement | null {
  return opts.notice ? h("p", { class: "note", role: "status" }, opts.notice) : null;
}
