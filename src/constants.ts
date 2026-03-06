// Atlas Cloud API base URLs
export const CONSOLE_API_BASE = "https://console.atlascloud.ai/api/v1";
export const CHAT_API_BASE = "https://api.atlascloud.ai/api/v1";
export const LLM_API_BASE = "https://api.atlascloud.ai/v1";

// Billing page URL
export const BILLING_URL = "https://www.atlascloud.ai/console/billing";

// Response character limit
export const CHARACTER_LIMIT = 25000;

// Polling configuration
export const POLL_INTERVAL_MS = 2000;
export const POLL_MAX_ATTEMPTS = 150; // Max poll attempts (~5 minutes)

// Request timeout
export const REQUEST_TIMEOUT_MS = 30000;

// Retry configuration
export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1000; // Exponential backoff: 1s, 2s, 4s
