import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchModels, findModel, getModelSchema } from "../services/doc-fetcher.js";
import { chatApi } from "../services/api-client.js";
import { handleError } from "../utils/error-handler.js";
import { POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS } from "../constants.js";
import type { Model, PredictionResponse } from "../types.js";

// Poll for prediction result
async function pollPrediction(predictionId: string): Promise<PredictionResponse> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const result = await chatApi<PredictionResponse>(
      `/model/prediction/${predictionId}`
    );
    const status = result.data?.status;
    if (status === "completed" || status === "succeeded" || status === "failed") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    "Generation timed out. Use atlas_get_prediction to check status later."
  );
}

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
      description: `One-step image or video generation - automatically finds the model, fetches its schema, builds parameters, and generates.

Just provide a model keyword and a prompt. The tool handles everything:
1. Searches for the matching model by keyword
2. Fetches the model's parameter schema
3. Builds the request with smart defaults
4. Submits the generation and waits for result

Args:
  - model_keyword (string, required): A keyword or partial name to find the model (e.g., "nano banana", "seedream", "kling v3", "vidu")
  - type (string, required): Generation type: "Image" or "Video"
  - prompt (string, required): Text description of what to generate
  - image_url (string, optional): Source image URL for image-to-video or image editing models
  - extra_params (object, optional): Additional model-specific parameters to override defaults (e.g., {"duration": 10, "aspect_ratio": "16:9"})
  - wait_for_result (boolean, optional): Whether to wait for the result. Default: true

Returns:
  The generation result with output URL(s), or a list of candidate models if the keyword matches multiple models.

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
        wait_for_result: z
          .boolean()
          .default(true)
          .describe("Whether to wait for the result. Default: true"),
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
      wait_for_result,
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
        const schema = await (async () => {
          if (!foundModel.schema) return null;
          try {
            const { fetchExternal } = await import("../services/api-client.js");
            return (await fetchExternal(foundModel.schema)) as Record<string, unknown>;
          } catch {
            return null;
          }
        })();

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
          // Fallback: basic params without schema
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

        // Build info header
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

        if (!wait_for_result) {
          lines.push(`# ${type} Generation Started\n`);
          lines.push(
            `- **Model**: ${foundModel.displayName} (\`${foundModel.model}\`)`
          );
          lines.push(`- **Prediction ID**: \`${predictionId}\``);
          lines.push(
            `\nUse \`atlas_get_prediction\` with this ID to check the result.`
          );
          return {
            content: [{ type: "text", text: lines.join("\n") }],
          };
        }

        // Step 5: Poll for result
        const result = await pollPrediction(predictionId);
        const status = result.data?.status;

        if (status === "failed") {
          lines.push(`# ${type} Generation Failed\n`);
          lines.push(
            `- **Model**: ${foundModel.displayName} (\`${foundModel.model}\`)`
          );
          lines.push(`- **Error**: ${result.data?.error || "Unknown error"}`);
          lines.push(
            `\nTry adjusting your prompt or parameters. Use \`atlas_get_model_info\` with model="${foundModel.model}" to see all available parameters.`
          );
          return {
            isError: true,
            content: [{ type: "text", text: lines.join("\n") }],
          };
        }

        const outputs = result.data?.outputs || result.data?.output;
        const outputUrls = Array.isArray(outputs)
          ? outputs
          : outputs
            ? [outputs]
            : [];

        lines.push(`# ${type} Generation Complete\n`);
        lines.push(
          `- **Model**: ${foundModel.displayName} (\`${foundModel.model}\`)`
        );
        lines.push(`- **Prediction ID**: \`${predictionId}\``);
        lines.push(`- **Status**: ${status}\n`);

        if (outputUrls.length > 0) {
          lines.push("## Output\n");
          outputUrls.forEach((url, i) => {
            lines.push(`${i + 1}. ${url}`);
          });
        }

        if (result.data?.metrics) {
          lines.push(`\n## Metrics\n`);
          lines.push("```json");
          lines.push(JSON.stringify(result.data.metrics, null, 2));
          lines.push("```");
        }

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
