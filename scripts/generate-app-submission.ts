// Generates docs/chatgpt-app-submission.json for the OpenAI App Store review portal.
// Tool annotations and justifications derive from src/tool-policy.ts (remote profile only),
// so re-run this after any policy change:  npx tsx scripts/generate-app-submission.ts docs/chatgpt-app-submission.json
import { writeFileSync, readFileSync } from "node:fs";
import { TOOL_POLICIES, REMOTE_TOOL_NAMES } from "../src/tool-policy.js";
import { SERVER_VERSION } from "../src/version.js";

const OUT = process.argv[2];
const SCHEMA_URL = "https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json";

// 三条 justification 从策略事实源派生：不手写，避免和代码漂
function justify(name: string) {
  const p = TOOL_POLICIES[name as keyof typeof TOOL_POLICIES];
  const a = p.annotations;
  const base = p.annotationJustification;
  return {
    read_only_justification: a.readOnlyHint
      ? `${base} It performs no writes to the user's Atlas account, tasks, or assets.`
      : `${base} It is not read-only: it submits a billable job to the user's Atlas account and stores its output there.`,
    open_world_justification: a.openWorldHint
      ? `Calls the Atlas Cloud generation API, which dispatches to third-party model providers and stores output on external object storage; results are not bounded to a closed dataset.`
      : `Bounded to the Atlas Cloud catalog and the authenticated account; it does not reach any system outside Atlas Cloud.`,
    destructive_justification: a.destructiveHint
      ? `Spends the user's own Atlas balance, which cannot be un-spent. Every request is priced against the live catalog before anything is submitted. A quote under the auto-submit limit (USD 1 in production, MCP_AUTOSUBMIT_MAX_USD) is submitted directly and the result reports the amount actually charged; a quote at or above the limit, or one the platform will not price firmly, returns the quote plus an opaque confirmation token and spends nothing until the user explicitly confirms in a later turn. In practice images and short low-resolution clips run straight away, and every full-resolution video stops for confirmation. A stable idempotency key deduplicates retries so a network retry cannot bill twice.`
      : `Alters no state; repeated calls return the same information at no charge.`,
  };
}

const tools: Record<string, unknown> = {};
for (const name of REMOTE_TOOL_NAMES) {
  const p = TOOL_POLICIES[name];
  tools[name] = {
    annotations: {
      readOnlyHint: p.annotations.readOnlyHint,
      openWorldHint: p.annotations.openWorldHint,
      destructiveHint: p.annotations.destructiveHint,
      idempotentHint: p.annotations.idempotentHint,
    },
    justifications: justify(name),
    billable: p.billable,
    required_scope: p.scope,
  };
}

const subtitle = "Image, video & audio in chat";
if (subtitle.length > 30) throw new Error(`subtitle ${subtitle.length} > 30`);

const doc = {
  $schema: SCHEMA_URL,
  schema_version: 1,
  app_info: {
    display_name: "Atlas Cloud",
    subtitle,
    description:
      "Browse the live Atlas Cloud model catalog and run image, video, audio and transcription jobs straight from chat. " +
      "You sign in once in the browser with your Atlas account, so there is no API key to copy or paste and generation is billed to your own balance. " +
      "Small jobs run straight away; an expensive job returns a quote and waits for your explicit confirmation before anything is charged. " +
      "Also bundles the Atlas Cloud API integration guide and prompt-craft skills for building Atlas into your own project.",
    category: "PRODUCTIVITY",
    developer_name: "Atlas Cloud",
    website_url: "https://www.atlascloud.ai/",
    privacy_policy_url: "https://www.atlascloud.ai/privacy",
    logo_url: "https://raw.githubusercontent.com/AtlasCloudAI/atlas-cloud-plugin/v0.6.0/plugins/atlas-cloud/assets/app-icon.svg",
  },
  remote_mcp: {
    mcp_server_url: "https://mcp.atlascloud.ai/mcp",
    resource_metadata_url: "https://mcp.atlascloud.ai/.well-known/oauth-protected-resource",
    authorization_server: "https://auth.atlascloud.ai",
    client_registration: "CIMD",
    pkce_method: "S256",
    token_exchange_grant: "urn:ietf:params:oauth:grant-type:token-exchange",
    scopes_advertised: ["tasks:read"],
    auto_submit_limit_usd: 1,
  },
  tools,
  test_cases: [
    { description: "Connection and authorization smoke test. A read-only catalog call confirms the OAuth sign-in completed and the MCP session is live. No charge.",
      user_prompt: "List the image generation models available on Atlas Cloud",
      tools_triggered: "atlas_list_models",
      expected_output: "A list of image models with model IDs and capability labels. $0 charged." },
    { description: "Model detail lookup. Returns the full input schema, enums, defaults and pricing for one model. No charge.",
      user_prompt: "Show me the parameters and pricing for bytedance/seedream-v5.0-lite",
      tools_triggered: "atlas_get_model_info",
      expected_output: "Input schema with enum values and defaults, plus per-generation pricing. $0 charged." },
    { description: "Low-cost generation under the spend limit submits directly without a confirmation round-trip, reports the actual charge, and saves the image locally so it renders inline.",
      user_prompt: "Use seedream to generate a 512x512 image of an orange cat sitting on a windowsill",
      tools_triggered: "atlas_generate_image",
      expected_output: "No confirmation prompt, because the quote of USD 0.0315 is under the USD 1 auto-submit limit. The image is shown in the conversation and the actual charge is stated." },
    { description: "Billing attribution. The balance returned belongs to the signed-in user's own Atlas account, demonstrating per-user billing rather than a shared service account. No charge.",
      user_prompt: "Check my Atlas account balance",
      tools_triggered: "atlas_get_balance",
      expected_output: "The authenticated user's own balance. $0 charged." },
    { description: "Asynchronous result retrieval using the prediction ID from the previous generation. No charge.",
      user_prompt: "Use atlas_get_prediction to check the result of the task you just submitted",
      tools_triggered: "atlas_get_prediction",
      expected_output: "status: completed with the output URL. $0 charged." },
  ],
  negative_test_cases: [
    { description: "Unknown model ID is rejected before submission. The ID is validated against the live catalog; nothing is submitted and nothing is charged.",
      user_prompt: "Generate an image with openai/this-model-does-not-exist",
      tools_triggered: "atlas_generate_image",
      expected_output: "A clear 'model not found' error. No prediction ID, $0 charged." },
    { description: "Missing required parameter fails schema validation before submission; the error names the missing field. Nothing is charged.",
      user_prompt: "Generate an image with seedream but do not give it any prompt",
      tools_triggered: "atlas_generate_image",
      expected_output: "Validation error naming the missing required field. No prediction ID, $0 charged." },
    { description: "Generation at or above the auto-submit limit (USD 1 in production) stops at a quote. The server returns the price and a confirmation token and charges nothing; only an explicit user confirmation in a later turn may submit. The model cannot bypass this, and words like continue or retry are not treated as consent.",
      user_prompt: "Generate a 10-second 1080p video with seedance",
      tools_triggered: "atlas_generate_video",
      expected_output: "A quote of roughly USD 5.94 (above the USD 1 limit) plus a confirmation_token, and no prediction ID. $0 is charged unless the reviewer explicitly confirms in a following message." },
  ],
  source_snapshot: {
    repository: "https://github.com/AtlasCloudAI/mcp-server",
    branch: "combo/oauth-exchange-20260907",
    server_version: SERVER_VERSION,
    remote_tool_count: REMOTE_TOOL_NAMES.length,
    note: "Tool count is the remote (production) profile. The stdio profile additionally registers atlas_chat and atlas_upload_media, which are not exposed at the production URL; main branch is 1.7.0 and describes a different service.",
    plugin_repository: "https://github.com/AtlasCloudAI/atlas-cloud-plugin",
    plugin_version: "0.6.0",
    skills: ["media-generation", "seedance-skill", "universal-video-prompt-skill"],
  },
};
writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
console.log(`  ✓ 写出 ${OUT}`);
console.log(`  工具 ${REMOTE_TOOL_NAMES.length} 个 · 版本 ${SERVER_VERSION} · subtitle ${subtitle.length} 字符`);
