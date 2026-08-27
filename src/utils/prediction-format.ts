/**
 * Rendering for prediction results.
 *
 * A prediction is not always "a list of URLs". Depending on the model, the same
 * `outputs` array holds media links, a speech-to-text transcript, or the full
 * text of generated lyrics, and the interesting parts of the result may live in
 * sibling fields entirely (`stt_result`, `lyrics_result`, `thumbnail`). Printing
 * `outputs` and calling them downloadable files is wrong for half the catalogue,
 * so the shape is inspected before anything is labelled.
 */

import type { Model, PredictionData, SttResult, LyricsResult } from "../types.js";
import {
  describeOutputUrl,
  getModelOutputCategory,
  isTextOutput,
} from "./model-kind.js";
import { truncate } from "./formatter.js";

// Statuses that mean the task is finished, successfully or not.
// `timeout` belongs here: it is terminal, and treating it as "still running"
// leaves callers polling a task that will never change.
const TERMINAL_STATUSES = new Set([
  "completed",
  "succeeded",
  "success",
  "failed",
  "canceled",
  "cancelled",
  "error",
  "timeout",
]);

const FAILURE_STATUSES = new Set([
  "failed",
  "canceled",
  "cancelled",
  "error",
  "timeout",
]);

export function isTerminalStatus(status?: string): boolean {
  return !!status && TERMINAL_STATUSES.has(status.toLowerCase());
}

export function isFailureStatus(status?: string): boolean {
  return !!status && FAILURE_STATUSES.has(status.toLowerCase());
}

/**
 * Collapse an error field to a printable string. The backend sends a plain
 * string on some models and an object on others; interpolating the object
 * yields "[object Object]" and loses the reason entirely.
 */
export function toErrorMessage(error: unknown, fallback = ""): string {
  if (error === null || error === undefined) return fallback;
  if (typeof error === "string") return error.trim() || fallback;
  if (typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    for (const key of ["message", "msg", "error", "detail", "reason"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/** Normalize `outputs` / `output` into a string list. */
export function collectOutputs(data: PredictionData): string[] {
  const raw = data.outputs ?? data.output;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        // A few schemas declare outputs as objects. Real responses send
        // strings, but never render an object as "[object Object]".
        const obj = item as Record<string, unknown>;
        for (const key of ["url", "download_url", "audio_url", "video_url"]) {
          if (typeof obj[key] === "string") return obj[key] as string;
        }
        try {
          return JSON.stringify(item);
        } catch {
          return "";
        }
      }
      return "";
    })
    .filter((s) => s.length > 0);
}

/**
 * Decide how to present the outputs.
 * The content itself wins over the model's declared type: an Audio-typed ASR
 * model returns text, and there is no URL to play.
 */
export function resolveOutputMode(
  outputs: string[],
  model?: Model | null
): "text" | "media" | "empty" {
  if (outputs.length === 0) return "empty";
  if (outputs.every((o) => isTextOutput(o))) return "text";
  const category = getModelOutputCategory(model);
  if (category === "text" && isTextOutput(outputs[0])) return "text";
  return "media";
}

function formatSeconds(value?: number): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value >= 60) {
    const m = Math.floor(value / 60);
    const s = Math.round(value % 60);
    return `${m}m ${s}s`;
  }
  return `${value.toFixed(1)}s`;
}

/** Compact summary of a transcript: full text plus what the timestamps cover. */
function renderSttResult(stt: SttResult, alreadyShownText: boolean): string[] {
  const lines: string[] = ["## Transcript\n"];

  if (!alreadyShownText && typeof stt.text === "string" && stt.text) {
    lines.push(stt.text, "");
  }

  const facts: string[] = [];
  const duration = formatSeconds(stt.duration);
  if (duration) facts.push(`Audio duration: ${duration}`);
  if (stt.language || stt.language_code) {
    facts.push(`Language: ${stt.language || stt.language_code}`);
  }
  if (Array.isArray(stt.words) && stt.words.length > 0) {
    const speakers = new Set(
      stt.words
        .map((w) => w?.speaker_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    );
    facts.push(`Word-level timestamps: ${stt.words.length} segments`);
    if (speakers.size > 0) facts.push(`Speakers detected: ${speakers.size}`);
  }
  if (Array.isArray(stt.channels) && stt.channels.length > 1) {
    facts.push(`Channels: ${stt.channels.length}`);
  }
  facts.forEach((f) => lines.push(`- ${f}`));

  if (Array.isArray(stt.words) && stt.words.length > 0) {
    lines.push(
      "",
      "> Per-word timestamps are omitted here to keep the response small. " +
        "They are available in the raw `stt_result.words` field of " +
        "`GET /api/v1/model/prediction/{id}`."
    );
  }
  return lines;
}

/** Lyrics come back structured; `outputs[0]` is only a copy of the body. */
function renderLyricsResult(lyrics: LyricsResult): string[] {
  const lines: string[] = ["## Lyrics\n"];
  if (lyrics.song_title) lines.push(`- **Title**: ${lyrics.song_title}`);
  if (Array.isArray(lyrics.style_tags) && lyrics.style_tags.length > 0) {
    lines.push(`- **Style tags**: ${lyrics.style_tags.join(", ")}`);
  }
  if (typeof lyrics.lyrics === "string" && lyrics.lyrics) {
    lines.push("", lyrics.lyrics);
    lines.push(
      "",
      "> Pass this text as the `lyrics` parameter of a music model " +
        "(e.g. `minimax/music-3.0`) to turn it into a song."
    );
  }
  return lines;
}

export interface RenderPredictionOptions {
  // Heading of the rendered block
  title?: string;
  // Resolved model metadata, used to label the output kind
  model?: Model | null;
  // Include the polling hint when the task is still running
  showPollingHint?: boolean;
}

/**
 * Render a prediction payload as Markdown.
 * Shared by atlas_get_prediction and the history listing so both describe a
 * result the same way.
 */
export function renderPrediction(
  data: PredictionData,
  options: RenderPredictionOptions = {}
): string {
  const { title = "Prediction Result", model, showPollingHint = true } = options;
  const status = typeof data.status === "string" ? data.status : "";
  const lines: string[] = [`# ${title}\n`];

  if (data.id) lines.push(`- **ID**: \`${data.id}\``);
  if (data.model) lines.push(`- **Model**: \`${data.model}\``);
  lines.push(`- **Status**: ${status || "unknown"}`);
  if (data.price !== undefined && data.price !== null && data.price !== "") {
    lines.push(`- **Cost**: $${data.price}`);
  }
  const latency = formatSeconds(
    typeof data.latency_ms === "number" ? data.latency_ms / 1000 : undefined
  );
  if (latency) lines.push(`- **Latency**: ${latency}`);
  if (typeof data.duration === "number") {
    const d = formatSeconds(data.duration);
    if (d) lines.push(`- **Output duration**: ${d}`);
  }
  lines.push("");

  // Failure first: when a task failed, nothing below matters as much
  const errorText = toErrorMessage(data.error);
  if (errorText || isFailureStatus(status)) {
    lines.push("## Error\n");
    const code =
      typeof data.error_code === "number" ? `[${data.error_code}] ` : "";
    lines.push(
      code + (errorText || `The task ended with status "${status}".`)
    );
    lines.push("");
  }

  const outputs = collectOutputs(data);
  const mode = resolveOutputMode(outputs, model);
  const stt = data.stt_result;
  const lyrics = data.lyrics_result;

  if (mode === "text") {
    // ASR transcripts and generated lyrics live in outputs as plain text.
    // Presenting them as downloadable URLs makes them unusable.
    lines.push("## Output (text)\n");
    lines.push(
      "> This model returns text, not a file — the content below is the result itself.\n"
    );
    outputs.forEach((text, i) => {
      if (outputs.length > 1) lines.push(`**Result ${i + 1}:**\n`);
      lines.push(text, "");
    });
  } else if (mode === "media") {
    lines.push("## Output\n");
    outputs.forEach((url, i) => {
      lines.push(`${i + 1}. [${describeOutputUrl(url)}] ${url}`);
    });
    lines.push("");
    if (data.thumbnail) {
      // Suno ships cover art alongside the tracks
      lines.push(`Cover art: ${data.thumbnail}\n`);
    }
    lines.push(
      "You can ask me to download these files to your local machine, or open the URLs directly in your browser."
    );
    lines.push("");
  } else if (isTerminalStatus(status) && !errorText && !stt && !lyrics) {
    lines.push("## Output\n");
    lines.push("The task finished but returned no output.");
    if (Array.isArray(data.has_nsfw_contents) && data.has_nsfw_contents.some(Boolean)) {
      lines.push(
        "",
        "This is likely a content-safety block: `has_nsfw_contents` is set. Try rephrasing the prompt or changing the input media."
      );
    } else if (data.urls?.get) {
      lines.push("", `Raw result endpoint: ${data.urls.get}`);
    }
    lines.push("");
  }

  if (stt && typeof stt === "object") {
    lines.push(...renderSttResult(stt, mode === "text"));
    lines.push("");
  }

  if (lyrics && typeof lyrics === "object") {
    lines.push(...renderLyricsResult(lyrics));
    lines.push("");
  }

  if (data.files !== undefined && data.files !== null) {
    lines.push("## Additional files\n", "```json");
    lines.push(JSON.stringify(data.files, null, 2));
    lines.push("```", "");
  }

  if (Array.isArray(data.layers) && data.layers.length > 0) {
    lines.push(
      `## Layers\n`,
      `This result carries ${data.layers.length} layer descriptors aligned with the outputs above (layer-decomposition model).`,
      ""
    );
  }

  if (
    mode === "media" &&
    Array.isArray(data.has_nsfw_contents) &&
    data.has_nsfw_contents.some(Boolean)
  ) {
    const flagged = data.has_nsfw_contents.filter(Boolean).length;
    lines.push(
      `> Content safety: ${flagged} of ${data.has_nsfw_contents.length} outputs were flagged as NSFW.`,
      ""
    );
  }

  if (showPollingHint && status && !isTerminalStatus(status)) {
    lines.push(
      `The task is still in progress. Please wait a moment and use \`atlas_get_prediction\` again to check.`,
      ""
    );
  }

  if (data.metrics) {
    lines.push(`## Metrics\n`, "```json");
    lines.push(JSON.stringify(data.metrics, null, 2));
    lines.push("```");
  }

  return truncate(lines.join("\n"));
}
