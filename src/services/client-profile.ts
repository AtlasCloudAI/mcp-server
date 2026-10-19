import { getRequestContext } from "./request-context.js";

/**
 * Which kind of host is on the other end of this request.
 *
 * The answer changes how results should be presented, because the hosts differ
 * in what they can do with a file:
 *
 * - "codex": a coding agent with a local shell (Codex desktop or CLI). It can
 *   curl a result into the workspace and show the saved file inline.
 * - "chatgpt": a chat surface. Its code sandbox may have no network at all, and
 *   every script it runs asks the user for approval, so telling it to download
 *   and re-encode media produces approval prompts and nothing the user can open.
 * - "other": anything else, including the local stdio server. Treated like a
 *   host with a shell, which is what the instructions assumed before.
 *
 * OpenAI's hosts identify themselves with a client metadata document URL as the
 * OAuth client_id: ChatGPT uses https://chatgpt.com/oauth/client.json and Codex
 * uses https://chatgpt.com/oauth/codex/client.json.
 */
export type ClientProfile = "chatgpt" | "codex" | "other";

const OPENAI_HOSTS = ["chatgpt.com", "openai.com"];

export function clientProfile(clientId: string | undefined): ClientProfile {
  if (!clientId) return "other";
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return "other";
  }
  const host = url.hostname.toLowerCase();
  const isOpenAI = OPENAI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (!isOpenAI) return "other";
  return /(^|\/)codex(\/|$)/.test(url.pathname) ? "codex" : "chatgpt";
}

/** The profile of the client behind the request being served, or "other". */
export function currentClientProfile(): ClientProfile {
  return clientProfile(getRequestContext()?.authInfo.clientId);
}
