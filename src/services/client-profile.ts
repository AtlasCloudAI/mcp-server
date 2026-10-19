import { getRequestContext } from "./request-context.js";

/**
 * Which kind of host is on the other end of this request.
 *
 * The answer changes how results should be presented, because hosts differ in
 * what they can do with a file:
 *
 * - "shell": a coding agent with a local shell (Codex, Claude Code). It can
 *   curl a result into the workspace and show the saved file inline.
 * - "chat": a chat surface (ChatGPT, Claude on the web). Its code sandbox may
 *   have no network at all, and every script it runs asks the user for approval,
 *   so telling it to download and re-encode media produces approval prompts and
 *   nothing the user can open.
 * - "other": anything else, including the local stdio server and DCR clients.
 *   Treated like a shell, with an explicit fallback for hosts that have none.
 *
 * These hosts identify themselves with a client metadata document URL as the
 * OAuth client_id: ChatGPT https://chatgpt.com/oauth/client.json, Codex
 * https://chatgpt.com/oauth/codex/client.json, Claude on the web
 * https://claude.ai/oauth/mcp-oauth-client-metadata, Claude Code
 * https://claude.ai/oauth/claude-code-client-metadata.
 */
export type ClientProfile = "chat" | "shell" | "other";

const OPENAI_HOSTS = ["chatgpt.com", "openai.com"];
const ANTHROPIC_HOSTS = ["claude.ai", "anthropic.com"];

function hostMatches(host: string, domains: string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export function clientProfile(clientId: string | undefined): ClientProfile {
  if (!clientId) return "other";
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return "other";
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (hostMatches(host, OPENAI_HOSTS)) {
    return /(^|\/)codex(\/|$)/.test(path) ? "shell" : "chat";
  }
  if (hostMatches(host, ANTHROPIC_HOSTS)) {
    return path.includes("claude-code") ? "shell" : "chat";
  }
  return "other";
}

/** The profile of the client behind the request being served, or "other". */
export function currentClientProfile(): ClientProfile {
  return clientProfile(getRequestContext()?.authInfo.clientId);
}
