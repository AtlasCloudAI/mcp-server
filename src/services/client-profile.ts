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

type KnownClient = "chatgpt" | "codex" | "claude" | "claude-code";

function knownClient(clientId: string | undefined): KnownClient | null {
  if (!clientId) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (hostMatches(host, OPENAI_HOSTS)) {
    return /(^|\/)codex(\/|$)/.test(path) ? "codex" : "chatgpt";
  }
  if (hostMatches(host, ANTHROPIC_HOSTS)) {
    return path.includes("claude-code") ? "claude-code" : "claude";
  }
  return null;
}

export function clientProfile(clientId: string | undefined): ClientProfile {
  switch (knownClient(clientId)) {
    case "codex":
    case "claude-code":
      return "shell";
    case "chatgpt":
    case "claude":
      return "chat";
    default:
      return "other";
  }
}

/** The profile of the client behind the request being served, or "other". */
export function currentClientProfile(): ClientProfile {
  return clientProfile(getRequestContext()?.authInfo.clientId);
}

/**
 * Should a finished image also be attached as a base64 image block?
 *
 * Not for Codex. Codex (desktop 26.1013, CLI 0.163) calls MCP tools from a
 * JavaScript cell and the model usually prints the whole result with `text(r)`,
 * so an image block reaches it as text: about 40k tokens of base64 for one
 * 1024px preview. Measured on 2026-10-19, the model then pasted that string back
 * as `![...](data:image/webp;base64,...)` instead of saving the file. Codex shows
 * a saved local file inline, which the guidance already asks for, so the block
 * only costs context there. Every other client keeps it.
 */
export function wantsImageBlocks(clientId: string | undefined): boolean {
  return knownClient(clientId) !== "codex";
}

/** wantsImageBlocks for the client behind the request being served. */
export function currentClientWantsImageBlocks(): boolean {
  return wantsImageBlocks(getRequestContext()?.authInfo.clientId);
}
