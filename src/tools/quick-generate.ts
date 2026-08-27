import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchModels, findModel } from "../services/doc-fetcher.js";
import { api, fetchExternal } from "../services/api-client.js";
import { handleError } from "../utils/error-handler.js";
import {
  validateModelParams,
  formatValidationError,
} from "../utils/schema-validator.js";
import type { Model, PredictionResponse } from "../types.js";

type GenType = "Image" | "Video" | "Audio";

// Map a generation type to its submit endpoint
const ENDPOINTS: Record<GenType, string> = {
  Image: "/model/generateImage",
  Video: "/model/generateVideo",
  Audio: "/model/generateAudio",
};

// Normalize for loose comparison: strip separators, collapse whitespace
function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_./]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Rank a fuzzy match. searchModels also matches on profile text and tags, so a
 * keyword can land on a model that merely mentions it in prose; prefer models
 * whose identity actually contains the keyword.
 */
function matchScore(model: Model, queryWords: string[]): number {
  const id = normalize(model.model);
  const name = normalize(model.displayName || "");
  if (queryWords.every((w) => id.includes(w))) return 3;
  if (queryWords.every((w) => name.includes(w))) return 2;
  if (queryWords.some((w) => id.includes(w) || name.includes(w))) return 1;
  return 0;
}

// Resolve model from fuzzy keyword
async function resolveModel(
  keyword: string,
  type: GenType
): Promise<{ model: Model; candidates?: Model[] } | { error: string }> {
  // Try exact match first
  const exact = await findModel(keyword);
  if (exact && exact.type === type) {
    return { model: exact };
  }

  // Fuzzy search
  const results = await searchModels(keyword);
  const filtered = results.filter((m) => m.type === type);

  if (filtered.length === 0) {
    return {
      error: `No ${type} model found for "${keyword}". Try atlas_list_models with type="${type}" to see available models.`,
    };
  }

  if (filtered.length === 1) {
    return { model: filtered[0] };
  }

  // Several matches: put the closest identity match first, but still report
  // the alternatives so the caller can correct a wrong pick in one step.
  const queryWords = normalize(keyword).split(" ").filter(Boolean);
  const ranked = [...filtered].sort(
    (a, b) => matchScore(b, queryWords) - matchScore(a, queryWords)
  );
  return { model: ranked[0], candidates: ranked };
}

// Media input fields, most specific first. A model exposes one of these to
// receive a picture / sound / clip; the exact name differs per model and some
// of them are arrays.
const MEDIA_FIELD_CANDIDATES = {
  image: [
    "image",
    "image_url",
    "images",
    "image_urls",
    "input_image",
    "init_image",
    "source_image",
    "first_frame_image",
    "frontal_image",
    "product_image",
    "reference_images",
    "reference_image_urls",
    "subject_image",
  ],
  audio: [
    "audio_url",
    "audio",
    "input_audio",
    "reference_audio",
    "reference_audios",
    "voice_url",
    "audio_urls",
  ],
  video: [
    "video",
    "video_url",
    "videos",
    "video_urls",
    "input_video",
    "reference_video",
    "reference_videos",
    "video_clips",
  ],
} as const;

type MediaKind = keyof typeof MEDIA_FIELD_CANDIDATES;

// Fields that carry the user's prompt, most specific first
const PROMPT_FIELDS = ["prompt", "text", "text_prompt", "user_prompt"];

/**
 * Find the field that carries this media kind and shape the value for it.
 * Required fields win over optional ones — a model that requires `images` will
 * not accept the value anywhere else.
 */
function assignMedia(
  params: Record<string, unknown>,
  properties: Record<string, any>,
  required: string[],
  kind: MediaKind,
  urls: string[]
): string | null {
  const candidates = MEDIA_FIELD_CANDIDATES[kind].filter((k) => properties[k]);
  if (candidates.length === 0) return null;

  const key =
    candidates.find((k) => required.includes(k)) ??
    candidates[0];

  const prop = properties[key];
  if (prop?.type === "array") {
    params[key] = urls;
  } else {
    // A single-value field cannot carry extra URLs; say so rather than
    // silently dropping them.
    params[key] = urls[0];
    if (urls.length > 1) {
      return `\`${key}\` accepts a single value, so only the first ${kind} URL was used.`;
    }
  }
  return null;
}

// Build request params from schema, filling in user prompt and media inputs
function buildParams(
  schema: Record<string, unknown>,
  modelId: string,
  prompt: string,
  media: Record<MediaKind, string[]>,
  extraParams?: Record<string, unknown>
): { params: Record<string, unknown>; notes: string[] } {
  const s = schema as Record<string, any>;
  const inputSchema = s.components?.schemas?.Input;
  const properties = inputSchema?.properties || {};
  const required: string[] = inputSchema?.required || [];

  const params: Record<string, unknown> = { model: modelId };
  const notes: string[] = [];

  // Find the field that carries the prompt. Exact names are checked first
  // across the whole schema: the description fallback below matches things like
  // `enable_prompt_expansion` ("...expand the prompt..."), and since JSON key
  // order is arbitrary it would otherwise win over the real `prompt` field and
  // push the user's text into a boolean flag.
  const promptField =
    PROMPT_FIELDS.find((k) => properties[k]) ??
    Object.keys(properties).find(
      (k) =>
        properties[k]?.type === "string" &&
        !properties[k]?.enum &&
        properties[k]?.description?.toLowerCase().includes("prompt")
    );
  if (promptField) {
    // A handful of models take a list of prompts (multi-shot video)
    params[promptField] =
      properties[promptField]?.type === "array" ? [prompt] : prompt;
  } else {
    // Upscalers, lipsync and transcription models take no prompt at all
    notes.push(
      "This model takes no prompt — the prompt text was ignored. It works purely from the input media and its own parameters."
    );
  }

  for (const kind of Object.keys(media) as MediaKind[]) {
    const urls = media[kind];
    if (urls.length === 0) continue;
    const before = Object.keys(params).length;
    const note = assignMedia(params, properties, required, kind, urls);
    if (note) notes.push(note);
    if (Object.keys(params).length === before) {
      notes.push(
        `This model has no ${kind} input field, so the ${kind} URL was ignored. Check \`atlas_get_model_info\` for its accepted parameters.`
      );
    }
  }

  // Fill required fields with defaults if not already set
  for (const key of required) {
    if (params[key] !== undefined) continue;
    const prop = properties[key];
    if (prop?.default !== undefined) {
      params[key] = prop.default;
    }
  }

  // Apply extra params (user overrides)
  if (extraParams) {
    Object.assign(params, extraParams);
  }

  return { params, notes };
}

export function registerQuickGenerateTools(server: McpServer): void {
  server.registerTool(
    "atlas_quick_generate",
    {
      title: "Quick Generate Image/Video/Audio",
      description: `One-step image, video, or audio generation - automatically finds the model by keyword, fetches its schema, builds parameters, and submits the task.

Covers all generation tasks: text-to-image, image editing, 3D (image/text-to-3D), text/image/video-to-video, lipsync & talking-avatar, TTS, music, lyrics and speech-to-text.

Media inputs are mapped onto whatever field the chosen model actually declares (image / images / image_url / first_frame_image / video_url / audio_url / ...), including array-typed fields. If a model has no field for what you passed, the response says so instead of failing silently.

Parameters are validated against the model's schema BEFORE submitting. If extra_params contains fields the model does not accept (or wrong values), the tool returns a precise error and does NOT spend credits.

IMPORTANT: If this tool fails to find a model, call atlas_list_models first to get the exact model list, then use atlas_generate_image / atlas_generate_video / atlas_generate_audio with the exact model ID instead. Do NOT invent extra_params - only pass parameters you know the model accepts (check atlas_get_model_info).

Args:
  - model_keyword (string, required): A keyword to search for the model. Use the model's display name or key words (e.g., "Nano Banana", "Seedream", "Kling", "Vidu", "Seedance", "Seed Audio", "Suno", "Omni Human")
  - type (string, required): Generation type: "Image", "Video", or "Audio"
  - prompt (string, required): Text description of what to generate (for TTS, the text to synthesize; for music, the song description). Some models take no prompt at all (upscalers, lipsync, transcription) — pass a short description anyway and the response will note that it was ignored.
  - image_url (string or string[], optional): Source image(s) for image editing, image-to-video, image-to-3D, reference images or talking-avatar models. Pass an array for models that take multiple references.
  - video_url (string, optional): Source video for video-to-video, video editing or video-extension models
  - audio_url (string, optional): Source audio for lipsync / talking-avatar video models (the speech the character should say) or for speech-to-text models
  - extra_params (object, optional): Additional model-specific parameters to override defaults (e.g., {"duration": 10, "aspect_ratio": "16:9"}). Only include parameters the model's schema accepts.

Returns:
  A prediction ID to check the result with atlas_get_prediction.

Examples:
  - model_keyword="nano banana", type="Image", prompt="a cute cat in space"
  - model_keyword="seedream v5", type="Image", prompt="sunset over mountains"
  - model_keyword="kling v3", type="Video", prompt="a rocket launching", extra_params={"duration": 5}
  - model_keyword="seedance", type="Video", prompt="camera panning right", image_url="https://example.com/photo.jpg"
  - model_keyword="wan video to video", type="Video", prompt="make it look like winter", video_url="https://example.com/clip.mp4"
  - model_keyword="seed audio", type="Audio", prompt="Welcome to Atlas Cloud."
  - model_keyword="suno", type="Audio", prompt="upbeat synthwave song about coding at night"
  - model_keyword="seed asr", type="Audio", prompt="transcribe this", audio_url="https://example.com/meeting.mp3"
  - model_keyword="omni human", type="Video", prompt="the person speaks to camera", image_url="https://example.com/portrait.jpg", audio_url="https://example.com/speech.mp3"`,
      inputSchema: {
        model_keyword: z
          .string()
          .min(1)
          .describe(
            'Keyword to find the model (e.g., "nano banana", "seedream", "kling v3", "seed audio")'
          ),
        type: z
          .enum(["Image", "Video", "Audio"])
          .describe("Generation type: Image, Video, or Audio"),
        prompt: z
          .string()
          .min(1)
          .describe("Text description of what to generate"),
        image_url: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            "Source image URL, or an array of URLs for models that take multiple reference images"
          ),
        video_url: z
          .string()
          .optional()
          .describe(
            "Source video URL for video-to-video, video editing or video-extension models"
          ),
        audio_url: z
          .string()
          .optional()
          .describe(
            "Source audio URL for lipsync / talking-avatar video models or speech-to-text models"
          ),
        extra_params: z
          .record(z.unknown())
          .optional()
          .describe(
            "Additional model-specific parameters to override defaults. Only include parameters the model's schema accepts."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      model_keyword,
      type,
      prompt,
      image_url,
      video_url,
      audio_url,
      extra_params,
    }) => {
      try {
        // Step 1: Resolve model
        const resolved = await resolveModel(model_keyword, type);

        if ("error" in resolved) {
          return {
            isError: true,
            content: [{ type: "text", text: resolved.error }],
          };
        }

        const { model: foundModel, candidates } = resolved;

        const media: Record<MediaKind, string[]> = {
          image: image_url
            ? Array.isArray(image_url)
              ? image_url.filter(Boolean)
              : [image_url]
            : [],
          audio: audio_url ? [audio_url] : [],
          video: video_url ? [video_url] : [],
        };

        // Step 2: Fetch schema
        let schema: Record<string, unknown> | null = null;
        if (foundModel.schema) {
          try {
            schema = (await fetchExternal(foundModel.schema)) as Record<string, unknown>;
          } catch {
            // Continue without schema
          }
        }

        // Step 3: Build params
        let requestBody: Record<string, unknown>;
        let notes: string[] = [];
        if (schema) {
          const built = buildParams(
            schema,
            foundModel.model,
            prompt,
            media,
            extra_params
          );
          requestBody = built.params;
          notes = built.notes;
        } else {
          requestBody = {
            model: foundModel.model,
            prompt,
            ...(media.image.length ? { image_url: media.image[0] } : {}),
            ...(media.audio.length ? { audio_url: media.audio[0] } : {}),
            ...(media.video.length ? { video_url: media.video[0] } : {}),
            ...(extra_params || {}),
          };
        }

        // Step 3b: Validate the built params against the schema before submitting,
        // so invented/invalid extra_params fail fast without spending credits.
        if (schema) {
          const { model: _model, ...paramsToValidate } = requestBody;
          const validation = validateModelParams(
            schema,
            foundModel.model,
            paramsToValidate
          );
          if (!validation.ok) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: formatValidationError(foundModel.model, validation),
                },
              ],
            };
          }
        }

        // Step 4: Submit generation
        const endpoint = ENDPOINTS[type];
        const response = await api<PredictionResponse>(endpoint, {
          method: "POST",
          body: requestBody,
        });

        const predictionId = response.data?.id;
        if (!predictionId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to start generation. Response: ${JSON.stringify(response)}`,
              },
            ],
          };
        }

        // Build response
        const lines: string[] = [];
        if (candidates && candidates.length > 1) {
          lines.push(
            `> Multiple models matched "${model_keyword}". Using **${foundModel.displayName}** (\`${foundModel.model}\`).`
          );
          lines.push(`> Other candidates:`);
          candidates.slice(1, 5).forEach((c) => {
            lines.push(`>   - ${c.displayName} (\`${c.model}\`)`);
          });
          lines.push("");
        }
        notes.forEach((n) => lines.push(`> ${n}`));
        if (notes.length > 0) lines.push("");

        const waitTime =
          type === "Image"
            ? "10-30 seconds"
            : type === "Audio"
              ? "10-60 seconds"
              : "1-5 minutes";
        lines.push(`${type} generation submitted successfully.\n`);
        lines.push(
          `- **Model**: ${foundModel.displayName} (\`${foundModel.model}\`)`
        );
        lines.push(`- **Prediction ID**: \`${predictionId}\`\n`);
        lines.push(
          `The ${type.toLowerCase()} is being generated. Use \`atlas_get_prediction\` with this ID to check the result.`
        );
        lines.push(`${type} generation typically takes ${waitTime}.`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
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
