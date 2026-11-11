import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publicApi } from "../services/api-client.js";
import { handleError } from "../utils/error-handler.js";
import { recordToolCallError } from "../services/tool-call-telemetry.js";
import { truncate } from "../utils/formatter.js";
import type { BalanceResponse, UsageListResponse } from "../types.js";
import { toolAnnotations } from "../tool-policy.js";
import {
  balanceResponseSchema,
  usageListResponseSchema,
} from "../response-schemas.js";

const moneyValueSchema = z.object({
  value: z.string(),
  currency: z.string(),
});

const usageOutputSchema = {
  scope: z.string(),
  buckets: z.array(
    z.object({
      date: z.string(),
      partial: z.boolean().optional(),
      results: z.array(z.record(z.unknown())),
    })
  ),
  has_more: z.boolean(),
  next_page: z.string().optional(),
  range: z.object({ start_date: z.string(), end_date: z.string() }).optional(),
  spend: z
    .array(z.object({ date: z.string(), amount: moneyValueSchema }))
    .optional(),
  notes: z.array(z.string()).optional(),
};

function validUtcDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateDateRange(startDate: string, endDate: string): string | undefined {
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  if (end <= start) return "end_date must be after start_date";
  if ((end - start) / 86_400_000 > 180) {
    return "The UTC date range cannot exceed 180 days";
  }
  return undefined;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 7;

/**
 * 补全日期范围。end_date 是「不含」的：模型照着「到今天为止」把今天填进 end_date，今天就被
 * 排除了，用户问「我今天用了多少」看到的是一张没有今天的表（11-11 Claude 实测 G8）。所以两个
 * 日期都可以不填：不填 end_date 就到明天，包含今天；不填 start_date 就从 end_date 往前 7 天。
 */
export function resolveUsageRange(
  startDate: string | undefined,
  endDate: string | undefined,
  nowMs: number = Date.now()
): { start_date: string; end_date: string } {
  const end = endDate ?? utcDay(nowMs + DAY_MS);
  const start =
    startDate ?? utcDay(new Date(`${end}T00:00:00.000Z`).getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  return { start_date: start, end_date: end };
}

/** 这次查询结果要提醒模型的事：今天没算进去、今天的数还在累计。 */
export function usageRangeNotes(
  range: { start_date: string; end_date: string },
  buckets: { partial?: boolean }[],
  nowMs: number = Date.now()
): string[] {
  const notes: string[] = [];
  const today = utcDay(nowMs);
  if (range.end_date <= today && range.start_date <= today) {
    notes.push(
      `Today (${today} UTC) is not in this range because end_date is exclusive. ` +
        `To include today, leave end_date out or set it to ${utcDay(nowMs + DAY_MS)}.`
    );
  }
  if (buckets.some((bucket) => bucket.partial)) {
    notes.push(
      "Buckets marked partial (today) are still filling in: a generation from the last few minutes may not be counted yet."
    );
  }
  return notes;
}

/** 金额桶按天合计（分组时把同一天各组加起来）。读不出金额的结果跳过。 */
export function spendByDay(
  buckets: { date: string; results?: Record<string, unknown>[] | null }[]
): { date: string; amount: { value: string; currency: string } }[] {
  const out: { date: string; amount: { value: string; currency: string } }[] = [];
  for (const bucket of buckets) {
    let total = 0;
    let currency = "usd";
    let seen = false;
    for (const result of bucket.results ?? []) {
      const amount = (result as { amount?: { value?: unknown; currency?: unknown } }).amount;
      const value = Number(amount?.value);
      if (!Number.isFinite(value)) continue;
      total += value;
      if (typeof amount?.currency === "string") currency = amount.currency;
      seen = true;
    }
    if (seen) out.push({ date: bucket.date, amount: { value: total.toFixed(6), currency } });
  }
  return out;
}

// Build a query string, repeating array values with a `[]` suffix.
function buildQuery(
  params: Record<string, string | number | string[] | undefined>
): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) sp.append(`${key}[]`, String(item));
    } else {
      sp.append(key, String(value));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

// Render a MoneyValue like "125.500000 usd" -> "$125.50"
function money(m?: { value: string; currency: string }): string {
  if (!m) return "-";
  const n = Number(m.value);
  const amount = Number.isFinite(n) ? n.toFixed(2) : m.value;
  return m.currency?.toLowerCase() === "usd"
    ? `$${amount}`
    : `${amount} ${m.currency}`;
}

export function registerAccountTools(server: McpServer): void {
  // Account balance
  server.registerTool(
    "atlas_get_balance",
    {
      title: "Get Account Balance",
      description: `Get the current Atlas Cloud account balance and credit summary for the authenticated API key.

Returns available balance, cash, bonus, frozen amount, and credit grant status.

Args:
  None.

Examples:
  - (no params) -> current account balance`,
      inputSchema: {},
      outputSchema: {
        scope: z.string(),
        account_name: z.string().optional(),
        account_type: z.string().optional(),
        available: moneyValueSchema.optional(),
        cash: moneyValueSchema.optional(),
        bonus: moneyValueSchema.optional(),
        subscription_bonus: moneyValueSchema.optional(),
        frozen: moneyValueSchema.optional(),
        credit_grant: z
          .object({
            status: z.string().optional(),
            granted: moneyValueSchema.optional(),
            used: moneyValueSchema.optional(),
            remaining_overdraft: moneyValueSchema.optional(),
            overdrawn: moneyValueSchema.optional(),
          })
          .optional(),
      },
      annotations: toolAnnotations("atlas_get_balance"),
    },
    async () => {
      try {
        const res = await publicApi<BalanceResponse>("/balance", {
          responseSchema: balanceResponseSchema,
        });

        const lines: string[] = ["# Account Balance\n"];
        if (res.account) {
          lines.push(
            `- **Account**: ${res.account.name || "authenticated account"} (${res.account.type})`
          );
        }
        lines.push(`- **Available**: ${money(res.available)}`);
        lines.push(`- **Cash**: ${money(res.cash)}`);
        lines.push(`- **Bonus**: ${money(res.bonus)}`);
        if (res.subscription_bonus) {
          lines.push(`- **Subscription Bonus**: ${money(res.subscription_bonus)}`);
        }
        if (res.frozen) lines.push(`- **Frozen**: ${money(res.frozen)}`);
        if (res.credit_grant && res.credit_grant.status) {
          lines.push(
            `- **Credit Grant**: ${res.credit_grant.status} (granted ${money(
              res.credit_grant.granted
            )}, used ${money(res.credit_grant.used)})`
          );
        }

        return {
          structuredContent: {
            scope: res.scope,
            ...(res.account?.name ? { account_name: res.account.name } : {}),
            ...(res.account?.type ? { account_type: res.account.type } : {}),
            ...(res.available ? { available: res.available } : {}),
            ...(res.cash ? { cash: res.cash } : {}),
            ...(res.bonus ? { bonus: res.bonus } : {}),
            ...(res.subscription_bonus
              ? { subscription_bonus: res.subscription_bonus }
              : {}),
            ...(res.frozen ? { frozen: res.frozen } : {}),
            ...(res.credit_grant ? { credit_grant: res.credit_grant } : {}),
          },
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );

  // Shared input schema for usage / costs
  const usageInput = {
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(validUtcDate, "start_date must be a real UTC calendar date")
      .optional()
      .describe("Inclusive UTC start date, format YYYY-MM-DD. Omit for 7 days before end_date."),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(validUtcDate, "end_date must be a real UTC calendar date")
      .optional()
      .describe(
        "Exclusive UTC end date, format YYYY-MM-DD: the day itself is NOT included, so end_date = today leaves today out. Omit to include today. The range can cover at most 180 daily buckets."
      ),
    scope: z
      .enum(["self", "account"])
      .optional()
      .describe(
        'Visibility scope. "self" (default) reads the authenticated user\'s usage; "account" requires account-level billing read permission.'
      ),
    group_by: z
      .array(z.enum(["model_type", "model"]))
      .max(2)
      .optional()
      .describe(
        "Grouping dimensions. Omit for total daily buckets. Supported: model_type and model. API-key identifiers are intentionally not exposed by this plugin."
      ),
    model_types: z
      .array(z.enum(["text", "image", "video", "audio"]))
      .max(3)
      .optional()
      .describe(
        "Model type filter (e.g. text, image, video, audio). Omit to include all."
      ),
    model_ids: z
      .array(z.string().min(1).max(256))
      .max(100)
      .optional()
      .describe("Model ID filter, at most 100 IDs."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(100)
      .describe("Maximum number of grouped rows to return (1-100; default 100)."),
    page: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe("Opaque cursor from a previous response's next_page."),
  };

  // Render usage/cost buckets into a compact table-ish summary
  function renderBuckets(
    res: UsageListResponse,
    title: string,
    extra: {
      range: { start_date: string; end_date: string };
      spend?: { date: string; amount: { value: string; currency: string } }[];
      notes: string[];
    }
  ): string {
    const lines: string[] = [`# ${title}\n`];
    lines.push(
      `- **Range (UTC)**: ${extra.range.start_date} to ${extra.range.end_date} (end date not included)`
    );
    lines.push(`- **Scope**: ${res.scope}`);
    lines.push(`- **Buckets**: ${res.data?.length ?? 0}`);
    if (res.has_more) lines.push(`- **Has more**: yes (next_page: ${res.next_page})`);
    lines.push("");
    for (const note of extra.notes) lines.push(`> ${note}`);
    if (extra.notes.length) lines.push("");
    const spendOn = new Map((extra.spend ?? []).map((s) => [s.date, s.amount]));
    for (const bucket of res.data || []) {
      lines.push(`## ${bucket.date}${bucket.partial ? " (partial)" : ""}`);
      const spent = spendOn.get(bucket.date);
      if (spent) lines.push(`- **Spend**: ${money(spent)}`);
      lines.push("```json");
      lines.push(JSON.stringify(bucket.results ?? [], null, 2));
      lines.push("```");
      lines.push("");
    }
    return truncate(lines.join("\n"));
  }

  // Model usage (requests / tokens / images / video counts)
  server.registerTool(
    "atlas_get_model_usage",
    {
      title: "Get Model Usage",
      description: `Get daily model usage for the user over a UTC date range: requests, tokens, image/video counts, and the money spent each day. Usage from every app (website, API, MCP) is counted.

Leave the dates out to get the last 7 days including today. end_date is exclusive: passing today's date as end_date leaves today out. Today's bucket is marked partial and can lag a few minutes behind the newest generation.

Omitting group_by returns total daily buckets. Use group_by to break usage down by model_type and/or model. API-key identifiers are not exposed by this plugin.

Args:
  - start_date (string, optional): Inclusive UTC start date, YYYY-MM-DD. Default: 7 days before end_date.
  - end_date (string, optional): Exclusive UTC end date, YYYY-MM-DD (range <= 180 days). Default: tomorrow, so today is included.
  - scope (string, optional): "self" (default) or "account".
  - group_by (array, optional): Any of "model_type", "model".
  - model_types (array, optional): Filter by model type, e.g. ["text","image"].
  - model_ids (array, optional): Filter by model ID (<= 100).
  - limit (number, optional): Max grouped rows (1-100, default 100).
  - page (string, optional): Pagination cursor from a previous next_page.

Examples:
  - (no params) -> last 7 days including today, with spend
  - start_date="2026-06-01", end_date="2026-07-01", group_by=["model"]`,
      inputSchema: usageInput,
      outputSchema: usageOutputSchema,
      annotations: toolAnnotations("atlas_get_model_usage"),
    },
    async (args) => {
      try {
        const range = resolveUsageRange(args.start_date, args.end_date);
        const rangeError = validateDateRange(range.start_date, range.end_date);
        if (rangeError) {
          recordToolCallError({ code: "invalid_param" });
          return {
            isError: true,
            content: [{ type: "text", text: rangeError }],
          };
        }
        const params = {
          start_date: range.start_date,
          end_date: range.end_date,
          scope: args.scope,
          group_by: args.group_by,
          model_types: args.model_types,
          model_ids: args.model_ids,
          limit: args.limit,
        };
        const res = await publicApi<UsageListResponse>(
          `/model-usage${buildQuery({ ...params, page: args.page })}`,
          { responseSchema: usageListResponseSchema }
        );
        const notes = usageRangeNotes(range, res.data || []);
        // 用户问「用量」多半也想知道花了多少：同样的条件再查一次金额，按天合计后跟在用量后面。
        // 翻页游标是各接口自己的，翻页时不查；金额查不到也不影响用量结果。
        let spend: ReturnType<typeof spendByDay> | undefined;
        if (args.page) {
          notes.push("Spend is only added on the first page; call atlas_get_model_costs for these dates.");
        } else {
          try {
            const costs = await publicApi<UsageListResponse>(`/model-costs${buildQuery(params)}`, {
              responseSchema: usageListResponseSchema,
            });
            spend = spendByDay(costs.data || []);
            if (costs.has_more) {
              notes.push("Spend covers the first page of groups only; call atlas_get_model_costs for the rest.");
            }
          } catch {
            notes.push("Spend couldn't be read just now; call atlas_get_model_costs for these dates.");
          }
        }
        return {
          structuredContent: {
            scope: res.scope,
            buckets: (res.data || []).map((bucket) => ({
              date: bucket.date,
              ...(bucket.partial !== undefined ? { partial: bucket.partial } : {}),
              results: bucket.results ?? [],
            })),
            has_more: Boolean(res.has_more),
            ...(res.next_page ? { next_page: res.next_page } : {}),
            range,
            ...(spend ? { spend } : {}),
            ...(notes.length ? { notes } : {}),
          },
          content: [{ type: "text", text: renderBuckets(res, "Model Usage", { range, spend, notes }) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );

  // Model costs (spend in currency)
  server.registerTool(
    "atlas_get_model_costs",
    {
      title: "Get Model Costs",
      description: `Get daily model cost buckets (money already spent) for the user over a UTC date range. This is not a price for a new job: a generation tool called without confirmed: true returns that price for free. atlas_get_model_usage already includes the daily spend next to the counts.

Leave the dates out to get the last 7 days including today. end_date is exclusive: passing today's date as end_date leaves today out. Today's bucket is marked partial and can lag a few minutes behind the newest generation.

Omitting group_by returns total daily buckets. Use group_by to break costs down by model_type and/or model. API-key identifiers are not exposed by this plugin.

Args:
  - start_date (string, optional): Inclusive UTC start date, YYYY-MM-DD. Default: 7 days before end_date.
  - end_date (string, optional): Exclusive UTC end date, YYYY-MM-DD (range <= 180 days). Default: tomorrow, so today is included.
  - scope (string, optional): "self" (default) or "account".
  - group_by (array, optional): Any of "model_type", "model".
  - model_types (array, optional): Filter by model type, e.g. ["text","image"].
  - model_ids (array, optional): Filter by model ID (<= 100).
  - limit (number, optional): Max grouped rows (1-100, default 100).
  - page (string, optional): Pagination cursor from a previous next_page.

Examples:
  - (no params) -> last 7 days including today
  - start_date="2026-06-01", end_date="2026-07-01", group_by=["model"]`,
      inputSchema: usageInput,
      outputSchema: usageOutputSchema,
      annotations: toolAnnotations("atlas_get_model_costs"),
    },
    async (args) => {
      try {
        const range = resolveUsageRange(args.start_date, args.end_date);
        const rangeError = validateDateRange(range.start_date, range.end_date);
        if (rangeError) {
          recordToolCallError({ code: "invalid_param" });
          return {
            isError: true,
            content: [{ type: "text", text: rangeError }],
          };
        }
        const query = buildQuery({
          start_date: range.start_date,
          end_date: range.end_date,
          scope: args.scope,
          group_by: args.group_by,
          model_types: args.model_types,
          model_ids: args.model_ids,
          limit: args.limit,
          page: args.page,
        });
        const res = await publicApi<UsageListResponse>(`/model-costs${query}`, {
          responseSchema: usageListResponseSchema,
        });
        const notes = usageRangeNotes(range, res.data || []);
        return {
          structuredContent: {
            scope: res.scope,
            buckets: (res.data || []).map((bucket) => ({
              date: bucket.date,
              ...(bucket.partial !== undefined ? { partial: bucket.partial } : {}),
              results: bucket.results ?? [],
            })),
            has_more: Boolean(res.has_more),
            ...(res.next_page ? { next_page: res.next_page } : {}),
            range,
            ...(notes.length ? { notes } : {}),
          },
          content: [{ type: "text", text: renderBuckets(res, "Model Costs", { range, notes }) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );
}
