import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchModels, getModelSchema } from "../services/doc-fetcher.js";
import { formatModelList, formatModelInfo, truncate } from "../utils/formatter.js";
import { generateLLMPrompt } from "../utils/prompt-gen.js";
import { handleError } from "../utils/error-handler.js";
import {
  modelPageLimitSchema,
  modelPageOffsetSchema,
  modelSearchOutputSchema,
  toModelSummary,
} from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";

export function registerDocsTools(server: McpServer): void {
  server.registerTool(
    "atlas_search_docs",
    {
      title: "Search Atlas Cloud Docs",
      description: `Search Atlas Cloud documentation, models, and API references by keyword in bounded pages.

Returns matching models with descriptions, pricing, and links. For detailed API docs of a specific model, use atlas_get_model_info instead.

Args:
  - query (string): Search keyword to match against model names, types, providers, tags, etc.
  - limit (integer, optional): Matches per page, 1-100 (default 50)
  - offset (integer, optional): Zero-based result offset (default 0)

Returns:
  Markdown-formatted list of matching models with key information.

Examples:
  - "video generation" -> finds all video generation models
  - "deepseek" -> finds all DeepSeek models
  - "image edit" -> finds image editing models
  - "qwen" -> finds all Qwen models`,
      inputSchema: {
        query: z
          .string()
          .min(1, "Query must not be empty")
          .max(200)
          .describe("Search keyword to match against model names, types, providers, tags"),
        limit: modelPageLimitSchema,
        offset: modelPageOffsetSchema,
      },
      outputSchema: modelSearchOutputSchema,
      annotations: toolAnnotations("atlas_search_docs"),
    },
    async ({ query, limit, offset }) => {
      try {
        const models = await searchModels(query);

        if (models.length === 0) {
          return {
            structuredContent: {
              query,
              count: 0,
              total_count: 0,
              offset,
              has_more: false,
              models: [],
            },
            content: [
              {
                type: "text",
                text: `No results found for "${query}". Try broader keywords like "image", "video", "text", or a provider name like "openai", "deepseek".`,
              },
            ],
          };
        }

        // If only one match, return detailed info
        if (models.length === 1 && offset === 0) {
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
            structuredContent: {
              query,
              count: 1,
              total_count: 1,
              offset: 0,
              has_more: false,
              models: [toModelSummary(model)],
            },
            content: [{ type: "text", text: truncate(detail) }],
          };
        }

        const page = models.slice(offset, offset + limit);
        const hasMore = offset + page.length < models.length;
        return {
          structuredContent: {
            query,
            count: page.length,
            total_count: models.length,
            offset,
            has_more: hasMore,
            models: page.map(toModelSummary),
          },
          content: [{
            type: "text",
            text: page.length > 0
              ? formatModelList(page)
              : `No matches found at offset ${offset}. The query has ${models.length} total matches.`,
          }],
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
