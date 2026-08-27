/**
 * Model classification and output-shape helpers.
 *
 * Two questions are answered here, and they are independent:
 *   1. What kind of thing does this model produce (image / video / audio / 3d / text)?
 *   2. Is a given `outputs[]` entry a media URL, or is it the content itself?
 *
 * Both matter because the Audio pipeline is not uniform: TTS and music return
 * audio URLs, while speech-to-text and lyrics generation return plain text in
 * `outputs[0]`. Rendering the latter as "output URLs you can download" is wrong.
 *
 * Category signals from the backend are unreliable and must be combined:
 * every Suno model is filed under TEXT-TO-SPEECH but tagged MUSIC/TEXT_TO_MUSIC,
 * and `minimax/lyrics-generation` sits in TEXT-TO-AUDIO while producing text.
 */

import type { Model, SkuPriceUnit } from "../types.js";

export type ModelOutputCategory = "image" | "video" | "audio" | "3d" | "text";

// Normalize a category/tag token: lowercase, underscores to hyphens.
// The backend mixes TEXT_TO_MUSIC and TEXT-TO-MUSIC in the same list.
function normalizeSignal(value: string): string {
  return value.toLowerCase().replace(/_/g, "-");
}

// All classification signals a model carries (categories + tags)
function signalsOf(model: Model): string[] {
  return [...(model.categories || []), ...(model.tags || [])]
    .filter((s): s is string => typeof s === "string")
    .map(normalizeSignal);
}

/** Text-to-speech: billed per 1K characters. */
export function isTTSModel(model: Model): boolean {
  return signalsOf(model).includes("text-to-speech");
}

/** Speech-to-text / ASR: billed per minute of audio, returns text. */
export function isSTTModel(model: Model): boolean {
  return signalsOf(model).includes("speech-to-text");
}

/**
 * Music generation: one call produces a whole song (or a whole set of lyrics),
 * billed per generation. Must be checked BEFORE the TTS/STT signals — the
 * backend files music models under both TEXT-TO-SPEECH and SPEECH-TO-TEXT.
 */
export function isMusicModel(model: Model): boolean {
  const signals = signalsOf(model);
  return signals.includes("music") || signals.includes("text-to-music");
}

/**
 * Lyrics generation: runs through the audio pipeline but returns lyrics text,
 * not an audio URL. The backend's category for it has moved around, so match on
 * the model id instead.
 */
export function isLyricsModel(model: Model): boolean {
  return (model.model || "").toLowerCase().includes("lyrics");
}

/** Audio-pipeline models whose result is text rather than an audio file. */
export function isTextResultModel(model: Model): boolean {
  return isSTTModel(model) || isLyricsModel(model);
}

/** 3D models are typed "Image" upstream; tags or a `-to-3d` id identify them. */
export function is3DModel(model: Model): boolean {
  return (
    (model.tags || []).some(
      (tag) => typeof tag === "string" && tag.toUpperCase().includes("3D")
    ) || (model.model || "").toLowerCase().includes("-to-3d")
  );
}

/** What a model produces. Returns null when the type is missing or unknown. */
export function getModelOutputCategory(
  model?: Model | null
): ModelOutputCategory | null {
  if (!model) return null;
  if (is3DModel(model)) return "3d";
  // STT / lyrics run on the Audio endpoint but produce text
  if (model.type === "Audio" && isTextResultModel(model)) return "text";
  switch (model.type) {
    case "Audio":
      return "audio";
    case "Video":
      return "video";
    case "Image":
      return "image";
    case "Text":
      return "text";
    default:
      return null;
  }
}

/** Human label for a model's sub-kind, used in listings. */
export function getModelKindLabel(model: Model): string {
  if (is3DModel(model)) return "3D";
  if (model.type === "Audio") {
    if (isMusicModel(model)) return isLyricsModel(model) ? "Lyrics" : "Music";
    if (isLyricsModel(model)) return "Lyrics";
    if (isSTTModel(model)) return "Speech-to-Text";
    if (isTTSModel(model)) return "Text-to-Speech";
  }
  return model.type;
}

/* ------------------------------------------------------------------ *
 * Output URL classification
 * ------------------------------------------------------------------ */

const VIDEO_EXTS = [".mp4", ".webm", ".ogg", ".mov", ".mkv", ".avi"];
const AUDIO_EXTS = [".mp3", ".wav", ".aac", ".m4a", ".flac", ".opus"];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"];
// Renderable meshes, packaged archives, and download-only 3D formats
const THREE_D_EXTS = [
  ".glb",
  ".gltf",
  ".obj",
  ".fbx",
  ".stl",
  ".ply",
  ".usdz",
  ".usdc",
  ".usd",
  ".zip",
];

function pathOf(url: string): string {
  return url.toLowerCase().split(/[?#]/)[0];
}

function hasExt(url: string, exts: string[]): boolean {
  const path = pathOf(url);
  return exts.some((ext) => path.endsWith(ext));
}

export const isVideoUrl = (url: string): boolean => hasExt(url, VIDEO_EXTS);
export const isAudioUrl = (url: string): boolean => hasExt(url, AUDIO_EXTS);
export const isImageUrl = (url: string): boolean => hasExt(url, IMAGE_EXTS);
export const is3DUrl = (url: string): boolean => hasExt(url, THREE_D_EXTS);

/**
 * Whether an `outputs[]` entry is content rather than a link.
 * Anything that is not http(s) / protocol-relative / a data URI is text —
 * that is how ASR transcripts and generated lyrics come back.
 */
export function isTextOutput(value: string): boolean {
  if (!value) return false;
  const s = value.trim();
  return !/^https?:\/\//i.test(s) && !s.startsWith("//") && !s.startsWith("data:");
}

/** Label a single output URL for display. */
export function describeOutputUrl(url: string): string {
  if (is3DUrl(url)) return "3D file";
  if (isVideoUrl(url)) return "video";
  if (isAudioUrl(url)) return "audio";
  if (isImageUrl(url)) return "image";
  return "file";
}

/* ------------------------------------------------------------------ *
 * Pricing units
 * ------------------------------------------------------------------ */

export type PriceUnitKind =
  | "minute"
  | "generation"
  | "kChars"
  | "second"
  | "image"
  | null;

// TTS models the backend actually settles per minute of generated audio even
// though they are tagged TEXT-TO-SPEECH. Drop this once `unit` is always sent.
const PER_MINUTE_TTS_MODELS = ["bytedance/seed-audio-1.0"];

// Read the backend-declared unit; unknown values fall through to heuristics
// so that a new enum value never blanks the unit out entirely.
function getDeclaredPriceUnit(model: Model): PriceUnitKind | undefined {
  const declared: SkuPriceUnit | undefined =
    model.price?.actual?.unit || model.price?.origin?.unit;
  switch (declared) {
    case "minute":
      return "minute";
    case "generation":
      return "generation";
    case "1k_chars":
      return "kChars";
    case "second":
      return "second";
    case "image":
      return "image";
    default:
      return undefined;
  }
}

/**
 * Billing dimension of `base_price`. Backend-declared unit wins; older models
 * fall back to category heuristics. Music is resolved before TTS/STT because
 * its category bucket collides with both.
 */
export function getPriceUnitKind(model: Model): PriceUnitKind {
  const declared = getDeclaredPriceUnit(model);
  if (declared !== undefined) return declared;

  if (isMusicModel(model)) return "generation";
  if (isSTTModel(model)) return "minute";
  if (PER_MINUTE_TTS_MODELS.includes((model.model || "").toLowerCase())) {
    return "minute";
  }
  if (isTTSModel(model)) return "kChars";

  const type = (model.type || "").toLowerCase();
  if (type.includes("video")) return "second";
  if (type.includes("image")) return "image";
  return null;
}

/** Suffix to print after a base price, e.g. "$0.02/1K characters". */
export function formatPriceUnit(kind: PriceUnitKind): string {
  switch (kind) {
    case "minute":
      return "/minute of audio";
    case "generation":
      return "/generation";
    case "kChars":
      return "/1K characters";
    case "second":
      return "/second of video";
    case "image":
      return "/image";
    default:
      return "";
  }
}
