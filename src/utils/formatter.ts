import type { Model } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";
import {
  formatPriceUnit,
  getModelKindLabel,
  getPriceUnitKind,
} from "./model-kind.js";

export interface ModelListOptions {
  // Filter by model.type ("Text" | "Image" | "Video" | "Audio")
  type?: string;
  // Free-text label describing the filter, shown in the header
  filterLabel?: string;
  // Maximum rows to render
  limit?: number;
}

/**
 * Format a model list as Markdown.
 *
 * Rows are deliberately one line each: the catalogue is 400+ models, and the
 * multi-line format used to overflow the response cap and get cut mid-list —
 * callers were told "here are the models" while two thirds were missing. What
 * a caller needs from a listing is the exact model ID; details belong to
 * atlas_get_model_info.
 */
export function formatModelList(
  models: Model[],
  options: ModelListOptions = {}
): string {
  const { type, filterLabel, limit = 60 } = options;
  const filtered = type ? models.filter((m) => m.type === type) : models;

  const lines: string[] = [`# Atlas Cloud Models`];
  const filters = [type, filterLabel].filter(Boolean).join(", ");
  if (filters) lines.push(`\n> Filter: ${filters}`);

  const shown = filtered.slice(0, limit);
  if (shown.length < filtered.length) {
    lines.push(
      `\nShowing ${shown.length} of ${filtered.length} matching models.`,
      `Narrow the result with \`type\` or a more specific \`query\`, or raise \`limit\` (max 200), to see the rest.\n`
    );
  } else {
    lines.push(`\nTotal: ${filtered.length} models\n`);
  }

  // Group by type so a caller scanning for "a video model" can jump straight there
  const grouped: Record<string, Model[]> = {};
  for (const model of shown) {
    const t = model.type || "Other";
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push(model);
  }

  for (const [groupType, groupModels] of Object.entries(grouped)) {
    lines.push(`## ${groupType} (${groupModels.length})\n`);
    for (const m of groupModels) {
      const bits: string[] = [m.displayName];
      const kind = getModelKindLabel(m);
      // Only worth printing when it says more than the group heading already does
      if (kind && kind !== m.type) bits.push(kind);
      if (m.organization) bits.push(m.organization);
      lines.push(`- \`${m.model}\` — ${bits.join(" · ")}`);
    }
    lines.push("");
  }

  return truncate(lines.join("\n"));
}

/** Render the pricing block for a model, in that model's own billing unit. */
function formatPricing(model: Model): string[] {
  const p = model.price?.actual;
  if (!p) return [];

  const lines: string[] = [`\n## Pricing\n`];
  if (p.input_price) lines.push(`- Input: $${p.input_price}/M tokens`);
  if (p.output_price) lines.push(`- Output: $${p.output_price}/M tokens`);
  if (p.cache_price) lines.push(`- Cache read: $${p.cache_price}/M tokens`);
  if (p.cache_creation_price) {
    lines.push(`- Cache write: $${p.cache_creation_price}/M tokens`);
  }
  if (p.output_image_price) {
    lines.push(`- Output image: $${p.output_image_price}`);
  }
  if (p.base_price) {
    // Media models are not billed per request: TTS goes by characters, ASR by
    // audio minutes, video by seconds, music per song. Printing "/request" for
    // all of them misstates the price by orders of magnitude.
    const unit = formatPriceUnit(getPriceUnitKind(model));
    lines.push(`- Base: $${p.base_price}${unit || " per request"}`);
    if (model.minDuration) {
      lines.push(`  (billed for at least ${model.minDuration}s)`);
    }
  }
  if (p.request_price) lines.push(`- Per request: $${p.request_price}`);
  if (model.price?.discount && model.price.discount !== "100") {
    lines.push(`- Discount: ${model.price.discount}%`);
  }
  return lines;
}

// Format model detail as Markdown
export function formatModelInfo(model: Model): string {
  const lines: string[] = [];
  lines.push(`# ${model.displayName}`);
  lines.push(`\n> ${model.profile || "No description available"}\n`);
  lines.push(`- **Model ID**: \`${model.model}\``);
  lines.push(`- **Type**: ${model.type}`);
  const kind = getModelKindLabel(model);
  if (kind && kind !== model.type) lines.push(`- **Kind**: ${kind}`);
  if (model.organization) lines.push(`- **Provider**: ${model.organization}`);
  if (model.input_modalities?.length) {
    lines.push(`- **Input modalities**: ${model.input_modalities.join(", ")}`);
  }
  if (model.output_modalities?.length) {
    lines.push(`- **Output modalities**: ${model.output_modalities.join(", ")}`);
  }
  if (model.contextLength) lines.push(`- **Context Length**: ${model.contextLength} tokens`);
  if (model.maxCompletionTokens) lines.push(`- **Max Output**: ${model.maxCompletionTokens} tokens`);
  if (model.totalParameters) lines.push(`- **Total Parameters**: ${model.totalParameters}`);
  if (model.architectureType) lines.push(`- **Architecture**: ${model.architectureType}`);
  if (model.knowledgeCutoff) lines.push(`- **Knowledge Cutoff**: ${model.knowledgeCutoff}`);
  if (model.avgLatency) lines.push(`- **Avg Latency**: ${model.avgLatency}s`);
  if (model.tags?.length) lines.push(`- **Tags**: ${model.tags.join(", ")}`);
  if (model.supported_sampling_parameters?.length) {
    lines.push(
      `- **Sampling parameters**: ${model.supported_sampling_parameters.join(", ")}`
    );
  }

  lines.push(...formatPricing(model));

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
