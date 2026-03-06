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
        `# Keep polling until status is "completed", "succeeded" or "failed"`
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
