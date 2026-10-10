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
  "x-multiple"?: boolean;
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

// 多选字段：schema 里写成 { type: "string", enum: [...], "x-multiple": true }，取值是用英文逗号
// 连起来的若干个枚举值——网页表单多选就是这么提交的，上游也按条数计价（atlascloud/studio/
// a-plus-content 选 1 项 $0.1408、选 3 项 $0.3808）。x-multiple 是我们自己的扩展，Ajv 不认识；
// 原样交给 Ajv 的话，enum 会把 "hero, feature" 整串当成一个值去比，必然拒绝，于是出现
// 「描述说可以逗号多选、校验器却只认单个值」。所以这类字段不让 Ajv 管 enum，改为逐项检查。
type MultiSelectProperty = SchemaProperty & { enum: unknown[] };

function isMultiSelect(prop: SchemaProperty | undefined): prop is MultiSelectProperty {
  return (
    !!prop &&
    prop["x-multiple"] === true &&
    Array.isArray(prop.enum) &&
    (prop.type === undefined || prop.type === "string")
  );
}

function multiSelectErrors(input: InputSchema, params: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, prop] of Object.entries(input.properties ?? {})) {
    const value = params[key];
    if (!isMultiSelect(prop) || typeof value !== "string") continue;
    // 整串恰好是一个枚举值时直接放行，枚举值本身含逗号也不会被拆坏
    if (prop.enum.includes(value)) continue;
    const items = value.split(",").map((item) => item.trim());
    const bad = items.filter((item) => !prop.enum.includes(item));
    if (bad.length === 0) continue;
    const allowed = prop.enum.map((v) => JSON.stringify(v)).join(" | ");
    const got = bad.map((item) => (item ? JSON.stringify(item) : "an empty item")).join(", ");
    errors.push(
      `Parameter \`${key}\` takes one or more of: ${allowed}, joined with commas ` +
        `(e.g. ${JSON.stringify(prop.enum.slice(0, 2).join(", "))}); ${got} is not one of them.`
    );
  }
  return errors;
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
  // required 里提到、但 properties 里没定义的字段，补一个「任意值」定义。
  //
  // 有些模型的 schema 是这个形状：required 含 `model`，properties 只列了业务参数。
  // 校验时我们会把 model 注进去（见 validateModelParams），而下面又强制
  // additionalProperties: false，于是那个 schema 自己要求的字段反被判成「不被接受
  // 的额外属性」——报错会说 `model` 不被接受，而它恰恰是必填的，看起来像工具坏了。
  // openai/gpt-image-2/text-to-image 就是这样，它的生成因此完全无法发起。
  //
  // 补 {} 而不是 { type: "string" }：这里的目的只是让字段合法存在，不是替上游
  // 补全类型约束——猜错类型会把本来能过的请求拦下来。additionalProperties: false
  // 仍然拦得住真正的拼写错误，因为那些名字不在 required 里。
  // 多选字段去掉 enum 再交给 Ajv，类型等其余约束照旧；取值逐项检查见 multiSelectErrors
  const declaredProperties = Object.fromEntries(
    Object.entries(input.properties ?? {}).map(([key, prop]) => {
      if (!isMultiSelect(prop)) return [key, prop];
      const { enum: _enum, ...rest } = prop;
      return [key, rest];
    })
  ) as Record<string, unknown>;
  const requiredNames = Array.isArray(input.required) ? (input.required as string[]) : [];
  const undeclaredRequired = requiredNames.filter((name) => !(name in declaredProperties));
  const validationRoot = {
    ...input,
    properties: {
      ...declaredProperties,
      ...Object.fromEntries(undeclaredRequired.map((name) => [name, {}])),
    },
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
    if (isMultiSelect(prop)) {
      bits.push(
        `one or more of: ${prop.enum.map((v) => JSON.stringify(v)).join(" | ")} (comma-separated)`
      );
    } else if (Array.isArray(prop.enum)) {
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
 * Every Input property that declares a default, except `model`. Used to price a
 * model "as it comes": /model/calculate without them quotes a different
 * configuration (product-visuals: $0.48 bare vs $0.2593 with its own defaults).
 */
export function schemaDefaults(
  schema: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const extracted = extractInputSchema(schema);
  if (!extracted) return {};
  return Object.fromEntries(
    Object.entries(extracted.input.properties ?? {})
      .filter(([key, prop]) => key !== "model" && prop.default !== undefined)
      .map(([key, prop]) => [key, prop.default])
  );
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
  const errors = [
    ...(valid ? [] : (validate.errors ?? []).map(formatAjvError)),
    ...multiSelectErrors(input, params),
  ];

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
