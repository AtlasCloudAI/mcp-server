import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { submitGeneration } from "../services/generation.js";
import { handleError } from "../utils/error-handler.js";

export function registerAudioTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_audio",
    {
      title: "Generate Audio",
      description: `Generate audio — text-to-speech (TTS) AND music generation — using Atlas Cloud API.

This covers BOTH kinds of Audio-type models:
  - TTS / voice models (e.g., "bytedance/seed-audio-1.0", "xai/tts-v1", ElevenLabs)
  - Music / song models (e.g., "suno/chirp-v5", "minimax/music-2.6") — full songs with vocals, background music, jingles

This tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

Parameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.

IMPORTANT: The "model" parameter requires an exact model ID (e.g., "bytedance/seed-audio-1.0"). If you don't know the exact model ID, you MUST first call atlas_list_models with type="Audio" to find it. Do NOT guess model IDs.

NOTE: For speech-to-text (transcription / ASR), use atlas_transcribe_audio instead.

You should also use atlas_get_model_info to see the full parameter list and schema for your chosen audio model before calling this tool. Different models accept different params (voice/speaker IDs, format, sample rate, speed, lyrics, style tags, etc.).

Args:
  - model (string, required): The exact audio model ID. Use atlas_list_models with type="Audio" to find valid IDs.
  - params (object, required): Model-specific parameters as a JSON object. For TTS the main field is usually "text" (the content to synthesize); for music models it is usually "prompt" and/or "lyrics". Use atlas_get_model_info to see available params.

Returns:
  A prediction ID to check the result with atlas_get_prediction. The output is an audio file URL.

Examples:
  - model="bytedance/seed-audio-1.0", params={"text": "Welcome to Atlas Cloud."}
  - model="bytedance/seed-audio-1.0", params={"text": "Hello there.", "format": "mp3", "sample_rate": 24000}
  - model="suno/chirp-v5", params={"prompt": "upbeat synthwave song about coding at night"}
  - model="minimax/music-2.6", params={"prompt": "gentle acoustic guitar background music"}`,
      inputSchema: {
        model: z.string().min(1).describe("Audio model ID"),
        params: z
          .record(z.unknown())
          .describe(
            "Model-specific parameters as JSON object. Use atlas_get_model_info to see available parameters for your chosen model."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, params }) => {
      try {
        const result = await submitGeneration(model, params, {
          expectedType: "Audio",
          endpoint: "/model/generateAudio",
          typeLabel: "audio",
        });

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.message }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text:
                `Audio generation submitted successfully.\n\n` +
                `- **Model**: ${result.model.displayName} (\`${result.model.model}\`)\n` +
                `- **Prediction ID**: \`${result.predictionId}\`\n\n` +
                `The audio is being generated. Use \`atlas_get_prediction\` with this ID to check the result.\n` +
                `Audio generation usually takes 10-60 seconds.`,
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

This tool submits the transcription request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later — the output is the recognized text (some models also return timestamped utterances and speaker info).

Parameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.

IMPORTANT: The "model" parameter requires an exact speech-to-text model ID (e.g., "bytedance/seed-asr-2.0", "xai/stt-v1"). Speech-to-text models are Audio-type models — use atlas_list_models with type="Audio" to find them. Do NOT guess model IDs.

The audio must be reachable via URL. For local files, first call atlas_upload_media to get a URL.

Args:
  - model (string, required): The exact speech-to-text model ID.
  - params (object, required): Model-specific parameters. The main field is usually "audio_url" (URL of the audio to transcribe). Other common params: "language", "format", "enable_punc", "enable_speaker_info". Use atlas_get_model_info to see available params.

Returns:
  A prediction ID to check the result with atlas_get_prediction. The output is the transcribed text.

Examples:
  - model="bytedance/seed-asr-2.0", params={"audio_url": "https://example.com/meeting.mp3"}
  - model="bytedance/seed-asr-2.0", params={"audio_url": "https://example.com/interview.wav", "enable_speaker_info": true}`,
      inputSchema: {
        model: z.string().min(1).describe("Speech-to-text model ID"),
        params: z
          .record(z.unknown())
          .describe(
            'Model-specific parameters as JSON object. The main field is usually "audio_url". Use atlas_get_model_info to see available parameters.'
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, params }) => {
      try {
        const result = await submitGeneration(model, params, {
          expectedType: "Audio",
          endpoint: "/model/generateAudio",
          typeLabel: "audio",
        });

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.message }],
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
                `The audio is being transcribed. Use \`atlas_get_prediction\` with this ID to get the text.\n` +
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
