/**
 * Sub-kinds that cut across model.type, for the local server's atlas_list_models
 * `kind` filter (kept from npm 1.x). 3D models are typed Image upstream, and the
 * Audio bucket mixes speech synthesis, transcription, music and lyrics.
 *
 * Category signals from the backend are unreliable and are combined: every Suno
 * model is filed under TEXT-TO-SPEECH but tagged MUSIC/TEXT_TO_MUSIC, and
 * minimax/lyrics-generation sits in TEXT-TO-AUDIO while producing text.
 */

import type { Model } from "../types.js";

export const MODEL_KINDS = ["3d", "tts", "stt", "music", "lyrics"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

// Lowercase, underscores to hyphens: the backend mixes TEXT_TO_MUSIC and TEXT-TO-MUSIC.
function signalsOf(model: Model): string[] {
  return [...(model.categories || []), ...(model.tags || [])]
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.toLowerCase().replace(/_/g, "-"));
}

function isTTSModel(model: Model): boolean {
  return signalsOf(model).includes("text-to-speech");
}

function isSTTModel(model: Model): boolean {
  return signalsOf(model).includes("speech-to-text");
}

// Checked before TTS/STT: the backend files music models under both.
function isMusicModel(model: Model): boolean {
  const signals = signalsOf(model);
  return signals.includes("music") || signals.includes("text-to-music");
}

function isLyricsModel(model: Model): boolean {
  return (model.model || "").toLowerCase().includes("lyrics");
}

function is3DModel(model: Model): boolean {
  return (
    (model.tags || []).some((tag) => typeof tag === "string" && tag.toUpperCase().includes("3D")) ||
    (model.model || "").toLowerCase().includes("-to-3d")
  );
}

export const KIND_FILTERS: Record<ModelKind, (model: Model) => boolean> = {
  "3d": is3DModel,
  tts: (m) => m.type === "Audio" && isTTSModel(m) && !isMusicModel(m),
  stt: (m) => m.type === "Audio" && isSTTModel(m) && !isMusicModel(m),
  music: (m) => m.type === "Audio" && isMusicModel(m) && !isLyricsModel(m),
  lyrics: (m) => m.type === "Audio" && isLyricsModel(m),
};
