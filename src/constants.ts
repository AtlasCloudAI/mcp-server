// Atlas Cloud API origin. Every Atlas call the plugin makes is derived from this
// single value so a non-production deployment can be pointed at a non-production
// Atlas without patching call sites.
export const DEFAULT_ATLAS_API_ORIGIN = "https://api.atlascloud.ai";

/**
 * Resolves the Atlas API origin from ATLASCLOUD_API_BASE_URL, defaulting to
 * production.
 *
 * The override exists for isolated environments: a staging plugin that still
 * called the production API would validate staging credentials against the
 * wrong account universe and could bill real accounts from a test run.
 *
 * A production release refuses any override. Silently talking to a different
 * Atlas than the one a production release is supposed to serve is the kind of
 * mistake that only surfaces as customers seeing someone else's data.
 */
export function resolveAtlasApiOrigin(
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = env.ATLASCLOUD_API_BASE_URL?.trim();
  if (!raw) return DEFAULT_ATLAS_API_ORIGIN;

  if (env.PLUGIN_RELEASE_TIER === "production" && raw !== DEFAULT_ATLAS_API_ORIGIN) {
    throw new Error(
      "ATLASCLOUD_API_BASE_URL must not override the Atlas API origin in a production release"
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("ATLASCLOUD_API_BASE_URL is not a valid URL");
  }
  // Plain HTTP is acceptable only where traffic cannot traverse the public
  // network: loopback, and in-cluster Service DNS. Cluster-internal calls have
  // no public exposure, and demanding TLS there pushes people toward the worse
  // fix of publishing internal services behind a public ingress.
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(hostname);
  const isClusterLocal = hostname.endsWith(".svc.cluster.local");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (isLoopback || isClusterLocal))) {
    throw new Error(
      "ATLASCLOUD_API_BASE_URL must use https unless the host is loopback or in-cluster (*.svc.cluster.local)"
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("ATLASCLOUD_API_BASE_URL must not contain credentials");
  }
  // An origin only: the three API paths below are appended to it, so a path here
  // would silently produce URLs like `/api/v1/api/v1/...`.
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      "ATLASCLOUD_API_BASE_URL must be a bare origin without a path, query, or fragment"
    );
  }
  return parsed.origin;
}

export const ATLAS_API_ORIGIN = resolveAtlasApiOrigin();

export const API_BASE = `${ATLAS_API_ORIGIN}/api/v1`;
export const LLM_API_BASE = `${ATLAS_API_ORIGIN}/v1`;
// Public billing/usage endpoints (balance, usage, costs) use a separate base path
export const PUBLIC_API_BASE = `${ATLAS_API_ORIGIN}/public/v1`;

// Upload timeout (60s for larger files)
export const UPLOAD_TIMEOUT_MS = 60000;

// Billing page URL
export const BILLING_URL = "https://www.atlascloud.ai/console/billing";

// Response character limit
export const CHARACTER_LIMIT = 25000;

// Polling configuration
export const POLL_INTERVAL_MS = 3000;
export const POLL_MAX_ATTEMPTS = 200; // Max poll attempts (~10 minutes)

// Request timeout
export const REQUEST_TIMEOUT_MS = 30000;

// Retry configuration
export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1000; // Exponential backoff: 1s, 2s, 4s
