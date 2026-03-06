import { consoleApi, fetchExternal } from "./api-client.js";
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

  const response = await consoleApi<ModelsResponse>("/models");
  const models = (response.data || []).filter((m) => m.display_console !== false);
  modelsCache = models;
  modelsCacheTime = now;
  return models;
}

// Find a model by model ID (e.g., "openai/gpt-5.2")
export async function findModel(modelId: string): Promise<Model | undefined> {
  const models = await getModels();
  return models.find(
    (m) =>
      m.model === modelId ||
      m.model.toLowerCase() === modelId.toLowerCase() ||
      m.displayName.toLowerCase() === modelId.toLowerCase()
  );
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

// Search models by keyword
export async function searchModels(query: string): Promise<Model[]> {
  const models = await getModels();
  const q = query.toLowerCase();
  return models.filter(
    (m) =>
      m.model.toLowerCase().includes(q) ||
      m.displayName.toLowerCase().includes(q) ||
      m.profile?.toLowerCase().includes(q) ||
      m.type?.toLowerCase().includes(q) ||
      m.organization?.toLowerCase().includes(q) ||
      m.tags?.some((t) => t.toLowerCase().includes(q)) ||
      m.categories?.some((c) => c.toLowerCase().includes(q))
  );
}
