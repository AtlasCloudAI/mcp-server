/**
 * Parameter validator driven by a model's OpenAPI schema.
 *
 * Goal: before a request reaches a *billable* generation endpoint, validate the
 * parameters supplied by the caller (the client AI) against the model's real
 * schema. This catches bad/missing/invalid-enum/out-of-range/unknown fields and
 * returns a precise error plus the list of allowed parameters, so the AI can
 * self-correct in one shot — preventing failures and wasted credits.
 */
import {
  Ajv,
  type ErrorObject,
  type ValidateFunction,
} from "ajv";
import formatsPluginModule from "ajv-formats";

// A single property in an OpenAPI Input schema (only the fields we use)
interface SchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: SchemaProperty;
}

interface InputSchema {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  "x-order-properties"?: string[];
}

interface ExtractedInputSchema {
  input: InputSchema;
  components?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  // Allowed-parameter list (Markdown), returned with errors so the AI can fix
  summary: string;
}

// Pull the Input definition out of a full OpenAPI schema
function extractInputSchema(
  schema: Record<string, unknown> | null | undefined
): ExtractedInputSchema | null {
  if (!schema) return null;
  const components = schema.components;
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    return null;
  }
  const schemas = (components as Record<string, unknown>).schemas;
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) {
    return null;
  }
  const input = (schemas as Record<string, unknown>).Input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const inputRecord = input as Record<string, unknown>;
  if (!inputRecord.properties || typeof inputRecord.properties !== "object") {
    return null;
  }
  return { input: inputRecord as InputSchema, components };
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  useDefaults: false,
});
const addFormats = formatsPluginModule as unknown as (
  target: Ajv
) => Ajv;
addFormats(ajv);
const validatorCache = new WeakMap<object, ValidateFunction>();

function validatorForSchema(
  originalSchema: Record<string, unknown>,
  input: InputSchema,
  components: unknown
): ValidateFunction {
  const cached = validatorCache.get(originalSchema);
  if (cached) return cached;
  const validationRoot = {
    ...input,
    additionalProperties: false,
    ...(components ? { components } : {}),
  };
  const validate = ajv.compile(validationRoot);
  validatorCache.set(originalSchema, validate);
  return validate;
}

function formatAjvError(error: ErrorObject): string {
  if (error.keyword === "required") {
    const missing = String(error.params.missingProperty ?? "unknown");
    return `Missing required parameter \`${missing}\`.`;
  }
  if (error.keyword === "additionalProperties") {
    const extra = String(error.params.additionalProperty ?? "unknown");
    return `Unknown parameter \`${extra}\` is not accepted by this model — remove it.`;
  }
  const path = error.instancePath
    ? error.instancePath
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part))
        .join(".")
    : "input";
  return `Parameter \`${path}\` ${error.message ?? "is invalid"}.`;
}

// Keep only the first sentence of a description to keep error messages short
function firstSentence(desc?: string): string {
  if (!desc) return "";
  const trimmed = desc.trim();
  const idx = trimmed.search(/[.]\s/);
  return idx > 0 ? trimmed.slice(0, idx + 1) : trimmed;
}

/**
 * Return a shallow copy of params with defaults filled in for any *required*
 * property that is missing and has a schema default. Mirrors the server-side
 * semantics where a required-but-defaulted field does not need to be sent.
 */
export function fillRequiredDefaults(
  schema: Record<string, unknown> | null | undefined,
  params: Record<string, unknown>
): Record<string, unknown> {
  const extracted = extractInputSchema(schema);
  if (!extracted) return { ...params };
  const { input } = extracted;

  const properties = input.properties || {};
  const required = input.required || [];
  const out: Record<string, unknown> = { ...params };

  for (const key of required) {
    if (key === "model") continue;
    if (out[key] !== undefined && out[key] !== null) continue;
    const def = properties[key]?.default;
    if (def !== undefined) out[key] = def;
  }
  return out;
}

// Build the "allowed parameters" Markdown appended to errors to guide the AI
export function summarizeInputSchema(
  input: InputSchema,
  modelId: string
): string {
  const properties = input.properties || {};
  const required = new Set(input.required || []);
  const order = input["x-order-properties"] || Object.keys(properties);

  const lines: string[] = [
    `Allowed parameters for \`${modelId}\` (only these are accepted):`,
  ];
  for (const key of order) {
    if (key === "model") continue; // model is injected by the server, callers omit it
    const prop = properties[key];
    if (!prop) continue;

    const bits: string[] = [prop.type || "string"];
    bits.push(required.has(key) ? "required" : "optional");
    if (Array.isArray(prop.enum)) {
      bits.push(
        `one of: ${prop.enum.map((v) => JSON.stringify(v)).join(" | ")}`
      );
    }
    if (prop.minimum !== undefined || prop.maximum !== undefined) {
      bits.push(`range ${prop.minimum ?? "-inf"}..${prop.maximum ?? "+inf"}`);
    }
    if (prop.minItems !== undefined || prop.maxItems !== undefined) {
      bits.push(
        `items ${prop.minItems ?? 0}..${prop.maxItems ?? "unbounded"}`
      );
    }
    if (prop.default !== undefined) {
      bits.push(`default ${JSON.stringify(prop.default)}`);
    }

    const desc = firstSentence(prop.description);
    lines.push(`- \`${key}\` (${bits.join(", ")})${desc ? `: ${desc}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Validate caller params against a model schema.
 * When the Input schema is unavailable, returns ok (cannot validate -> allow,
 * to avoid false negatives). `params` must NOT contain the `model` field
 * (each tool injects `model` separately).
 */
export function validateModelParams(
  schema: Record<string, unknown> | null | undefined,
  modelId: string,
  params: Record<string, unknown>
): ValidationResult {
  const extracted = extractInputSchema(schema);
  if (!extracted) {
    return {
      ok: false,
      errors: ["The model input schema is unavailable or malformed."],
      summary: "",
    };
  }
  const { input, components } = extracted;
  let validate: ValidateFunction;
  try {
    validate = validatorForSchema(schema!, input, components);
  } catch {
    return {
      ok: false,
      errors: ["The model input schema could not be compiled for validation."],
      summary: summarizeInputSchema(input, modelId),
    };
  }
  const valid = validate({ model: modelId, ...params });
  const errors = valid ? [] : (validate.errors ?? []).map(formatAjvError);

  return {
    ok: errors.length === 0,
    errors,
    summary: summarizeInputSchema(input, modelId),
  };
}

// Format a failed validation result into text for the calling AI
export function formatValidationError(
  modelId: string,
  result: ValidationResult
): string {
  const lines: string[] = [
    `Parameter validation failed for \`${modelId}\`. The request was NOT submitted (no credits were spent). Fix the following and retry:`,
    "",
  ];
  result.errors.forEach((e) => lines.push(`- ${e}`));
  if (result.summary) {
    lines.push("", "---", "", result.summary);
    lines.push(
      "",
      "Tip: call `atlas_get_model_info` for the full schema, defaults, and examples."
    );
  }
  return lines.join("\n");
}
