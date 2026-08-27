import { api, fetchExternal } from "./api-client.js";
import type { Model, ModelsResponse } from "../types.js";

// In-memory cache for models list
let modelsCache: Model[] | null = null;
let modelsCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fetch and cache all models
export async function getModels(): Promise<Model[]> {
  const now = Date.now();
  if (modelsCache && now - modelsCacheTime < CACHE_TTL) {
    return modelsCache;
  }

  const response = await api<ModelsResponse>("/models", { requireAuth: false });
  const models = (response.data || []).filter((m) => m.display_console !== false);
  modelsCache = models;
  modelsCacheTime = now;
  return models;
}

// Normalize string for fuzzy matching: remove separators, collapse spaces
function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_./]/g, " ").replace(/\s+/g, " ").trim();
}

// Check if all query words appear in the target string
function fuzzyMatch(target: string, queryWords: string[]): boolean {
  const normalizedTarget = normalize(target);
  return queryWords.every((w) => normalizedTarget.includes(w));
}

/**
 * Find a model by ID or display name, exact matches first.
 *
 * The tiers matter: normalization strips `-`, `_`, `.` and `/`, which makes
 * distinct models collide ("Qwen Image Edit" vs "Qwen-Image Edit" are two
 * different models). Testing every rule in one pass would return whichever
 * happens to come first in the catalogue, so a caller naming a model exactly
 * could still be billed for a different one. Strongest match wins instead.
 */
export async function findModel(modelId: string): Promise<Model | undefined> {
  const models = await getModels();
  const lowerInput = modelId.toLowerCase();
  const normalizedInput = normalize(modelId);

  const tiers: Array<(m: Model) => boolean> = [
    (m) => m.model === modelId,
    (m) => m.model.toLowerCase() === lowerInput,
    (m) => m.displayName === modelId,
    (m) => m.displayName?.toLowerCase() === lowerInput,
    (m) => normalize(m.model) === normalizedInput,
    (m) => normalize(m.displayName || "") === normalizedInput,
  ];

  for (const matches of tiers) {
    const found = models.find(matches);
    if (found) return found;
  }
  return undefined;
}

// Fetch model OpenAPI schema
export async function getModelSchema(
  model: Model
): Promise<Record<string, unknown> | null> {
  if (!model.schema) return null;
  try {
    const schema = await fetchExternal(model.schema);
    return schema as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Fetch model README
export async function getModelReadme(model: Model): Promise<string | null> {
  if (!model.readme) return null;
  try {
    const content = await fetchExternal(model.readme);
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

// Search models by keyword with fuzzy matching
export async function searchModels(query: string): Promise<Model[]> {
  const models = await getModels();
  const queryWords = normalize(query).split(" ").filter(Boolean);

  if (queryWords.length === 0) return [];

  return models.filter((m) => {
    const fields = [
      m.model,
      m.displayName,
      m.profile || "",
      m.type || "",
      m.organization || "",
      ...(m.tags || []),
      ...(m.categories || []),
    ];
    return fields.some((f) => fuzzyMatch(f, queryWords));
  });
}
