import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchModels, findModel } from "../services/doc-fetcher.js";
import { chatApi, fetchExternal } from "../services/api-client.js";
import { handleError } from "../utils/error-handler.js";
import type { Model, PredictionResponse } from "../types.js";

// Resolve model from fuzzy keyword
async function resolveModel(
  keyword: string,
  type: "Image" | "Video"
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

  // Multiple matches - pick the first one but inform about alternatives
  return { model: filtered[0], candidates: filtered };
}

// Build request params from schema, filling in user prompt and extra params
function buildParams(
  schema: Record<string, unknown>,
  modelId: string,
  prompt: string,
  imageUrl?: string,
  extraParams?: Record<string, unknown>
): Record<string, unknown> {
  const s = schema as Record<string, any>;
  const inputSchema = s.components?.schemas?.Input;
  const properties = inputSchema?.properties || {};
  const required: string[] = inputSchema?.required || [];

  const params: Record<string, unknown> = { model: modelId };

  // Set prompt - find the prompt field
  const promptField = Object.keys(properties).find(
    (k) =>
      k === "prompt" ||
      k === "text" ||
      k === "text_prompt" ||
      properties[k]?.description?.toLowerCase().includes("prompt")
  );
  if (promptField) {
    params[promptField] = prompt;
  }

  // Set image URL if provided
  if (imageUrl) {
    const imageField = Object.keys(properties).find(
      (k) =>
        k === "image_url" ||
        k === "image" ||
        k === "input_image" ||
        k === "init_image" ||
        k === "source_image" ||
        properties[k]?.description?.toLowerCase().includes("image url") ||
        properties[k]?.description?.toLowerCase().includes("input image")
    );
    if (imageField) {
      params[imageField] = imageUrl;
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

  return params;
}

export function registerQuickGenerateTools(server: McpServer): void {
  server.registerTool(
    "atlas_quick_generate",
    {
      title: "Quick Generate Image/Video",
      description: `One-step image or video generation - automatically finds the model by keyword, fetches its schema, builds parameters, and submits the task.

IMPORTANT: If this tool fails to find a model, call atlas_list_models first to get the exact model list, then use atlas_generate_image or atlas_generate_video with the exact model ID instead.

The tool searches for models by keyword matching against model ID, display name, and tags. After getting the prediction ID, use atlas_get_prediction to check the result.

Args:
  - model_keyword (string, required): A keyword to search for the model. Use the model's display name or key words (e.g., "Nano Banana", "Seedream", "Kling", "Vidu", "Seedance")
  - type (string, required): Generation type: "Image" or "Video"
  - prompt (string, required): Text description of what to generate
  - image_url (string, optional): Source image URL for image-to-video or image editing models
  - extra_params (object, optional): Additional model-specific parameters to override defaults (e.g., {"duration": 10, "aspect_ratio": "16:9"})

Returns:
  A prediction ID to check the result with atlas_get_prediction.

Examples:
  - model_keyword="nano banana", type="Image", prompt="a cute cat in space"
  - model_keyword="seedream v5", type="Image", prompt="sunset over mountains"
  - model_keyword="kling v3", type="Video", prompt="a rocket launching", extra_params={"duration": 5}
  - model_keyword="seedance", type="Video", prompt="camera panning right", image_url="https://example.com/photo.jpg"`,
      inputSchema: {
        model_keyword: z
          .string()
          .min(1)
          .describe(
            'Keyword to find the model (e.g., "nano banana", "seedream", "kling v3")'
          ),
        type: z
          .enum(["Image", "Video"])
          .describe("Generation type: Image or Video"),
        prompt: z
          .string()
          .min(1)
          .describe("Text description of what to generate"),
        image_url: z
          .string()
          .optional()
          .describe("Source image URL for image-to-video or image editing models"),
        extra_params: z
          .record(z.unknown())
          .optional()
          .describe(
            "Additional model-specific parameters to override defaults"
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
        if (schema) {
          requestBody = buildParams(
            schema,
            foundModel.model,
            prompt,
            image_url,
            extra_params
          );
        } else {
          requestBody = {
            model: foundModel.model,
            prompt,
            ...(image_url ? { image_url } : {}),
            ...(extra_params || {}),
          };
        }

        // Step 4: Submit generation
        const endpoint =
          type === "Image" ? "/model/generateImage" : "/model/generateVideo";
        const response = await chatApi<PredictionResponse>(endpoint, {
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

        const waitTime = type === "Image" ? "10-30 seconds" : "1-5 minutes";
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
