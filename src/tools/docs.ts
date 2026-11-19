import { quoteAtDefaults } from "../services/spend-policy.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchModels, getModelSchema } from "../services/doc-fetcher.js";
import { searchDocs, type DocHit } from "../services/doc-search.js";
import { formatModelList, formatModelInfo, truncate } from "../utils/formatter.js";
import { generateLLMPrompt } from "../utils/prompt-gen.js";
import { handleError } from "../utils/error-handler.js";
import {
  modelPageLimitSchema,
  modelPageOffsetSchema,
  docsSearchOutputSchema,
  toModelSummary,
} from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";

export function registerDocsTools(server: McpServer): void {
  server.registerTool(
    "atlas_search_docs",
    {
      title: "Search Atlas Cloud Docs",
      description: `Search the Atlas Cloud help documentation: accounts and teams, API keys, billing, top-ups, refunds and failed tasks, uploading files, webhooks, errors and rate limits, data retention, the MCP server, CLI, Skills and other integrations.

Use it when the user asks how Atlas Cloud works or how to do something on it. It is not needed before a generation: to find or price a model, use atlas_list_models and atlas_get_model_info instead.

The documentation is in English, so search with English keywords (translate the user's question if needed), e.g. "upload file", "refund failed task", "webhook", "rate limit".

Returns up to 5 documentation pages (title, link, summary and the most relevant passage). Answer from those passages and give the user the link. If the query also names models, matching models are listed after the pages.

Args:
  - query (string): English keywords for the question
  - limit (integer, optional): Models per page in the model list, 1-100 (default 50)
  - offset (integer, optional): Zero-based offset into the model list (default 0)`,
      inputSchema: {
        query: z
          .string()
          .min(1, "Query must not be empty")
          .max(200)
          .describe("English keywords for the documentation question; model names also match models"),
        limit: modelPageLimitSchema,
        offset: modelPageOffsetSchema,
      },
      outputSchema: docsSearchOutputSchema,
      annotations: toolAnnotations("atlas_search_docs"),
    },
    async ({ query, limit, offset }) => {
      // 文档和模型目录一起查：问「怎么上传文件」的只会命中文档，问「deepseek」的只会命中模型。
      // 一边失败不拖垮另一边；两边都失败才算出错。
      const [docsResult, modelsResult] = await Promise.allSettled([searchDocs(query), searchModels(query)]);
      if (docsResult.status === "rejected" && modelsResult.status === "rejected") {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(modelsResult.reason) }],
        };
      }
      const docs = docsResult.status === "fulfilled" ? docsResult.value : [];
      const models = modelsResult.status === "fulfilled" ? modelsResult.value : [];
      const docsError =
        docsResult.status === "rejected"
          ? "The documentation index could not be loaded right now; only models were searched."
          : undefined;
      const docEntries = docs.map(({ title, url, description, snippet }) => ({ title, url, description, snippet }));
      const base = { query, docs: docEntries, ...(docsError ? { docs_error: docsError } : {}) };

      try {
        if (docs.length === 0 && models.length === 0) {
          return {
            structuredContent: { ...base, count: 0, total_count: 0, offset, has_more: false, models: [] },
            content: [
              {
                type: "text",
                text:
                  `No documentation pages or models matched "${query}". ` +
                  (docsError ? `${docsError} ` : "") +
                  `The documentation is in English: try short English keywords such as "upload file", "refund", "webhook", "API key", or a model or provider name.`,
              },
            ],
          };
        }

        // 只命中一个模型、没有文档时，照旧给这个模型的完整说明。
        if (docs.length === 0 && models.length === 1 && offset === 0) {
          const model = models[0];
          // Schema first: the default-parameter quote needs its defaults
          const schema = await getModelSchema(model);
          let detail = formatModelInfo(model, await quoteAtDefaults(model, schema));

          if (schema) {
            detail +=
              "\n\n---\n\n" +
              generateLLMPrompt(schema, model.model, model.profile, model.type);
          }

          return {
            structuredContent: { ...base, count: 1, total_count: 1, offset: 0, has_more: false, models: [toModelSummary(model)] },
            content: [{ type: "text", text: truncate(detail) }],
          };
        }

        const page = models.slice(offset, offset + limit);
        const hasMore = offset + page.length < models.length;
        const sections: string[] = [];
        if (docs.length > 0) sections.push(formatDocHits(docs));
        else if (docsError) sections.push(docsError);
        if (page.length > 0) sections.push(`## Matching models\n\n${formatModelList(page)}`);
        else if (models.length > 0) sections.push(`No more models at offset ${offset}; the query matched ${models.length} models in total.`);
        return {
          structuredContent: { ...base, count: page.length, total_count: models.length, offset, has_more: hasMore, models: page.map(toModelSummary) },
          content: [{ type: "text", text: truncate(sections.join("\n\n")) }],
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

function formatDocHits(hits: DocHit[]): string {
  const lines = ["## Atlas Cloud documentation", ""];
  hits.forEach((hit, index) => {
    lines.push(`${index + 1}. **${hit.title}** — ${hit.url}`);
    if (hit.description) lines.push(`   ${hit.description}`);
    if (hit.snippet && hit.snippet !== hit.description) lines.push(`   > ${hit.snippet}`);
  });
  lines.push("", "Answer from these passages and give the user the page link. Open the link for the full page.");
  return lines.join("\n");
}
