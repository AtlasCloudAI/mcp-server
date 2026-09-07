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
export type AtlasOriginVariable =
  | "ATLASCLOUD_API_BASE_URL"
  | "ATLASCLOUD_GENERATION_API_BASE_URL";

export function resolveAtlasApiOrigin(
  env: NodeJS.ProcessEnv = process.env,
  variable: AtlasOriginVariable = "ATLASCLOUD_API_BASE_URL"
): string {
  const raw = env[variable]?.trim();
  if (!raw) return DEFAULT_ATLAS_API_ORIGIN;

  if (env.PLUGIN_RELEASE_TIER === "production" && raw !== DEFAULT_ATLAS_API_ORIGIN) {
    throw new Error(
      `${variable} must not override the Atlas API origin in a production release`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${variable} is not a valid URL`);
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
      `${variable} must use https unless the host is loopback or in-cluster (*.svc.cluster.local)`
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${variable} must not contain credentials`);
  }
  // An origin only: the three API paths below are appended to it, so a path here
  // would silently produce URLs like `/api/v1/api/v1/...`.
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      `${variable} must be a bare origin without a path, query, or fragment`
    );
  }
  return parsed.origin;
}

export const ATLAS_API_ORIGIN = resolveAtlasApiOrigin();

/**
 * OpenAI 兼容端点（`/v1/*`）的 origin。
 *
 * 生产是一个网关后面两个上游：`/api/v1` 与 `/public/v1` 走 backend，`/v1` 走
 * aiproxy，所以一个 origin 就够。集群内部署直连 Service 时这两个上游是两个不同
 * 地址，单 origin 表达不了——`ATLASCLOUD_API_BASE_URL` 指向 backend 时推导出的
 * `backend:9099/v1` 并不存在，`chat_completion` 会静默打到一个没有的路径上。
 *
 * 不设置就跟随主 origin，也就是生产与网关部署的现状。
 */
export const ATLAS_GENERATION_API_ORIGIN =
  process.env.ATLASCLOUD_GENERATION_API_BASE_URL?.trim()
    ? resolveAtlasApiOrigin(process.env, "ATLASCLOUD_GENERATION_API_BASE_URL")
    : ATLAS_API_ORIGIN;

export const API_BASE = `${ATLAS_API_ORIGIN}/api/v1`;
export const LLM_API_BASE = `${ATLAS_GENERATION_API_ORIGIN}/v1`;
/**
 * 生成任务的提交、轮询与报价。
 *
 * 和 API_BASE 同样是 `/api/v1` 前缀，但落在生成侧的 origin：这几条路由
 * （`/model/generateImage|generateVideo|generateAudio`、`/model/prediction/:id`、
 * `/model/calculate`）由 aiproxy 提供，而 `/api/v1/models`、`/model/uploadMedia`
 * 和 `/public/v1/*` 由 kubedl 提供。一个 host 后面按路径分工，所以单 origin
 * 表达不了——指错了会拿到 404，而 404 在我们的错误映射里长得像"参数不对"，
 * 排查会绕远路。
 */
export const GENERATION_API_BASE = `${ATLAS_GENERATION_API_ORIGIN}/api/v1`;
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
