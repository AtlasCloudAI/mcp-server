import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publicApi } from "../services/api-client.js";
import { handleError } from "../utils/error-handler.js";
import type { BalanceResponse, UsageListResponse } from "../types.js";

// Build a query string, repeating array values with a `[]` suffix
// (e.g. group_by[]=model&group_by[]=api_key). Scalars are appended as-is.
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const res = await publicApi<BalanceResponse>("/balance");

        const lines: string[] = ["# Account Balance\n"];
        if (res.account) {
          lines.push(
            `- **Account**: ${res.account.name || res.account.id} (${res.account.type})`
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

        return { content: [{ type: "text", text: lines.join("\n") }] };
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
      .describe("Inclusive UTC start date, format YYYY-MM-DD"),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe(
        "Exclusive UTC end date, format YYYY-MM-DD. The range can cover at most 180 daily buckets."
      ),
    scope: z
      .enum(["self", "account"])
      .optional()
      .describe(
        'Visibility scope. "self" (default) reads the authenticated user\'s usage; "account" requires account-level billing read permission.'
      ),
    group_by: z
      .array(z.enum(["model_type", "model", "api_key"]))
      .max(3)
      .optional()
      .describe(
        "Grouping dimensions. Omit for total daily buckets. Supported: model_type, model, api_key, or model + api_key."
      ),
    model_types: z
      .array(z.string())
      .max(3)
      .optional()
      .describe(
        "Model type filter (e.g. text, image, video, audio). Omit to include all."
      ),
    model_ids: z
      .array(z.string())
      .max(100)
      .optional()
      .describe("Model ID filter, at most 100 IDs."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Maximum number of grouped rows to return. Default 100."),
    page: z
      .string()
      .optional()
      .describe("Opaque cursor from a previous response's next_page."),
  };

  // Render usage/cost buckets into a compact table-ish summary
  function renderBuckets(res: UsageListResponse, title: string): string {
    const lines: string[] = [`# ${title}\n`];
    lines.push(`- **Scope**: ${res.scope}`);
    lines.push(`- **Buckets**: ${res.data?.length ?? 0}`);
    if (res.has_more) lines.push(`- **Has more**: yes (next_page: ${res.next_page})`);
    lines.push("");
    for (const bucket of res.data || []) {
      lines.push(`## ${bucket.date}${bucket.partial ? " (partial)" : ""}`);
      lines.push("```json");
      lines.push(JSON.stringify(bucket.results ?? [], null, 2));
      lines.push("```");
      lines.push("");
    }
    return lines.join("\n");
  }

  // Model usage (requests / tokens / images / video counts)
  server.registerTool(
    "atlas_get_model_usage",
    {
      title: "Get Model Usage",
      description: `Get daily model usage buckets (requests, tokens, image/video counts) for the authenticated API key over a UTC date range.

Omitting group_by returns total daily buckets. Use group_by to break usage down by model_type, model, and/or api_key.

Args:
  - start_date (string, required): Inclusive UTC start date, YYYY-MM-DD.
  - end_date (string, required): Exclusive UTC end date, YYYY-MM-DD (range <= 180 days).
  - scope (string, optional): "self" (default) or "account".
  - group_by (array, optional): Any of "model_type", "model", "api_key".
  - model_types (array, optional): Filter by model type, e.g. ["text","image"].
  - model_ids (array, optional): Filter by model ID (<= 100).
  - limit (number, optional): Max grouped rows (1-1000, default 100).
  - page (string, optional): Pagination cursor from a previous next_page.

Examples:
  - start_date="2026-06-01", end_date="2026-06-08"
  - start_date="2026-06-01", end_date="2026-07-01", group_by=["model"]`,
      inputSchema: usageInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const query = buildQuery({
          start_date: args.start_date,
          end_date: args.end_date,
          scope: args.scope,
          group_by: args.group_by,
          model_types: args.model_types,
          model_ids: args.model_ids,
          limit: args.limit,
          page: args.page,
        });
        const res = await publicApi<UsageListResponse>(`/model-usage${query}`);
        return {
          content: [{ type: "text", text: renderBuckets(res, "Model Usage") }],
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
      description: `Get daily model cost buckets (spend amount) for the authenticated API key over a UTC date range.

Omitting group_by returns total daily buckets. Use group_by to break costs down by model_type, model, and/or api_key.

Args:
  - start_date (string, required): Inclusive UTC start date, YYYY-MM-DD.
  - end_date (string, required): Exclusive UTC end date, YYYY-MM-DD (range <= 180 days).
  - scope (string, optional): "self" (default) or "account".
  - group_by (array, optional): Any of "model_type", "model", "api_key".
  - model_types (array, optional): Filter by model type, e.g. ["text","image"].
  - model_ids (array, optional): Filter by model ID (<= 100).
  - limit (number, optional): Max grouped rows (1-1000, default 100).
  - page (string, optional): Pagination cursor from a previous next_page.

Examples:
  - start_date="2026-06-01", end_date="2026-07-01"
  - start_date="2026-06-01", end_date="2026-07-01", group_by=["model"]`,
      inputSchema: usageInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const query = buildQuery({
          start_date: args.start_date,
          end_date: args.end_date,
          scope: args.scope,
          group_by: args.group_by,
          model_types: args.model_types,
          model_ids: args.model_ids,
          limit: args.limit,
          page: args.page,
        });
        const res = await publicApi<UsageListResponse>(`/model-costs${query}`);
        return {
          content: [{ type: "text", text: renderBuckets(res, "Model Costs") }],
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
