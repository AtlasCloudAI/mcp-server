/**
 * Shared rendering for dry-run generation calls.
 *
 * Every generation tool infers part of the request it sends — quick-generate
 * builds the whole body from a keyword and a prompt, and the explicit tools
 * still fill in required defaults from the schema. Without a way to see the
 * result, the only way to check what would actually be submitted is to submit
 * it, which costs money. This renders that preview identically for all of them.
 */

import { API_BASE } from "../constants.js";
import type { Model } from "../types.js";

export function formatDryRun(
  model: Model,
  endpoint: string,
  body: Record<string, unknown>,
  notes: string[] = []
): string {
  const lines: string[] = ["# Dry Run — nothing was submitted\n"];
  lines.push(`- **Model**: ${model.displayName} (\`${model.model}\`)`);
  lines.push(`- **Endpoint**: \`POST ${API_BASE}${endpoint}\``);
  lines.push("");

  if (notes.length > 0) {
    notes.forEach((note) => lines.push(`> ${note}`));
    lines.push("");
  }

  lines.push("## Request body\n");
  lines.push("```json");
  lines.push(JSON.stringify(body, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(
    "These parameters passed schema validation. No task was created and no credits were spent — re-run without `dry_run` to submit."
  );

  return lines.join("\n");
}
