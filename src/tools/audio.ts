import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  prepareGeneration,
  submitPreparedGeneration,
} from "../services/generation.js";
import {
  formatGenerationPricing,
  issueGenerationConfirmation,
  verifyGenerationConfirmation,
} from "../services/generation-confirmation.js";
import { executeIdempotently } from "../services/idempotency.js";
import { handleError } from "../utils/error-handler.js";
import {
  generationOutputSchema,
  generationConfirmationStructuredContent,
  generationConfirmationTokenSchema,
  generationStructuredContent,
  idempotencyKeySchema,
} from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";

export function registerAudioTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_audio",
    {
      title: "Generate Audio",
      description: `Generate audio — text-to-speech (TTS) AND music generation — using Atlas Cloud API.

This covers both TTS/voice models and music/song models. The live catalog determines which models are currently available.

This tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

Billing confirmation is mandatory and happens in two calls. The first call MUST omit confirmation_token and returns a quote without spending credits. Show the exact resolved model and current pricing to the user and stop. Only after a new user message explicitly confirms may you repeat the call with the same idempotency_key, unchanged arguments, and confirmation_token.

Parameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.

IMPORTANT: The "model" parameter requires an exact current model ID. If you don't know it, first call atlas_list_models with type="Audio". Do NOT guess model IDs.

NOTE: For speech-to-text (transcription / ASR), use atlas_transcribe_audio instead.

You should also use atlas_get_model_info to see the full parameter list and schema for your chosen audio model before calling this tool. Different models accept different params (voice/speaker IDs, format, sample rate, speed, lyrics, style tags, etc.).

Args:
  - model (string, required): The exact audio model ID. Use atlas_list_models with type="Audio" to find valid IDs.
  - params (object, required): Model-specific parameters as a JSON object. For TTS the main field is usually "text" (the content to synthesize); for music models it is usually "prompt" and/or "lyrics". Use atlas_get_model_info to see available params.

Returns:
  A prediction ID to check the result with atlas_get_prediction. The output is an audio file URL.`,
      inputSchema: {
        idempotency_key: idempotencyKeySchema,
        confirmation_token: generationConfirmationTokenSchema,
        model: z.string().min(1).describe("Audio model ID"),
        params: z
          .record(z.unknown())
          .describe(
            "Model-specific parameters as JSON object. Use atlas_get_model_info to see available parameters for your chosen model."
          ),
      },
      outputSchema: generationOutputSchema,
      annotations: toolAnnotations("atlas_generate_audio"),
    },
    async ({ idempotency_key, confirmation_token, model, params }) => {
      try {
        const preparation = await prepareGeneration(model, params, {
          expectedType: "Audio",
          endpoint: "/model/generateAudio",
          typeLabel: "audio",
        });
        if (!preparation.ok) {
          return { isError: true, content: [{ type: "text", text: preparation.message }] };
        }
        const { prepared } = preparation;
        const confirmedRequest = {
          resolved_model: prepared.model.model,
          request_body: prepared.body,
        };
        if (!confirmation_token) {
          const confirmation = issueGenerationConfirmation(
            "atlas_generate_audio",
            idempotency_key,
            confirmedRequest,
            prepared.model.price
          );
          return {
            structuredContent: generationConfirmationStructuredContent(
              prepared.model,
              "audio",
              confirmation
            ),
            content: [{
              type: "text",
              text:
                `Confirmation required — no billable request was submitted and no credits were spent.\n\n` +
                `- **Model**: ${prepared.model.displayName} (\`${prepared.model.model}\`)\n` +
                `- **Current pricing**: ${formatGenerationPricing(confirmation.pricing)}\n` +
                `- **Confirmation expires**: ${confirmation.expiresAt}\n\n` +
                `Show this quote to the user and stop. After explicit confirmation in a new message, reuse the same idempotency_key and unchanged arguments with confirmation_token.`,
            }],
          };
        }
        verifyGenerationConfirmation(
          confirmation_token,
          "atlas_generate_audio",
          idempotency_key,
          confirmedRequest,
          prepared.model.price
        );
        const result = await executeIdempotently(
          "atlas_generate_audio",
          { idempotency_key, ...confirmedRequest },
          idempotency_key,
          () => submitPreparedGeneration(prepared)
        );

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.message }],
          };
        }

        return {
          structuredContent: generationStructuredContent(
            result.predictionId,
            result.model,
            "audio"
          ),
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

IMPORTANT: The "model" parameter requires an exact current speech-to-text model ID. Speech-to-text models are Audio-type models — use atlas_list_models with type="Audio" to find them. Do NOT guess model IDs.

The audio must already be reachable through an HTTPS URL. This remote OpenAI plugin does not expose a local-file upload tool. If the user only has a local file, ask them to upload it through an approved Atlas Cloud or customer-controlled HTTPS location before continuing; do not invent or call atlas_upload_media.

Billing confirmation is mandatory and happens in two calls. The first call MUST omit confirmation_token and returns a quote without spending credits. Show the exact resolved model and current pricing to the user and stop. Only after a new user message explicitly confirms may you repeat the call with the same idempotency_key, unchanged arguments, and confirmation_token.

Args:
  - model (string, required): The exact speech-to-text model ID.
  - params (object, required): Model-specific parameters. The main field is usually "audio_url" (URL of the audio to transcribe). Other common params: "language", "format", "enable_punc", "enable_speaker_info". Use atlas_get_model_info to see available params.

Returns:
  A prediction ID to check the result with atlas_get_prediction. The output is the transcribed text.`,
      inputSchema: {
        idempotency_key: idempotencyKeySchema,
        confirmation_token: generationConfirmationTokenSchema,
        model: z.string().min(1).describe("Speech-to-text model ID"),
        params: z
          .record(z.unknown())
          .describe(
            'Model-specific parameters as JSON object. The main field is usually "audio_url". Use atlas_get_model_info to see available parameters.'
          ),
      },
      outputSchema: generationOutputSchema,
      annotations: toolAnnotations("atlas_transcribe_audio"),
    },
    async ({ idempotency_key, confirmation_token, model, params }) => {
      try {
        const preparation = await prepareGeneration(model, params, {
          expectedType: "Audio",
          endpoint: "/model/generateAudio",
          typeLabel: "transcription",
        });
        if (!preparation.ok) {
          return { isError: true, content: [{ type: "text", text: preparation.message }] };
        }
        const { prepared } = preparation;
        const confirmedRequest = {
          resolved_model: prepared.model.model,
          request_body: prepared.body,
        };
        if (!confirmation_token) {
          const confirmation = issueGenerationConfirmation(
            "atlas_transcribe_audio",
            idempotency_key,
            confirmedRequest,
            prepared.model.price
          );
          return {
            structuredContent: generationConfirmationStructuredContent(
              prepared.model,
              "transcription",
              confirmation
            ),
            content: [{
              type: "text",
              text:
                `Confirmation required — no billable request was submitted and no credits were spent.\n\n` +
                `- **Model**: ${prepared.model.displayName} (\`${prepared.model.model}\`)\n` +
                `- **Current pricing**: ${formatGenerationPricing(confirmation.pricing)}\n` +
                `- **Confirmation expires**: ${confirmation.expiresAt}\n\n` +
                `Show this quote to the user and stop. After explicit confirmation in a new message, reuse the same idempotency_key and unchanged arguments with confirmation_token.`,
            }],
          };
        }
        verifyGenerationConfirmation(
          confirmation_token,
          "atlas_transcribe_audio",
          idempotency_key,
          confirmedRequest,
          prepared.model.price
        );
        const result = await executeIdempotently(
          "atlas_transcribe_audio",
          { idempotency_key, ...confirmedRequest },
          idempotency_key,
          () => submitPreparedGeneration(prepared)
        );

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.message }],
          };
        }

        return {
          structuredContent: generationStructuredContent(
            result.predictionId,
            result.model,
            "transcription"
          ),
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
