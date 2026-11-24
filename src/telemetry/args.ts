import { sanitizeModel } from "./tool-call.js";

/**
 * The shape of a tool call's arguments, never their content: which arguments
 * were given, how long the prompt was, how many media links and local files
 * went in. Keys are kept only when they look like parameter names, so a model
 * `params` object with odd keys cannot smuggle text into an event.
 */

const KEY_SHAPE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const MAX_KEYS = 30;
const PROMPT_KEYS = new Set(["prompt", "text", "input", "lyrics", "negative_prompt", "system", "instructions", "query"]);
const URL_PATTERN = /^https?:\/\//i;
const DATA_URL_PATTERN = /^data:/i;
const LOCAL_PATH_PATTERN = /^(\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/]|file:\/\/)/;

function keysOf(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter((key) => KEY_SHAPE.test(key))
    .sort()
    .slice(0, MAX_KEYS);
}

interface Counts {
  promptChars: number;
  urlInputs: number;
  dataUrlInputs: number;
  localPathInputs: number;
}

function walk(value: unknown, key: string | undefined, counts: Counts, depth: number): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (URL_PATTERN.test(value)) counts.urlInputs += 1;
    else if (DATA_URL_PATTERN.test(value)) counts.dataUrlInputs += 1;
    else if (LOCAL_PATH_PATTERN.test(value) && value.length < 1024) counts.localPathInputs += 1;
    else if (key && PROMPT_KEYS.has(key)) counts.promptChars += value.length;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) walk(item, key, counts, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, childKey, counts, depth + 1);
    }
  }
}

function messageStats(messages: unknown): { message_count?: number; message_chars?: number } {
  if (!Array.isArray(messages)) return {};
  let chars = 0;
  for (const message of messages.slice(0, 200)) {
    const content = (message as { content?: unknown })?.content;
    if (typeof content === "string") chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown })?.text;
        if (typeof text === "string") chars += text.length;
      }
    }
  }
  return { message_count: messages.length, message_chars: chars };
}

export function summarizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { arg_keys: [] };
  const record = args as Record<string, unknown>;
  const counts: Counts = { promptChars: 0, urlInputs: 0, dataUrlInputs: 0, localPathInputs: 0 };
  walk(record, undefined, counts, 0);
  const summary: Record<string, unknown> = {
    arg_keys: keysOf(record),
    prompt_chars: counts.promptChars,
    url_inputs: counts.urlInputs,
    data_url_inputs: counts.dataUrlInputs,
    local_path_inputs: counts.localPathInputs,
    ...messageStats(record.messages),
  };
  const paramKeys = keysOf(record.params);
  if (paramKeys.length > 0) summary.param_keys = paramKeys;
  const model = sanitizeModel(record.model);
  if (model) summary.model = model;
  if (typeof record.dry_run === "boolean") summary.dry_run = record.dry_run;
  // Quote → confirm flow: whether this call is a confirmation, never the token or key itself.
  if (typeof record.confirmed === "boolean") summary.confirmed = record.confirmed;
  if (typeof record.confirmation_token === "string") summary.has_confirmation_token = record.confirmation_token.trim() !== "";
  if (typeof record.idempotency_key === "string") summary.has_idempotency_key = record.idempotency_key.trim() !== "";
  if (typeof record.why_this_model === "string") summary.why_this_model_chars = record.why_this_model.length;
  if (typeof record.stream === "boolean") summary.stream = record.stream;
  if (typeof record.type === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(record.type)) summary.requested_type = record.type;
  return summary;
}
