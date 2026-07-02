import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { submitGeneration } from "../services/generation.js";
import { handleError } from "../utils/error-handler.js";

export function registerAudioTools(server: McpServer): void {
  server.registerTool(
    "atlas_generate_audio",
    {
      title: "Generate Audio",
      description: `Generate audio (text-to-speech / TTS) using Atlas Cloud API.

This tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.

Parameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.

IMPORTANT: The "model" parameter requires an exact model ID (e.g., "bytedance/seed-audio-1.0"). If you don't know the exact model ID, you MUST first call atlas_list_models with type="Audio" to find it. Do NOT guess model IDs.

You should also use atlas_get_model_info to see the full parameter list and schema for your chosen audio model before calling this tool. Different TTS models accept different params (voice/speaker IDs, format, sample rate, speed, etc.).

Args:
  - model (string, required): The exact audio model ID. Use atlas_list_models with type="Audio" to find valid IDs.
  - params (object, required): Model-specific parameters as a JSON object. The main field is usually "text" (the content to synthesize). Other common params include "references" (voice/speaker references), "format", "sample_rate", "speech_rate". Use atlas_get_model_info to see available params.

Returns:
  A prediction ID to check the result with atlas_get_prediction. The output is an audio file URL.

Examples:
  - model="bytedance/seed-audio-1.0", params={"text": "Welcome to Atlas Cloud."}
  - model="bytedance/seed-audio-1.0", params={"text": "Hello there.", "format": "mp3", "sample_rate": 24000}`,
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
}
