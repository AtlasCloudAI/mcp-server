import { LLM_API_BASE } from "../constants.js";
import {
  buildChatEndpoint,
  buildChatRequestBody,
  isOpenAiCompatible,
  isProtocolImplemented,
  renderResponsePath,
  resolveDeclaredProtocol,
} from "../services/protocols.js";
import type { MediaInput, Model } from "../types.js";

/**
 * Generate LLM-friendly model documentation from OpenAPI schema.
 * Adapted from Atlas Cloud homepage generateLLMPrompt utility.
 */
export function generateLLMPrompt(
  schema: Record<string, unknown>,
  modelName?: string,
  modelDescription?: string,
  modelType?: string
): string {
  if (!schema) return "# Error\n\nSchema not available";

  const sections: string[] = [];
  const s = schema as Record<string, any>;

  const title = modelName || s.info?.title || "Model Documentation";
  sections.push(`# ${title}\n`);

  if (modelDescription) {
    sections.push(`> ${modelDescription}\n\n`);
  }

  sections.push("## Overview\n");

  const serverUrl = s.servers?.[0]?.url || "https://api.atlascloud.ai";
  const paths = s.paths || {};
  let pathKeys = Object.keys(paths);

  // Fix endpoint path based on model type
  if (modelType && pathKeys.length > 0) {
    pathKeys = pathKeys.map((path: string) => {
      if (modelType === "Image" && path.includes("generateVideo")) {
        return path.replace("generateVideo", "generateImage");
      }
      if (modelType === "Video" && path.includes("generateImage")) {
        return path.replace("generateImage", "generateVideo");
      }
      return path;
    });
  }

  if (pathKeys.length > 0) {
    const firstPath = pathKeys[0];
    const endpoint = `${serverUrl}${firstPath}`;
    sections.push(`- **Endpoint**: \`${endpoint}\``);
    if (modelName) sections.push(`- **Model ID**: \`${modelName}\``);
    sections.push("\n");
  }

  sections.push(
    "## API Information\n\nThis model can be used via HTTP API or client libraries.\nSee the input and output schema below, as well as usage examples.\n\n"
  );

  // Input Schema
  const inputSchema = s.components?.schemas?.Input;
  if (inputSchema) {
    sections.push("### Input Schema\n");
    sections.push("The API accepts the following input parameters:\n");

    const properties = inputSchema.properties || {};
    const required: string[] = inputSchema.required || [];
    const orderProperties: string[] =
      inputSchema["x-order-properties"] || Object.keys(properties);

    for (const key of orderProperties) {
      const prop = properties[key];
      if (!prop) continue;

      const isRequired = required.includes(key);
      const type = prop.type || "string";
      const description = prop.description || "";
      const defaultValue = prop.default;
      const enumValues = prop.enum;

      sections.push(
        `- **\`${key}\`** (\`${type}\`, _${isRequired ? "required" : "optional"}_):`
      );
      if (description) sections.push(`  ${description}`);
      if (defaultValue !== undefined) {
        sections.push(`  - Default: \`${JSON.stringify(defaultValue)}\``);
      }
      if (enumValues && Array.isArray(enumValues)) {
        sections.push(
          `  - Options: ${enumValues.map((v: unknown) => JSON.stringify(v)).join(", ")}`
        );
      }
      if (prop.minimum !== undefined || prop.maximum !== undefined) {
        sections.push(
          `  - Range: ${prop.minimum ?? "-inf"} .. ${prop.maximum ?? "+inf"}`
        );
      }
      // Upload constraints the backend declares per field. Without these a
      // caller cannot tell an image field from a document field by name alone.
      if (prop["x-accept"]) {
        sections.push(`  - Accepts files: ${prop["x-accept"]}`);
      }
      if (prop["x-max-size-mb"]) {
        sections.push(`  - Max file size: ${prop["x-max-size-mb"]} MB`);
      }
      sections.push("");
    }

    // Required parameters example
    sections.push("\n\n**Required Parameters Example**:\n");
    sections.push("```json");
    const requiredExample: Record<string, unknown> = {};
    if (modelName) requiredExample.model = modelName;
    for (const key of required) {
      if (key === "model") continue;
      const prop = properties[key];
      if (prop) {
        requiredExample[key] = prop.default !== undefined ? prop.default : "";
      }
    }
    sections.push(JSON.stringify(requiredExample, null, 2));
    sections.push("```\n");

    // Full example
    sections.push("\n**Full Example**:\n");
    sections.push("```json");
    const fullExample: Record<string, unknown> = {};
    if (modelName) fullExample.model = modelName;
    for (const key of orderProperties) {
      if (key === "model") continue;
      const prop = properties[key];
      if (prop) {
        fullExample[key] = prop.default !== undefined ? prop.default : "";
      }
    }
    sections.push(JSON.stringify(fullExample, null, 2));
    sections.push("```\n");
  }

  // Output Schema
  const outputSchema = s.components?.schemas?.PredictionResponse;
  if (outputSchema) {
    sections.push("\n### Output Schema\n");
    sections.push("The API returns the following output format:\n\n");

    const properties = outputSchema.properties || {};
    for (const [key, prop] of Object.entries(properties) as Array<[string, any]>) {
      const type = prop.type || "string";
      const format = prop.format ? ` (${prop.format})` : "";
      const description = prop.description || "";
      sections.push(`- **\`${key}\`** (\`${type}${format}\`, _optional_):`);
      if (description) sections.push(`  ${description}`);
      sections.push("");
    }

    sections.push("\n\n**Example Response**:\n");
    sections.push("```json");
    const exampleResponse: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(properties) as Array<[string, any]>) {
      if (prop.type === "string") exampleResponse[key] = "";
      else if (prop.type === "array") exampleResponse[key] = [];
      else if (prop.type === "object") exampleResponse[key] = {};
      else if (prop.type === "boolean") exampleResponse[key] = false;
      else if (prop.type === "integer" || prop.type === "number") exampleResponse[key] = 0;
      else exampleResponse[key] = null;
    }
    sections.push(JSON.stringify(exampleResponse, null, 2));
    sections.push("```\n");
  }

  // Usage Examples
  sections.push("\n## Usage Examples\n");

  if (pathKeys.length > 0) {
    const firstPath = pathKeys[0];
    const endpoint = `${serverUrl}${firstPath}`;
    const resultPath = pathKeys.find(
      (path: string) => path.includes("result") || path.includes("prediction")
    );

    sections.push("### cURL\n");
    sections.push("```bash");

    const fullParams: Record<string, unknown> = {};
    if (modelName) fullParams.model = modelName;

    if (inputSchema) {
      const properties = inputSchema.properties || {};
      const orderProperties: string[] =
        inputSchema["x-order-properties"] || Object.keys(properties);
      for (const key of orderProperties) {
        if (key === "model") continue;
        const prop = properties[key];
        if (prop?.default !== undefined) {
          fullParams[key] = prop.default;
        }
      }
    }

    sections.push(`# Step 1: Start generation`);
    sections.push(`curl -X POST "${endpoint}" \\`);
    sections.push(`  -H "Authorization: Bearer $ATLASCLOUD_API_KEY" \\`);
    sections.push(`  -H "Content-Type: application/json" \\`);
    sections.push(`  -d '${JSON.stringify(fullParams, null, 2)}'`);
    sections.push("");
    sections.push(
      `# Response will contain: {"code": 200, "data": {"id": "prediction_id"}}`
    );

    if (resultPath) {
      sections.push("");
      sections.push(
        `# Step 2: Poll for result (replace {prediction_id} with actual ID)`
      );
      sections.push(`curl -X GET "${serverUrl}${resultPath}" \\`);
      sections.push(`  -H "Authorization: Bearer $ATLASCLOUD_API_KEY"`);
      sections.push("");
      sections.push(
        `# Keep polling until the status is terminal: "completed"/"succeeded", or "failed"/"timeout"`
      );
      sections.push(
        `# Note: outputs[] is not always a list of URLs — speech-to-text and lyrics`
      );
      sections.push(
        `# models return the generated text itself, with structured detail in`
      );
      sections.push(
        `# stt_result / lyrics_result alongside it.`
      );
    }

    sections.push("```\n");
  }

  sections.push("## Additional Resources\n");
  if (modelName) {
    sections.push(
      `- [Model Playground](https://www.atlascloud.ai/models/${modelName})\n`
    );
  }

  return sections.join("\n");
}

/**
 * Build API documentation for a Text/LLM model.
 *
 * LLM models have no OpenAPI schema to render (the schema URL is only
 * published for the async media endpoints), and their call shape is decided by
 * `supported_protocols` rather than by a fixed path. Without this, asking for
 * details about a chat model returned metadata and nothing about how to call it.
 */
export function generateTextModelPrompt(model: Model): string {
  const protocol = resolveDeclaredProtocol(model.supported_protocols);
  const callable = isProtocolImplemented(protocol);
  const endpoint = buildChatEndpoint(protocol, LLM_API_BASE, model.model);

  const sections: string[] = ["## API Information\n"];
  sections.push(`- **Endpoint (POST)**: \`${endpoint}\``);
  sections.push(`- **Protocol**: \`${protocol}\``);
  sections.push(`- **Model ID**: \`${model.model}\``);
  if (model.input_modalities?.length) {
    sections.push(`- **Input modalities**: ${model.input_modalities.join(", ")}`);
  }
  if (!isOpenAiCompatible(protocol)) {
    sections.push(
      "- **Note**: this endpoint is not OpenAI-compatible — the OpenAI SDK will not work against it."
    );
  }
  if (!callable) {
    sections.push(
      `- **Note**: \`atlas_chat\` cannot call this protocol; use the endpoint above directly.`
    );
  }
  sections.push("");

  const media: MediaInput[] = [];
  if (model.input_modalities?.includes("image")) {
    media.push({ kind: "image", url: "https://example.com/photo.jpg" });
  }
  if (model.input_modalities?.includes("video")) {
    media.push({ kind: "video", url: "https://example.com/clip.mp4" });
  }

  const body = buildChatRequestBody(protocol, {
    model: model.model,
    turns: [
      {
        role: "user",
        text: "What is the difference between HTTP and HTTPS?",
        media,
      },
    ],
    maxTokens: model.maxCompletionTokens
      ? Math.min(model.maxCompletionTokens, 1024)
      : 1024,
    temperature: 0.7,
  });

  sections.push("### Request\n");
  sections.push("```bash");
  sections.push(`curl -X POST "${endpoint}" \\`);
  sections.push(`  -H "Authorization: Bearer $ATLASCLOUD_API_KEY" \\`);
  sections.push(`  -H "Content-Type: application/json" \\`);
  sections.push(`  -d '${JSON.stringify(body, null, 2)}'`);
  sections.push("```\n");

  sections.push("### Reading the response\n");
  sections.push(
    `The generated text is at \`response${renderResponsePath(protocol)}\`.\n`
  );

  if (model.supported_sampling_parameters?.length) {
    sections.push("### Supported sampling parameters\n");
    sections.push(model.supported_sampling_parameters.map((p) => `\`${p}\``).join(", "));
    sections.push("");
  }

  sections.push("### Via this MCP server\n");
  sections.push(
    callable
      ? `Call \`atlas_chat\` with model="${model.model}" — the protocol above is applied automatically.`
      : `Not callable through \`atlas_chat\`; use the HTTP endpoint above.`
  );
  sections.push("");

  sections.push("## Additional Resources\n");
  sections.push(
    `- [Model Playground](https://www.atlascloud.ai/models/${model.model})\n`
  );

  return sections.join("\n");
}
