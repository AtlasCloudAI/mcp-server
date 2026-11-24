/**
 * Which MCP client is running this server, from the `clientInfo` it sends in
 * `initialize`. Only shape-checked strings leave this file: a client name is a
 * product name ("claude-code", "cursor-vscode"), but some hosts put the name
 * the user gave the server there instead, so anything outside a short, plain
 * character set is dropped rather than sent.
 */

const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._@()+-]{0,63}$/;
const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

export function clientNameOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return NAME_SHAPE.test(name) ? name : undefined;
}

export function clientVersionOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const version = value.trim();
  return VERSION_SHAPE.test(version) ? version : undefined;
}

/**
 * Raw client name → one stable platform value for dashboards. The raw name is
 * sent as well, so a client this table does not know yet can be added later
 * without losing its history. Order matters: "claude-code" before "claude".
 */
const PLATFORM_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/claude[-_ ]?code/i, "claude_code"],
  [/claude/i, "claude_desktop"],
  [/cursor/i, "cursor"],
  [/codex/i, "codex"],
  [/gemini/i, "gemini_cli"],
  [/windsurf|codeium/i, "windsurf"],
  [/roo[-_ ]?code|roo[-_ ]?cline/i, "roo_code"],
  [/\bkilo/i, "kilo_code"],
  [/cline/i, "cline"],
  [/copilot|visual studio code|vscode/i, "vscode"],
  [/opencode/i, "opencode"],
  [/goose/i, "goose"],
  [/continue/i, "continue"],
  [/\bzed\b/i, "zed"],
  [/openclaw/i, "openclaw"],
  [/hermes/i, "hermes"],
  [/codebuddy|workbuddy/i, "workbuddy"],
  [/\btrae\b/i, "trae"],
  [/\bkiro\b/i, "kiro"],
  [/\bwarp\b/i, "warp"],
  [/lm ?studio/i, "lm_studio"],
  [/cherry/i, "cherry_studio"],
  [/jetbrains|intellij|junie/i, "jetbrains"],
  [/qwen/i, "qwen_code"],
  [/^amp\b/i, "amp"],
];

export function clientPlatformOf(name: string | undefined): string {
  if (!name) return "unknown";
  for (const [pattern, platform] of PLATFORM_RULES) {
    if (pattern.test(name)) return platform;
  }
  return "other";
}

/**
 * The hosted server's `client_platform` values (mcp-server
 * src/services/client-profile.ts ClientPlatform), so local and hosted events
 * can be grouped by the same column. Claude Code and Claude desktop are one
 * value there ("claude"); clients the hosted server has no value for are
 * "unknown" there too. The finer value stays in `client_platform_detail`.
 */
const HOSTED_PLATFORM: Readonly<Record<string, string>> = {
  claude_code: "claude",
  claude_desktop: "claude",
  cursor: "cursor",
  codex: "codex",
  workbuddy: "workbuddy",
  hermes: "hermes",
  openclaw: "openclaw",
};

export function hostedPlatformOf(detail: string): string {
  return HOSTED_PLATFORM[detail] ?? "unknown";
}

/**
 * Value of the X-Atlas-MCP-Client header: "<name>/<version>", or just the name.
 * Atlas records it next to the task (task_context.mcp_client) so spend can be
 * split by client the same way plugin spend is split by OAuth client.
 */
export function clientHeaderValue(name: string | undefined, version: string | undefined): string | undefined {
  if (!name) return undefined;
  return version ? `${name}/${version}` : name;
}
