import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform, arch, release } from "node:os";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { API_BASE } from "../constants.js";
import { getProxyDispatcher } from "../services/api-client.js";
import { summarizeArgs } from "./args.js";
import { clientNameOf, clientPlatformOf, clientVersionOf } from "./identity.js";
import { clientState, onAccountSeen, onAuthedSuccess } from "./state.js";
import { ToolCallRecord, runInToolCall } from "./tool-call.js";

/**
 * Usage telemetry for the local (stdio) server, sent to the same PostHog
 * project as the Atlas CLI and the hosted MCP server.
 *
 * On by default. ATLASCLOUD_TELEMETRY=0 (or ATLAS_TELEMETRY=0, the CLI's
 * switch, or DO_NOT_TRACK=1) turns it off; so does a build without a project
 * key. Events carry metadata only — see README "Telemetry" for the full list.
 * Nothing here can fail a tool call or write to stdout (stdout is the MCP
 * channel): every send is fire-and-forget and errors are swallowed.
 *
 * Events
 *   mcp_local_install        first run on this machine (install id created)
 *   mcp_local_session_start  the MCP client finished `initialize`
 *   mcp_local_tool_call      every tools/call
 *   mcp_local_session_end    the client went away (stdin closed / signal)
 */

const PRODUCT = "atlas-mcp-local";
const DEFAULT_HOST = "https://us.i.posthog.com";
const FLUSH_INTERVAL_MS = 15_000;
const FLUSH_AT = 20;
const MAX_QUEUE = 500;
const SEND_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 2_500;

const { version: SERVER_VERSION } = createRequire(import.meta.url)("../../package.json") as { version: string };

function falsy(value: string | undefined): boolean {
  return value !== undefined && ["0", "false", "off", "no", "disabled"].includes(value.trim().toLowerCase());
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Project key: runtime override first, else the one written into the package at publish time. */
function projectKey(): string | undefined {
  const override = process.env.ATLASCLOUD_TELEMETRY_KEY?.trim();
  if (override) return override;
  try {
    const { key } = createRequire(import.meta.url)("../../telemetry-key.json") as { key?: unknown };
    return typeof key === "string" && key.startsWith("phc_") ? key : undefined;
  } catch {
    return undefined;
  }
}

function telemetryEnabled(): boolean {
  if (falsy(process.env.ATLASCLOUD_TELEMETRY) || falsy(process.env.ATLAS_TELEMETRY)) return false;
  if (truthy(process.env.DO_NOT_TRACK)) return false;
  return true;
}

interface InstallInfo {
  id: string;
  persisted: boolean;
  firstRun: boolean;
  createdAt?: string;
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "atlascloud-mcp");
}

/** Anonymous per-machine ID, like the CLI's install ID. Not tied to the person or the key. */
function loadInstall(): InstallInfo {
  const file = join(configDir(), "telemetry.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { install_id?: unknown; created_at?: unknown };
    if (typeof parsed.install_id === "string" && /^[0-9a-f-]{36}$/.test(parsed.install_id)) {
      return {
        id: parsed.install_id,
        persisted: true,
        firstRun: false,
        createdAt: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
      };
    }
  } catch {
    // first run, or unreadable: make a new one below
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ install_id: id, created_at: createdAt }, null, 2) + "\n", { mode: 0o600 });
    return { id, persisted: true, firstRun: true, createdAt };
  } catch {
    return { id, persisted: false, firstRun: true, createdAt };
  }
}

/** Same hash as the CLI's account_hash, so the two can be joined without either sending the ID. */
function accountHash(accountId: string): string {
  return createHash("sha256").update(`atlas-cli-account:${accountId}`).digest("hex").slice(0, 16);
}

function installChannel(): string {
  const script = (process.argv[1] ?? "").replace(/\\/g, "/");
  if (script.includes("/_npx/")) return "npx";
  if (/\/(pnpm|\.pnpm)\//.test(script) && script.includes("dlx")) return "pnpm_dlx";
  if (script.includes("/.bun/")) return "bun";
  if (script.includes("/lib/node_modules/") || script.includes("/npm/node_modules/")) return "npm_global";
  if (script.includes("/node_modules/")) return "npm_local";
  return "source";
}

function environmentOf(): string {
  if (API_BASE.startsWith("https://api.atlascloud.ai")) return "production";
  if (API_BASE.includes("test")) return "test";
  if (API_BASE.includes("dev")) return "dev";
  return "custom";
}

function locale(): string | undefined {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().locale;
    return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Top-level capability names, and extension names under `extensions`. Names only. */
function capabilityNames(capabilities: unknown): string[] {
  if (!capabilities || typeof capabilities !== "object") return [];
  const names: string[] = [];
  for (const [key, value] of Object.entries(capabilities as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.:/-]{1,64}$/.test(key)) continue;
    if ((key === "extensions" || key === "experimental") && value && typeof value === "object") {
      for (const ext of Object.keys(value as Record<string, unknown>)) {
        if (/^[A-Za-z0-9_.:/-]{1,80}$/.test(ext)) names.push(`${key}:${ext}`);
      }
    } else {
      names.push(key);
    }
  }
  return names.sort().slice(0, 30);
}

interface QueuedEvent {
  event: string;
  distinct_id: string;
  timestamp: string;
  uuid: string;
  properties: Record<string, unknown>;
}

class Sender {
  private queue: QueuedEvent[] = [];
  private timer?: NodeJS.Timeout;
  private inflight = new Set<Promise<void>>();

  constructor(private readonly key: string, private readonly host: string) {}

  enqueue(event: QueuedEvent): void {
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(event);
    if (this.queue.length >= FLUSH_AT) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, FLUSH_INTERVAL_MS);
      this.timer.unref();
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return Promise.all(this.inflight).then(() => undefined);
    const batch = this.queue;
    this.queue = [];
    const sending = this.post(batch).finally(() => this.inflight.delete(sending));
    this.inflight.add(sending);
    return sending;
  }

  private async post(batch: QueuedEvent[]): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    timer.unref();
    try {
      const dispatcher = getProxyDispatcher();
      await fetch(`${this.host.replace(/\/+$/, "")}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this.key, batch }),
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
    } catch {
      // Telemetry never surfaces errors.
    } finally {
      clearTimeout(timer);
    }
  }
}

interface SessionCounters {
  toolCalls: number;
  toolErrors: number;
  tools: Set<string>;
  submits: number;
  dryRuns: number;
  uploads: number;
  chats: number;
  pricesByTask: Map<string, number>;
}

export class Telemetry {
  private readonly sessionId = randomUUID();
  private readonly startedAt = Date.now();
  private sessionStarted = false;
  private sessionEnded = false;
  private accountHash?: string;
  private accountLookupStarted = false;
  private accountLookup?: () => Promise<string | undefined>;
  private clientCapabilities: string[] = [];
  private callSeq = 0;
  /** Names of the tools this server registered; anything else is reported as "unknown". */
  private readonly toolNames = new Set<string>();
  /**
   * tools/call requests whose handler has not started yet. The SDK answers some
   * calls itself (arguments fail the input schema, unknown tool) without ever
   * running a handler; those are reported from the outgoing response instead.
   */
  private readonly pendingCalls = new Map<string | number, { name: string; args: unknown; startedAt: number }>();
  private readonly counters: SessionCounters = {
    toolCalls: 0,
    toolErrors: 0,
    tools: new Set(),
    submits: 0,
    dryRuns: 0,
    uploads: 0,
    chats: 0,
    pricesByTask: new Map(),
  };

  private constructor(private readonly sender: Sender, private readonly install: InstallInfo) {
    onAccountSeen((id) => {
      this.accountHash ??= accountHash(id);
    });
    onAuthedSuccess(() => this.lookupAccountOnce());
  }

  /** Returns undefined when telemetry is off; callers then skip every hook. */
  static start(): Telemetry | undefined {
    if (!telemetryEnabled()) return undefined;
    const key = projectKey();
    if (!key) return undefined;
    const host = process.env.ATLASCLOUD_TELEMETRY_HOST?.trim() || DEFAULT_HOST;
    const install = loadInstall();
    const telemetry = new Telemetry(new Sender(key, host), install);
    if (install.firstRun) {
      console.error(
        "Atlas Cloud MCP sends anonymous usage telemetry (tool names, models, timings; never prompts, files or keys). Set ATLASCLOUD_TELEMETRY=0 to turn it off."
      );
      telemetry.capture("mcp_local_install", { install_id_persisted: install.persisted });
    }
    return telemetry;
  }

  /** Background /balance read after the key first works, to learn which account it belongs to. */
  setAccountLookup(lookup: () => Promise<string | undefined>): void {
    this.accountLookup = lookup;
  }

  private lookupAccountOnce(): void {
    if (this.accountHash || this.accountLookupStarted || !this.accountLookup) return;
    this.accountLookupStarted = true;
    const lookup = this.accountLookup;
    setImmediate(() => {
      lookup()
        .then((id) => {
          if (id) this.accountHash ??= accountHash(id);
        })
        .catch(() => undefined);
    });
  }

  private baseProperties(): Record<string, unknown> {
    return {
      product: PRODUCT,
      version: SERVER_VERSION,
      environment: environmentOf(),
      transport: "stdio",
      auth_method: "api_key",
      api_key_present: Boolean(process.env.ATLASCLOUD_API_KEY),
      session_id: this.sessionId,
      install_id: this.install.id,
      os: platform(),
      os_release: release(),
      arch: arch(),
      node_version: process.versions.node,
      install_channel: installChannel(),
      ci: truthy(process.env.CI) || Boolean(process.env.GITHUB_ACTIONS),
      proxy_configured: Boolean(
        process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
      ),
      ...(locale() ? { locale: locale() } : {}),
      client_platform: clientState.platform,
      ...(clientState.name ? { client_name: clientState.name } : {}),
      ...(clientState.version ? { client_version: clientState.version } : {}),
      ...(clientState.protocolVersion ? { protocol_version: clientState.protocolVersion } : {}),
      ...(this.accountHash ? { account_hash: this.accountHash } : {}),
      $lib: "atlascloud-mcp",
      $lib_version: SERVER_VERSION,
      $geoip_disable: true,
    };
  }

  private capture(event: string, properties: Record<string, unknown>): void {
    try {
      this.sender.enqueue({
        event,
        distinct_id: this.install.id,
        timestamp: new Date().toISOString(),
        uuid: randomUUID(),
        properties: { ...this.baseProperties(), ...properties, distinct_id: this.install.id },
      });
    } catch {
      // never throw from telemetry
    }
  }

  /**
   * Watch the transport's incoming messages for `initialize`: the client's
   * name, version, protocol version and capabilities are only sent there.
   * Must be called after server.connect(), which installs onmessage.
   */
  observeTransport(transport: Transport): void {
    const original = transport.onmessage;
    if (!original) return;
    transport.onmessage = (message, extra) => {
      try {
        const record = message as { method?: unknown; params?: Record<string, unknown> };
        if (record.method === "initialize" && record.params) {
          const info = record.params.clientInfo as { name?: unknown; version?: unknown } | undefined;
          clientState.name = clientNameOf(info?.name);
          clientState.version = clientVersionOf(info?.version);
          clientState.platform = clientPlatformOf(clientState.name);
          const protocol = record.params.protocolVersion;
          clientState.protocolVersion =
            typeof protocol === "string" && /^[0-9A-Za-z.-]{1,20}$/.test(protocol) ? protocol : undefined;
          this.clientCapabilities = capabilityNames(record.params.capabilities);
        } else if (record.method === "notifications/initialized") {
          this.sessionStart();
        } else if (record.method === "tools/call") {
          const id = (message as { id?: unknown }).id;
          const name = record.params?.name;
          if ((typeof id === "string" || typeof id === "number") && typeof name === "string") {
            if (this.pendingCalls.size > 1000) this.pendingCalls.clear();
            this.pendingCalls.set(id, { name, args: record.params?.arguments, startedAt: performance.now() });
          }
        }
      } catch {
        // ignore
      }
      return original.call(transport, message, extra);
    };

    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      try {
        const id = (message as { id?: unknown }).id;
        if ((typeof id === "string" || typeof id === "number") && this.pendingCalls.has(id)) {
          const pending = this.pendingCalls.get(id)!;
          this.pendingCalls.delete(id);
          this.reportUnhandledCall(pending, message);
        }
      } catch {
        // ignore
      }
      return send(message, options);
    };
  }

  /** A tools/call the SDK answered without running the tool: bad arguments or an unknown tool name. */
  private reportUnhandledCall(pending: { name: string; args: unknown; startedAt: number }, message: unknown): void {
    const known = this.toolNames.has(pending.name);
    const record = new ToolCallRecord(known ? pending.name : "unknown");
    const response = message as { result?: { isError?: unknown; content?: unknown }; error?: { code?: unknown } };
    const rpcCode = response.error?.code;
    const text = Array.isArray(response.result?.content)
      ? String((response.result!.content as Array<{ text?: unknown }>)[0]?.text ?? "")
      : "";
    if (!known) {
      record.recordError({ code: "invalid_param", cause: "unknown_tool" });
    } else if (rpcCode === -32602 || /input validation error|-32602/i.test(text)) {
      record.recordError({ code: "invalid_param", cause: "input_schema" });
    } else {
      record.recordError({ code: "internal_error", cause: "sdk_rejected" });
    }
    const isError = response.error !== undefined || response.result?.isError === true;
    this.reportTool(record, summarizeArgs(pending.args), ++this.callSeq, { isError, content: [] }, false, pending.startedAt);
  }

  private sessionStart(): void {
    if (this.sessionStarted) return;
    this.sessionStarted = true;
    this.capture("mcp_local_session_start", {
      client_capabilities: this.clientCapabilities,
      startup_ms: Math.round(process.uptime() * 1000),
      install_created_at: this.install.createdAt,
    });
  }

  /**
   * Wrap McpServer.registerTool so every tool registered afterwards reports
   * one `mcp_local_tool_call` per call. Call before registering the tools.
   */
  instrument(server: McpServer): void {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (
      name: unknown,
      config: unknown,
      handler: unknown
    ) => {
      if (typeof name !== "string" || typeof handler !== "function") return register(name, config, handler);
      this.toolNames.add(name);
      const wrapped = (...callArgs: unknown[]) => this.runTool(name, handler as (...a: unknown[]) => unknown, callArgs);
      return register(name, config, wrapped);
    };
  }

  private async runTool(name: string, handler: (...a: unknown[]) => unknown, callArgs: unknown[]): Promise<unknown> {
    const record = new ToolCallRecord(name);
    // Tools with an input schema get (args, extra); tools without get (extra) only.
    const args = callArgs.length > 1 ? callArgs[0] : {};
    const requestId = (callArgs[callArgs.length - 1] as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") this.pendingCalls.delete(requestId);
    const argSummary = summarizeArgs(args);
    const seq = ++this.callSeq;
    let result: unknown;
    let thrown = false;
    try {
      result = await runInToolCall(record, () => handler(...callArgs));
      return result;
    } catch (error) {
      thrown = true;
      throw error;
    } finally {
      this.reportTool(record, argSummary, seq, result, thrown);
    }
  }

  private reportTool(
    record: ToolCallRecord,
    argSummary: Record<string, unknown>,
    seq: number,
    result: unknown,
    thrown: boolean,
    startedAt?: number
  ): void {
    try {
      const res = result as { isError?: unknown; content?: unknown } | undefined;
      const content = Array.isArray(res?.content) ? (res!.content as Array<{ text?: unknown }>) : [];
      const resultChars = content.reduce((sum, part) => sum + (typeof part?.text === "string" ? part.text.length : 0), 0);
      const isError = res?.isError === true;
      const props = record.properties({ isError, thrown, resultChars, contentItems: content.length });
      if (startedAt !== undefined) props.duration_ms = Math.max(0, Math.round(performance.now() - startedAt));
      // The tool's own annotations (catalog model, resolved type) win over what the arguments suggested.
      const merged: Record<string, unknown> = { ...argSummary, ...props, call_seq: seq, session_age_ms: Date.now() - this.startedAt };

      this.counters.toolCalls += 1;
      this.counters.tools.add(record.command);
      if (merged.is_error) this.counters.toolErrors += 1;
      const mode = record.annotations.execution_mode;
      if (mode === "submit" && !merged.is_error) this.counters.submits += 1;
      if (mode === "dry_run") this.counters.dryRuns += 1;
      if (mode === "upload" && !merged.is_error) this.counters.uploads += 1;
      if (mode === "chat") this.counters.chats += 1;
      const { task_hash: task, charged_usd: charged } = record.annotations;
      if (task && typeof charged === "number") this.counters.pricesByTask.set(task, charged);

      this.capture("mcp_local_tool_call", merged);
    } catch {
      // never throw from telemetry
    }
  }

  /** Report the end of the session and flush, within a short deadline. */
  async shutdown(reason: string): Promise<void> {
    if (this.sessionEnded) return;
    this.sessionEnded = true;
    let priced = 0;
    for (const price of this.counters.pricesByTask.values()) priced += price;
    this.capture("mcp_local_session_end", {
      reason,
      session_duration_ms: Date.now() - this.startedAt,
      session_started: this.sessionStarted,
      tool_calls: this.counters.toolCalls,
      tool_errors: this.counters.toolErrors,
      distinct_tools: this.counters.tools.size,
      tools_used: [...this.counters.tools].sort(),
      generations_submitted: this.counters.submits,
      dry_runs: this.counters.dryRuns,
      uploads: this.counters.uploads,
      llm_calls: this.counters.chats,
      charged_tasks: this.counters.pricesByTask.size,
      charged_usd: Math.round(priced * 1e6) / 1e6,
    });
    await Promise.race([
      this.sender.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()),
    ]);
  }
}
