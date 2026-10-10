import type { Model } from "../types.js";
import type { Quote } from "../services/spend-policy.js";
import { CHARACTER_LIMIT } from "../constants.js";

// Format model list as Markdown
export function formatModelList(models: Model[], type?: string): string {
  const filtered = type ? models.filter((m) => m.type === type) : models;

  const lines: string[] = [];
  lines.push(`# Atlas Cloud Models`);
  if (type) lines.push(`\n> Filter: ${type}`);
  lines.push(`\nTotal: ${filtered.length} models\n`);

  // Group by type
  const grouped: Record<string, Model[]> = {};
  for (const model of filtered) {
    const t = model.type || "Other";
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push(model);
  }

  for (const [groupType, groupModels] of Object.entries(grouped)) {
    lines.push(`## ${groupType} (${groupModels.length})\n`);
    for (const m of groupModels) {
      lines.push(`- **${m.displayName}** (\`${m.model}\`)`);
      if (m.profile) lines.push(`  ${m.profile.slice(0, 100)}`);
      if (m.organization) lines.push(`  Provider: ${m.organization}`);
      if (m.contextLength) lines.push(`  Context: ${m.contextLength} tokens`);
      lines.push("");
    }
  }

  return truncate(lines.join("\n"));
}

// Format model detail as Markdown
// Up to four decimals, trailing zeros dropped: $0.0145, $0.1408, $3.136.
function usd(amount: number): string {
  return `$${Number(amount.toFixed(4))}`;
}

export function formatModelInfo(model: Model, defaultQuote?: Quote | null): string {
  const lines: string[] = [];
  lines.push(`# ${model.displayName}`);
  lines.push(`\n> ${model.profile || "No description available"}\n`);
  lines.push(`- **Model ID**: \`${model.model}\``);
  lines.push(`- **Type**: ${model.type}`);
  if (model.organization) lines.push(`- **Provider**: ${model.organization}`);
  if (model.contextLength) lines.push(`- **Context Length**: ${model.contextLength} tokens`);
  if (model.maxCompletionTokens) lines.push(`- **Max Output**: ${model.maxCompletionTokens} tokens`);
  if (model.totalParameters) lines.push(`- **Total Parameters**: ${model.totalParameters}`);
  if (model.architectureType) lines.push(`- **Architecture**: ${model.architectureType}`);
  if (model.knowledgeCutoff) lines.push(`- **Knowledge Cutoff**: ${model.knowledgeCutoff}`);
  if (model.avgLatency) lines.push(`- **Avg Latency**: ${model.avgLatency}s`);
  if (model.tags?.length) lines.push(`- **Tags**: ${model.tags.join(", ")}`);

  // Pricing info
  if (model.price?.actual || defaultQuote) {
    lines.push(`\n## Pricing\n`);
    if (defaultQuote && defaultQuote.usd !== null) {
      lines.push(
        `- **Estimated price at default parameters**: ${usd(defaultQuote.usd)}` +
          `${defaultQuote.partial ? " or more" : ""} (live quote). Resolution, duration, ` +
          `count and other parameters change it; every generate tool quotes the exact ` +
          `request before anything is billed.`
      );
    }
    const p = model.price?.actual ?? {};
    if (p.input_price) lines.push(`- Input: $${p.input_price}/M tokens`);
    if (p.output_price) lines.push(`- Output: $${p.output_price}/M tokens`);
    // base_price 是计费单位的起步价（按张、或最低档位的每秒），不是一单的总价。
    // 以前标成「/request」，agent 拿它当单价去对账，结果「实际扣费高好几倍」。
    if (p.base_price) {
      lines.push(
        `- Catalog unit price: $${p.base_price} — a starting rate per billing unit ` +
          `(per image, or per second of video at the lowest tier), not the total for a request`
      );
    }
    if (p.cache_price) lines.push(`- Cache: $${p.cache_price}/M tokens`);
    if (model.price?.discount && model.price.discount !== "100") {
      lines.push(`- Discount: ${model.price.discount}%`);
    }
  }

  if (model.coreStrengths?.length) {
    lines.push(`\n## Core Strengths\n`);
    model.coreStrengths.forEach((s) => lines.push(`- ${s}`));
  }

  if (model.useCases?.length) {
    lines.push(`\n## Use Cases\n`);
    model.useCases.forEach((s) => lines.push(`- ${s}`));
  }

  lines.push(`\n## Links\n`);
  lines.push(`- [Playground](https://www.atlascloud.ai/models/${model.model})`);

  return lines.join("\n");
}

// Truncate overly long responses
export function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    "\n\n---\n*Response truncated. Use more specific queries to narrow results.*"
  );
}
