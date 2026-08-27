/**
 * Chat protocol adapter.
 *
 * Which API contract an LLM speaks is decided by the backend's
 * `supported_protocols` field, not by us. Gemini models prefer the native
 * `{model}:generateContent` contract (contents/parts + systemInstruction), and
 * the ones that declare ONLY `gemini.generate` cannot be called through
 * /chat/completions at all. Hard-coding one vendor's shape silently breaks the
 * others, so endpoint, request body, and response parsing are all resolved
 * per protocol here.
 *
 * Mirrors the homepage's config/model-protocols.ts so both sides stay in sync.
 */

import type { ChatTurn, MediaInput, ModelProtocol } from "../types.js";

export const MODEL_PROTOCOLS = {
  /** /v1/chat/completions */
  OPENAI_CHAT_COMPLETIONS: "openai.chat.completions",
  /** /v1/completions — plain text completion, no multimodal input */
  OPENAI_COMPLETIONS: "openai.completions",
  /** /v1/responses */
  OPENAI_RESPONSES: "openai.responses",
  /** /v1/images/generations — image generation, no messages */
  OPENAI_IMAGES: "openai.images",
  /** /v1/messages */
  CLAUDE_MESSAGES: "claude.messages",
  /** /v1/models/{model}:generateContent */
  GEMINI_GENERATE: "gemini.generate",
} as const satisfies Record<string, ModelProtocol>;

// Protocols this server can actually build a request for and read a reply from.
// The backend may advertise others; picking one of those would just produce a
// request the far end cannot parse.
const IMPLEMENTED_PROTOCOLS = new Set<string>([
  MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS,
  MODEL_PROTOCOLS.OPENAI_RESPONSES,
  MODEL_PROTOCOLS.CLAUDE_MESSAGES,
  MODEL_PROTOCOLS.GEMINI_GENERATE,
]);

const KNOWN_PROTOCOLS = new Set<string>(Object.values(MODEL_PROTOCOLS));

/**
 * Pick the protocol to call a model with.
 *
 * `supported_protocols` is ORDERED: the first entry is the backend's preferred
 * contract (Gemini models send ["gemini.generate", "openai.chat.completions"],
 * with multimodal only on the native one). Take the first entry we implement —
 * do not override the backend's ordering with a local preference.
 */
export function resolveChatProtocol(
  supportedProtocols?: string[]
): ModelProtocol {
  if (!Array.isArray(supportedProtocols) || supportedProtocols.length === 0) {
    // Older entries have no such field; keep the historical behaviour
    return MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS;
  }
  const matched = supportedProtocols
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim().toLowerCase())
    .find((p) => IMPLEMENTED_PROTOCOLS.has(p));
  return (matched as ModelProtocol) ?? MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS;
}

/**
 * The protocol the backend declares, whether or not we implement it.
 * Documentation must tell the truth about how a model is called; only the
 * actual caller is restricted to what works.
 */
export function resolveDeclaredProtocol(
  supportedProtocols?: string[]
): ModelProtocol {
  if (!Array.isArray(supportedProtocols) || supportedProtocols.length === 0) {
    return MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS;
  }
  const matched = supportedProtocols
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim().toLowerCase())
    .find((p) => KNOWN_PROTOCOLS.has(p));
  return (matched as ModelProtocol) ?? MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS;
}

/** Whether this server can build and parse a call for this protocol. */
export function isProtocolImplemented(protocol: ModelProtocol): boolean {
  return IMPLEMENTED_PROTOCOLS.has(protocol);
}

/** Whether the OpenAI SDK can talk to this endpoint as-is. */
export function isOpenAiCompatible(protocol: ModelProtocol): boolean {
  return (
    protocol === MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS ||
    protocol === MODEL_PROTOCOLS.OPENAI_COMPLETIONS
  );
}

/**
 * Which media kinds each protocol can express. This is about the wire format
 * only; whether a given model accepts them is `input_modalities`.
 */
const PROTOCOL_MEDIA_SUPPORT: Record<ModelProtocol, MediaInput["kind"][]> = {
  [MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS]: ["image", "video", "audio"],
  [MODEL_PROTOCOLS.OPENAI_RESPONSES]: ["image", "audio"], // Responses still has no video input
  [MODEL_PROTOCOLS.CLAUDE_MESSAGES]: ["image"], // Claude takes images only
  [MODEL_PROTOCOLS.GEMINI_GENERATE]: ["image", "video", "audio"],
  [MODEL_PROTOCOLS.OPENAI_COMPLETIONS]: [],
  [MODEL_PROTOCOLS.OPENAI_IMAGES]: [],
};

export function isMediaSupportedByProtocol(
  protocol: ModelProtocol,
  kind: MediaInput["kind"]
): boolean {
  return PROTOCOL_MEDIA_SUPPORT[protocol]?.includes(kind) ?? false;
}

/** Split a data URI into mime type and raw base64; null if it is not one. */
function parseDataUri(url: string): { mimeType: string; data: string } | null {
  const matched = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (!matched) return null;
  return { mimeType: matched[1], data: matched[2] };
}

/** Guess a mime type from the extension, for protocols that require one. */
function guessMimeType(url: string, kind: MediaInput["kind"]): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  const tables: Record<MediaInput["kind"], Record<string, string>> = {
    image: {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    },
    video: {
      mp4: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
      mkv: "video/x-matroska",
      avi: "video/x-msvideo",
    },
    audio: {
      wav: "audio/wav",
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      ogg: "audio/ogg",
      flac: "audio/flac",
    },
  };
  const fallback: Record<MediaInput["kind"], string> = {
    image: "image/jpeg",
    video: "video/mp4",
    audio: "audio/mpeg",
  };
  return tables[kind][ext] ?? fallback[kind];
}

/** OpenAI's input_audio wants a short format name (wav / mp3), not a mime. */
function toAudioFormat(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
  if (subtype === "mpeg" || subtype === "mp3") return "mp3";
  if (subtype === "wav" || subtype === "x-wav" || subtype === "wave") return "wav";
  return subtype || "wav";
}

/**
 * OpenAI-family audio part. Unlike images this needs raw base64 plus a format
 * and does NOT accept a URL, so a plain link cannot be expressed here.
 */
function buildOpenAIAudioPart(url: string): Record<string, unknown> | null {
  const parsed = parseDataUri(url);
  if (!parsed) return null;
  return {
    type: "input_audio",
    input_audio: { data: parsed.data, format: toAudioFormat(parsed.mimeType) },
  };
}

/** Build one media content part; null when the protocol cannot express it. */
export function buildMediaContentPart(
  protocol: ModelProtocol,
  media: MediaInput
): Record<string, unknown> | null {
  if (!media.url || !isMediaSupportedByProtocol(protocol, media.kind)) {
    return null;
  }

  switch (protocol) {
    case MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS:
      if (media.kind === "audio") return buildOpenAIAudioPart(media.url);
      return media.kind === "image"
        ? { type: "image_url", image_url: { url: media.url } }
        : { type: "video_url", video_url: { url: media.url } };

    case MODEL_PROTOCOLS.OPENAI_RESPONSES:
      if (media.kind === "audio") return buildOpenAIAudioPart(media.url);
      // Responses takes image_url as a bare string, not an object
      return { type: "input_image", image_url: media.url };

    case MODEL_PROTOCOLS.CLAUDE_MESSAGES: {
      const parsed = parseDataUri(media.url);
      return {
        type: "image",
        source: parsed
          ? { type: "base64", media_type: parsed.mimeType, data: parsed.data }
          : { type: "url", url: media.url },
      };
    }

    case MODEL_PROTOCOLS.GEMINI_GENERATE: {
      const parsed = parseDataUri(media.url);
      return parsed
        ? { inline_data: { mime_type: parsed.mimeType, data: parsed.data } }
        : {
            file_data: {
              mime_type: guessMimeType(media.url, media.kind),
              file_uri: media.url,
            },
          };
    }

    default:
      return null;
  }
}

/** Text part shape for this protocol (Gemini parts carry no `type`). */
export function buildTextContentPart(
  protocol: ModelProtocol,
  text: string
): Record<string, unknown> {
  if (protocol === MODEL_PROTOCOLS.GEMINI_GENERATE) return { text };
  if (protocol === MODEL_PROTOCOLS.OPENAI_RESPONSES) {
    return { type: "input_text", text };
  }
  return { type: "text", text };
}

/** Build the request URL for this protocol. `baseUrl` e.g. .../v1 */
export function buildChatEndpoint(
  protocol: ModelProtocol,
  baseUrl: string,
  model: string
): string {
  const base = baseUrl.replace(/\/+$/, "");
  switch (protocol) {
    case MODEL_PROTOCOLS.OPENAI_RESPONSES:
      return `${base}/responses`;
    case MODEL_PROTOCOLS.CLAUDE_MESSAGES:
      return `${base}/messages`;
    case MODEL_PROTOCOLS.OPENAI_COMPLETIONS:
      return `${base}/completions`;
    case MODEL_PROTOCOLS.OPENAI_IMAGES:
      return `${base}/images/generations`;
    case MODEL_PROTOCOLS.GEMINI_GENERATE:
      return `${base}/models/${model}:generateContent`;
    default:
      return `${base}/chat/completions`;
  }
}

/** Path of the endpoint relative to the LLM API base, for the shared client. */
export function buildChatPath(protocol: ModelProtocol, model: string): string {
  return buildChatEndpoint(protocol, "", model);
}

/** Turn one conversation turn into this protocol's content value. */
function buildTurnContent(
  protocol: ModelProtocol,
  turn: ChatTurn
): string | Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];

  for (const media of turn.media ?? []) {
    const part = buildMediaContentPart(protocol, media);
    // Skip what the protocol cannot express rather than sending a field the
    // far end will not understand
    if (part) parts.push(part);
  }

  if (parts.length === 0) {
    // Gemini always wants a parts array; OpenAI-family accepts a bare string
    return protocol === MODEL_PROTOCOLS.GEMINI_GENERATE
      ? [buildTextContentPart(protocol, turn.text)]
      : turn.text;
  }

  if (turn.text) parts.push(buildTextContentPart(protocol, turn.text));
  return parts;
}

export interface ChatRequestOptions {
  model: string;
  turns: ChatTurn[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  // Extra sampling knobs passed through untouched (top_k, stop, seed, ...).
  // Only meaningful on the OpenAI-family protocols.
  extra?: Record<string, unknown>;
}

/** Build the request body for this protocol. */
export function buildChatRequestBody(
  protocol: ModelProtocol,
  options: ChatRequestOptions
): Record<string, unknown> {
  const { model, turns, maxTokens, temperature, topP, extra } = options;

  if (protocol === MODEL_PROTOCOLS.GEMINI_GENERATE) {
    // Model name lives in the URL; assistant role is "model"; system prompts
    // move to a dedicated systemInstruction field
    const systemText = turns
      .filter((t) => t.role === "system" && t.text)
      .map((t) => t.text)
      .join("\n");

    const contents = turns
      .filter((t) => t.role !== "system")
      .map((t) => ({
        role: t.role === "assistant" ? "model" : "user",
        parts: buildTurnContent(protocol, t),
      }));

    const generationConfig: Record<string, unknown> = {};
    if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
    if (temperature !== undefined) generationConfig.temperature = temperature;
    if (topP !== undefined) generationConfig.topP = topP;

    return {
      contents,
      ...(systemText
        ? { systemInstruction: { parts: [{ text: systemText }] } }
        : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    };
  }

  if (protocol === MODEL_PROTOCOLS.OPENAI_RESPONSES) {
    return {
      model,
      input: turns.map((t) => ({
        role: t.role,
        content: buildTurnContent(protocol, t),
      })),
      ...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
      ...(extra || {}),
    };
  }

  if (protocol === MODEL_PROTOCOLS.CLAUDE_MESSAGES) {
    // Claude keeps `system` at the top level, outside `messages`
    const systemText = turns
      .filter((t) => t.role === "system" && t.text)
      .map((t) => t.text)
      .join("\n");

    return {
      model,
      messages: turns
        .filter((t) => t.role !== "system")
        .map((t) => ({ role: t.role, content: buildTurnContent(protocol, t) })),
      ...(systemText ? { system: systemText } : {}),
      // max_tokens is mandatory on this protocol
      max_tokens: maxTokens ?? 4096,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
      ...(extra || {}),
    };
  }

  // Default: openai.chat.completions
  return {
    model,
    messages: turns.map((t) => ({
      role: t.role,
      content: buildTurnContent(protocol, t),
    })),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    ...(extra || {}),
  };
}

/** Where the reply text lives in each protocol's response. */
const RESPONSE_TEXT_PATH: Record<ModelProtocol, (string | number)[]> = {
  [MODEL_PROTOCOLS.OPENAI_CHAT_COMPLETIONS]: ["choices", 0, "message", "content"],
  [MODEL_PROTOCOLS.OPENAI_RESPONSES]: ["output", 0, "content", 0, "text"],
  [MODEL_PROTOCOLS.CLAUDE_MESSAGES]: ["content", 0, "text"],
  [MODEL_PROTOCOLS.GEMINI_GENERATE]: [
    "candidates",
    0,
    "content",
    "parts",
    0,
    "text",
  ],
  [MODEL_PROTOCOLS.OPENAI_COMPLETIONS]: ["choices", 0, "text"],
  [MODEL_PROTOCOLS.OPENAI_IMAGES]: ["data", 0, "url"],
};

/** Render a response path the way a caller would write it in code. */
export function renderResponsePath(protocol: ModelProtocol): string {
  return RESPONSE_TEXT_PATH[protocol]
    .map((seg) => (typeof seg === "number" ? `[${seg}]` : `["${seg}"]`))
    .join("");
}

function readPath(root: unknown, path: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

/**
 * Pull the reply text out of a response for this protocol.
 *
 * Gemini splits a reply across several `parts`, so the declared path (which
 * only points at part 0) is a fallback — join every text part first.
 */
export function extractResponseText(
  protocol: ModelProtocol,
  response: unknown
): string | undefined {
  if (protocol === MODEL_PROTOCOLS.GEMINI_GENERATE) {
    const parts = readPath(response, ["candidates", 0, "content", "parts"]);
    if (Array.isArray(parts)) {
      const joined = parts
        .map((p) =>
          p && typeof p === "object" && typeof (p as any).text === "string"
            ? (p as any).text
            : ""
        )
        .filter(Boolean)
        .join("");
      if (joined) return joined;
    }
  }

  if (protocol === MODEL_PROTOCOLS.CLAUDE_MESSAGES) {
    const blocks = readPath(response, ["content"]);
    if (Array.isArray(blocks)) {
      const joined = blocks
        .map((b) =>
          b && typeof b === "object" && (b as any).type === "text"
            ? String((b as any).text ?? "")
            : ""
        )
        .filter(Boolean)
        .join("");
      if (joined) return joined;
    }
  }

  const value = readPath(response, RESPONSE_TEXT_PATH[protocol]);
  return typeof value === "string" ? value : undefined;
}

/** Why generation stopped, normalized across protocols. */
export function extractFinishReason(
  protocol: ModelProtocol,
  response: unknown
): string | undefined {
  const candidates: (string | number)[][] =
    protocol === MODEL_PROTOCOLS.GEMINI_GENERATE
      ? [["candidates", 0, "finishReason"]]
      : protocol === MODEL_PROTOCOLS.CLAUDE_MESSAGES
        ? [["stop_reason"]]
        : protocol === MODEL_PROTOCOLS.OPENAI_RESPONSES
          ? [["status"], ["incomplete_details", "reason"]]
          : [["choices", 0, "finish_reason"]];

  for (const path of candidates) {
    const value = readPath(response, path);
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Token usage, normalized to prompt / completion / total. */
export function extractUsage(
  protocol: ModelProtocol,
  response: unknown
): { prompt?: number; completion?: number; total?: number } | undefined {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" ? v : undefined;

  if (protocol === MODEL_PROTOCOLS.GEMINI_GENERATE) {
    const u = readPath(response, ["usageMetadata"]) as
      | Record<string, unknown>
      | undefined;
    if (!u) return undefined;
    return {
      prompt: num(u.promptTokenCount),
      completion: num(u.candidatesTokenCount),
      total: num(u.totalTokenCount),
    };
  }

  const u = readPath(response, ["usage"]) as Record<string, unknown> | undefined;
  if (!u) return undefined;

  if (protocol === MODEL_PROTOCOLS.CLAUDE_MESSAGES) {
    const input = num(u.input_tokens);
    const output = num(u.output_tokens);
    return {
      prompt: input,
      completion: output,
      total:
        input !== undefined && output !== undefined ? input + output : undefined,
    };
  }

  if (protocol === MODEL_PROTOCOLS.OPENAI_RESPONSES) {
    return {
      prompt: num(u.input_tokens),
      completion: num(u.output_tokens),
      total: num(u.total_tokens),
    };
  }

  return {
    prompt: num(u.prompt_tokens),
    completion: num(u.completion_tokens),
    total: num(u.total_tokens),
  };
}
