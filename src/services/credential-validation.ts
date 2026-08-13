import type { fetch as undiciFetch } from "undici";
import { PUBLIC_API_BASE } from "../constants.js";
import { balanceResponseSchema } from "../response-schemas.js";
import { request } from "./api-client.js";

export type AtlasCredentialValidator = (apiKey: string) => Promise<void>;

export async function validateAtlasCredential(
  apiKey: string,
  fetcher?: typeof undiciFetch
): Promise<void> {
  if (apiKey.length < 16 || apiKey.length > 4096 || !/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new Error("Atlas credential has an invalid format");
  }
  await request(PUBLIC_API_BASE, "/balance", {
    method: "GET",
    requireAuth: false,
    headers: { Authorization: `Bearer ${apiKey}` },
    maxRetries: 0,
    responseSchema: balanceResponseSchema,
    ...(fetcher ? { fetcher } : {}),
  });
}
