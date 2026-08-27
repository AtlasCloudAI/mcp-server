import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { submitGeneration } from "../services/generation.js";
import { handleError } from "../utils/error-handler.js";
import { formatDryRun } from "../utils/dry-run.js";
import {
  isLyricsModel,
  isMusicModel,
  isSTTModel,
  isTTSModel,
} from "../utils/model-kind.js";
import type { Model } from "../types.js";

/**
 * Speech synthesis, music and transcription all post to /model/generateAudio,
 * so the endpoint cannot tell them apart — but they are not interchangeable.
 * Catch the mismatch before the billable call rather than returning a garbled
 * result the caller has already paid for.
 */
function rejectTranscriptionModel(model: Model): string | null {
  if (isSTTModel(model) && !isMusicModel(model)) {
    return (
      `Model "${model.model}" is a speech-to-text model — it transcribes audio, it does not generate it. ` +
      `Use atlas_transcribe_audio instead, or pick a text-to-speech / music model with ` +
      `atlas_list_models kind="tts" or kind="music".`
    );
  }
  return null;
}

function requireTranscriptionModel(model: Model): string | null {
  if (isSTTModel(model) && !isMusicModel(model)) return null;
  const kind = isLyricsModel(model)
    ? "lyrics generation"
    : isMusicModel(model)
      ? "music generation"
      : isTTSModel(model)
        ? "text-to-speech"
        : "audio generation";
  return (
    `Model "${model.model}" is a ${kind} model, not a speech-to-text model — it cannot transcribe audio. ` +
    `Find a transcription model with atlas_list_models kind="stt" (e.g. "bytedance/seed-asr-2.0", "xai/stt-v1").`
  );
}

export function registerAudioTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_audio",
    {
      title: "Generate Audio",
      description: `Generate audio — text-to-speech (TTS), music, and song lyrics — using Atlas Cloud API.

This covers the generative Audio-type models:
  - TTS / voice models (e.g. "bytedance/seed-audio-1.0", "minimax/speech-2.6-hd", "elevenlabs/v3/text-to-speech", "google/gemini-2.5-pro-tts", "xai/tts-v1")
  - Music / song models (e.g. "suno/chirp-v5", "suno/chirp-auk", "suno/chirp-fenix", "suno/chirp-v4-5-plus", "minimax/music-3.0") — full songs with vocals, background music, jingles
  - Lyrics models (e.g. "minimax/lyrics-generation") — these return lyrics TEXT, not audio

This tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

What the result looks like:
  - TTS: one audio file URL
  - Suno music models: TWO audio tracks per generation, plus a cover-art image
  - MiniMax music: one audio file URL
  - Lyrics models: the lyrics text itself, plus a song title and style tags — nothing to download

Parameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.

IMPORTANT: The "model" parameter requires an exact model ID (e.g., "bytedance/seed-audio-1.0"). If you don't know the exact model ID, call atlas_list_models with type="Audio" (or kind="tts" / kind="music") to find it. Do NOT guess model IDs.

NOTE: For speech-to-text (transcription / ASR), use atlas_transcribe_audio instead.

You should also use atlas_get_model_info to see the full parameter list and schema for your chosen audio model before calling this tool. Different models accept different params (voice/speaker IDs, format, sample rate, speed, lyrics, style tags, custom vs inspiration mode, etc.).

Args:
  - model (string, required): The exact audio model ID. Use atlas_list_models with type="Audio" to find valid IDs.
  - params (object, required): Model-specific parameters as a JSON object. For TTS the main field is usually "text" (the content to synthesize); for music models it is usually "prompt" and/or "lyrics"/"style". Use atlas_get_model_info to see available params.
  - dry_run (boolean, optional): Build and validate the request, show the exact body that would be sent, and stop. Nothing is submitted and no credits are spent. Use this to check what a call will do before paying for it.

Returns:
  A prediction ID to check the result with atlas_get_prediction.

Examples:
  - model="bytedance/seed-audio-1.0", params={"text": "Welcome to Atlas Cloud."}
  - model="bytedance/seed-audio-1.0", params={"text": "Hello there.", "format": "mp3", "sample_rate": 24000}
  - model="suno/chirp-v5", params={"prompt": "upbeat synthwave song about coding at night"}
  - model="suno/chirp-v5", params={"custom": true, "prompt": "[Verse]\\n...", "title": "Midnight Drive", "style": "synthwave, female vocal"}
  - model="minimax/music-3.0", params={"prompt": "gentle acoustic guitar background music"}
  - model="minimax/lyrics-generation", params={"prompt": "A cheerful love song about a summer day at the beach"}`,
      inputSchema: {
        model: z.string().min(1).describe("Audio model ID"),
        params: z
          .record(z.unknown())
          .describe(
            "Model-specific parameters as JSON object. Use atlas_get_model_info to see available parameters for your chosen model."
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Build and validate the request and show it, without submitting it or spending credits"
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, params, dry_run }) => {
      try {
        const result = await submitGeneration(model, params, {
          expectedType: "Audio",
          endpoint: "/model/generateAudio",
          typeLabel: "audio",
          validateModel: rejectTranscriptionModel,
          dryRun: dry_run,
        });

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.message }],
          };
        }

        if (result.predictionId === null) {
          return {
            content: [
              {
                type: "text",
                text: formatDryRun(
                  result.model,
                  "/model/generateAudio",
                  result.body
                ),
              },
            ],
          };
        }

        const found = result.model;
        const outputNote = isLyricsModel(found)
          ? "The result will be lyrics text (title, style tags and the lyrics body), not an audio file."
          : isMusicModel(found) && found.model.startsWith("suno/")
            ? "Suno returns two tracks per generation plus cover art."
            : "The output is an audio file URL.";

        return {
          content: [
            {
              type: "text",
              text:
                `Audio generation submitted successfully.\n\n` +
                `- **Model**: ${found.displayName} (\`${found.model}\`)\n` +
                `- **Prediction ID**: \`${result.predictionId}\`\n\n` +
                `Use \`atlas_get_prediction\` with this ID to check the result. ${outputNote}\n` +
                `Audio generation usually takes 10-60 seconds; full songs can take longer.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );

  server.registerTool(
    "atlas_transcribe_audio",
    {
      title: "Transcribe Audio (Speech-to-Text)",
      description: `Transcribe speech audio to text (ASR / speech-to-text) using Atlas Cloud API.

Use this for: transcribing recordings, meetings, interviews, podcasts, voice notes; getting subtitles/captions text from audio.

This tool submits the transcription request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

What the result looks like: the transcript TEXT is returned directly in the output — there is no file to download. When the model supports it, the result also carries the audio duration, per-word timestamps and speaker labels.

Parameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.

IMPORTANT: The "model" parameter requires an exact speech-to-text model ID (e.g., "bytedance/seed-asr-2.0", "xai/stt-v1"). Find them with atlas_list_models kind="stt". Do NOT guess model IDs — passing a text-to-speech model here is rejected before it costs anything.

The audio must be reachable via URL. For local files, first call atlas_upload_media to get a URL.

Args:
  - model (string, required): The exact speech-to-text model ID.
  - params (object, required): Model-specific parameters. The main field is usually "audio_url" (URL of the audio to transcribe). Other common params: "language", "format", "enable_punc", "show_utterances". Use atlas_get_model_info to see available params.
  - dry_run (boolean, optional): Build and validate the request, show the exact body that would be sent, and stop. Nothing is submitted and no credits are spent. Use this to check what a call will do before paying for it.

Returns:
  A prediction ID to check the result with atlas_get_prediction. The output is the transcribed text.

Examples:
  - model="bytedance/seed-asr-2.0", params={"audio_url": "https://example.com/meeting.mp3"}
  - model="bytedance/seed-asr-2.0", params={"audio_url": "https://example.com/interview.wav", "show_utterances": true}`,
      inputSchema: {
        model: z.string().min(1).describe("Speech-to-text model ID"),
        params: z
          .record(z.unknown())
          .describe(
            'Model-specific parameters as JSON object. The main field is usually "audio_url". Use atlas_get_model_info to see available parameters.'
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Build and validate the request and show it, without submitting it or spending credits"
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, params, dry_run }) => {
      try {
        const result = await submitGeneration(model, params, {
          expectedType: "Audio",
          endpoint: "/model/generateAudio",
          typeLabel: "audio",
          validateModel: requireTranscriptionModel,
          dryRun: dry_run,
        });

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.message }],
          };
        }

        if (result.predictionId === null) {
          return {
            content: [
              {
                type: "text",
                text: formatDryRun(
                  result.model,
                  "/model/generateAudio",
                  result.body
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text:
                `Transcription submitted successfully.\n\n` +
                `- **Model**: ${result.model.displayName} (\`${result.model.model}\`)\n` +
                `- **Prediction ID**: \`${result.predictionId}\`\n\n` +
                `Use \`atlas_get_prediction\` with this ID to get the transcript. The text comes back in the result itself — there is no file to download.\n` +
                `Transcription usually takes 10-60 seconds.`,
            },
          ],
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
