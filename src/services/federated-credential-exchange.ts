import { z } from "zod";

const MAX_JSON_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Atlas Cloud wraps successful responses as `{ code: "200", data: {...} }`.
 * Only the fields this client actually needs are described; anything else the
 * backend adds is ignored rather than treated as a contract break.
 */
const exchangeResponseSchema = z
  .object({
    data: z
      .object({
        apiKey: z.string().min(1).max(4096),
      })
      .passthrough(),
  })
  .passthrough();

export interface FederatedCredentialExchangeRequest {
  issuer: string;
  subject: string;
}

export interface FederatedCredentialExchange {
  /**
   * Resolves the Atlas API key belonging to an already verified upstream
   * identity, or undefined when no Atlas account matches it.
   *
   * Throws on transport, authentication, or contract failures so a
   * misconfigured exchange surfaces instead of silently degrading every login
   * to manual key entry forever.
   */
  exchange(request: FederatedCredentialExchangeRequest): Promise<string | undefined>;
}

export interface FederatedCredentialExchangeConfig {
  url: URL;
  token: string;
}

export function createFederatedCredentialExchange(
  config: FederatedCredentialExchangeConfig,
  fetcher: typeof fetch = fetch
): FederatedCredentialExchange {
  return {
    async exchange(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetcher(config.url, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            // Dedicated shared secret; deliberately not the service token that
            // can impersonate any account.
            "x-federated-auth": config.token,
          },
          body: JSON.stringify({ issuer: request.issuer, subject: request.subject }),
        });
        // 404 is the one expected negative outcome: the identity is valid but no
        // Atlas account owns it. The caller falls back to manual key entry.
        if (response.status === 404) return undefined;
        if (!response.ok) {
          throw new Error(`Credential exchange returned HTTP ${response.status}`);
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MAX_JSON_BYTES) {
          throw new Error("Credential exchange response is too large");
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          throw new Error("Credential exchange did not return JSON");
        }
        const parsed = exchangeResponseSchema.parse(
          JSON.parse(new TextDecoder().decode(bytes)) as unknown
        );
        return parsed.data.apiKey;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
