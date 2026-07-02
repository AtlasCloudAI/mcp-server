/**
 * Parameter validator driven by a model's OpenAPI schema.
 *
 * Goal: before a request reaches a *billable* generation endpoint, validate the
 * parameters supplied by the caller (the client AI) against the model's real
 * schema. This catches bad/missing/invalid-enum/out-of-range/unknown fields and
 * returns a precise error plus the list of allowed parameters, so the AI can
 * self-correct in one shot — preventing failures and wasted credits.
 */

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
  items?: SchemaProperty;
}

interface InputSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  "x-order-properties"?: string[];
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
): InputSchema | null {
  if (!schema) return null;
  const s = schema as Record<string, any>;
  const input = s.components?.schemas?.Input;
  if (!input || typeof input !== "object" || !input.properties) return null;
  return input as InputSchema;
}

// Keep only the first sentence of a description to keep error messages short
function firstSentence(desc?: string): string {
  if (!desc) return "";
  const trimmed = desc.trim();
  const idx = trimmed.search(/[.]\s/);
  return idx > 0 ? trimmed.slice(0, idx + 1) : trimmed;
}

// Whether a JS value matches the JSON Schema declared type
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    default:
      // Unknown declared type: do not block
      return true;
  }
}

// Describe the actual type of a JS value, for error messages
function jsType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
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
  const input = extractInputSchema(schema);
  if (!input) return { ...params };

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
  const input = extractInputSchema(schema);
  if (!input) {
    // No schema to validate against: allow
    return { ok: true, errors: [], summary: "" };
  }

  const properties = input.properties || {};
  const required = input.required || [];
  const errors: string[] = [];

  // 1) Missing required fields (model is injected by the server, skip it).
  //    Callers should run fillRequiredDefaults first so required-but-defaulted
  //    fields are already populated; here we only flag ones with no value.
  for (const key of required) {
    if (key === "model") continue;
    const v = params[key];
    if (v === undefined || v === null) {
      const desc = firstSentence(properties[key]?.description);
      errors.push(
        `Missing required parameter \`${key}\`${desc ? ` — ${desc}` : ""}`
      );
    }
  }

  // 2) Validate each parameter supplied by the caller
  for (const [key, value] of Object.entries(params)) {
    if (key === "model") continue;
    if (value === undefined) continue;

    const prop = properties[key];

    // Unknown parameter: not accepted by the schema — block it. This is the
    // most common way the client AI "makes things up".
    if (!prop) {
      errors.push(
        `Unknown parameter \`${key}\` is not accepted by this model — remove it.`
      );
      continue;
    }

    // null is treated as "unset" for optional fields; skip further checks
    if (value === null) continue;

    // Type check
    if (prop.type && !matchesType(value, prop.type)) {
      errors.push(
        `Parameter \`${key}\` must be of type ${prop.type}, but got ${jsType(value)}.`
      );
      continue;
    }

    // Enum check
    if (Array.isArray(prop.enum) && !prop.enum.includes(value as never)) {
      errors.push(
        `Parameter \`${key}\` must be one of: ${prop.enum
          .map((v) => JSON.stringify(v))
          .join(" | ")} — got ${JSON.stringify(value)}.`
      );
    }

    // Numeric range check
    if (typeof value === "number") {
      if (prop.minimum !== undefined && value < prop.minimum) {
        errors.push(
          `Parameter \`${key}\` must be >= ${prop.minimum} (got ${value}).`
        );
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        errors.push(
          `Parameter \`${key}\` must be <= ${prop.maximum} (got ${value}).`
        );
      }
    }

    // String length check
    if (typeof value === "string") {
      if (prop.maxLength !== undefined && value.length > prop.maxLength) {
        errors.push(
          `Parameter \`${key}\` exceeds maxLength ${prop.maxLength} (got ${value.length} chars).`
        );
      }
      if (prop.minLength !== undefined && value.length < prop.minLength) {
        errors.push(
          `Parameter \`${key}\` is shorter than minLength ${prop.minLength} (got ${value.length} chars).`
        );
      }
    }
  }

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
