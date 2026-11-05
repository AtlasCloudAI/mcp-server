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

type KnownClient = "chatgpt" | "codex" | "claude" | "claude-code" | "hermes";

/** Hermes Agent 的元数据文档地址，和后端 authzserver 的 knownClients 一致。 */
const HERMES_CLIENT_ID = "https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json";

function knownClient(clientId: string | undefined): KnownClient | null {
  if (!clientId) return null;
  if (clientId === HERMES_CLIENT_ID) return "hermes";
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
    case "hermes":
      return "shell";
    case "chatgpt":
    case "claude":
      return "chat";
    default:
      return "other";
  }
}

/**
 * Does this client hand chat attachments to tools as download links (what
 * atlas_import_chat_files reads)? ChatGPT does. Claude on the web, Claude Code and
 * Codex don't, so the tool only clutters their tool list (seen in Claude on
 * 2026-11-03). Unknown clients keep it: some of them may pass links the same way.
 */
export function passesChatAttachmentLinks(clientId: string | undefined): boolean {
  const client = knownClient(clientId);
  return client === null || client === "chatgpt";
}

/**
 * Can this client show the Atlas cards (MCP Apps)? Codex, Claude Code and Hermes
 * can't: they list the card-only tools (atlas_card_status,
 * atlas_card_check_submission, atlas_card_selftest) to the model as ordinary
 * tools instead of hiding them (seen with Hermes on 2026-11-04, issue 48).
 * Unknown clients keep them: WorkBuddy's engine, for one, does render cards.
 */
export function rendersCards(clientId: string | undefined): boolean {
  const client = knownClient(clientId);
  return client !== "codex" && client !== "claude-code" && client !== "hermes";
}

/** The profile of the client behind the request being served, or "other". */
export function currentClientProfile(): ClientProfile {
  const context = getRequestContext();
  const profile = clientProfile(context?.authInfo.clientId);
  // 认不出、但显示过卡片的客户端（Cursor）：结果已经在卡片里，按聊天类客户端给指引，
  // 不让模型再用 curl 下载一遍（问题 58）。
  return profile === "other" && context?.knownCardClient ? "chat" : profile;
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
