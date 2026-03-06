import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchModels, findModel, getModelSchema, getModelReadme } from "../services/doc-fetcher.js";
import { formatModelList, formatModelInfo, truncate } from "../utils/formatter.js";
import { generateLLMPrompt } from "../utils/prompt-gen.js";
import { handleError } from "../utils/error-handler.js";

export function registerDocsTools(server: McpServer): void {
  server.registerTool(
    "atlas_search_docs",
    {
      title: "Search Atlas Cloud Docs",
      description: `Search Atlas Cloud documentation, models, and API references by keyword.

Returns matching models with descriptions, pricing, and links. For detailed API docs of a specific model, use atlas_get_model_info instead.

Args:
  - query (string): Search keyword to match against model names, types, providers, tags, etc.

Returns:
  Markdown-formatted list of matching models with key information.

Examples:
  - "video generation" -> finds all video generation models
  - "deepseek" -> finds all DeepSeek models
  - "image edit" -> finds image editing models
  - "gpt" -> finds all GPT models`,
      inputSchema: {
        query: z
          .string()
          .min(1, "Query must not be empty")
          .max(200)
          .describe("Search keyword to match against model names, types, providers, tags"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query }) => {
      try {
        const models = await searchModels(query);

        if (models.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No results found for "${query}". Try broader keywords like "image", "video", "text", or a provider name like "openai", "deepseek".`,
              },
            ],
          };
        }

        // If only one match, return detailed info
        if (models.length === 1) {
          const model = models[0];
          let detail = formatModelInfo(model);

          // Try to get schema doc
          const schema = await getModelSchema(model);
          if (schema) {
            detail +=
              "\n\n---\n\n" +
              generateLLMPrompt(schema, model.model, model.profile, model.type);
          }

          return {
            content: [{ type: "text", text: truncate(detail) }],
          };
        }

        return {
          content: [{ type: "text", text: formatModelList(models) }],
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
