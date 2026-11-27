import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runQuoteOnly } from "./services/spend-policy.js";
import { annotateToolCall } from "./telemetry/tool-call.js";

/**
 * dry_run for the local (npm) server, kept from npm 1.x.
 *
 * 1.x had `dry_run` on every generation tool: validate, show the request, submit
 * nothing. On this line the first call of a generation tool already stops at a
 * quote and spends nothing, so dry_run maps onto that: it drops any
 * confirmation the call carries and runs the tool with auto-submit off, so the
 * call can only ever quote. The caller gets the live price as well as the
 * validated model, which 1.x could not give.
 *
 * Only the stdio server installs this; the hosted tool definitions are unchanged.
 */

const DRY_RUN_TOOLS = new Set([
  "atlas_generate_image",
  "atlas_generate_video",
  "atlas_generate_audio",
  "atlas_transcribe_audio",
  "atlas_quick_generate",
]);

const dryRunSchema = z
  .boolean()
  .optional()
  .describe(
    "Validate the request and show the model and its estimated cost without submitting anything. Nothing is billed; any confirmation in the same call is ignored."
  );

const DRY_RUN_NOTE =
  "Dry run: the request was validated and priced, and nothing was submitted or billed. Run the call again without dry_run to get a quote the user can confirm.";

type Handler = (...args: unknown[]) => unknown;

export function installLegacyDryRun(server: McpServer): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (
    name: unknown,
    config: unknown,
    handler: unknown
  ) => {
    if (typeof name !== "string" || !DRY_RUN_TOOLS.has(name) || typeof handler !== "function") {
      return register(name, config, handler);
    }
    const original = config as { inputSchema?: Record<string, unknown> };
    const withDryRun = { ...original, inputSchema: { ...(original.inputSchema ?? {}), dry_run: dryRunSchema } };
    const wrapped = async (...callArgs: unknown[]) => {
      const args = (callArgs.length > 1 ? callArgs[0] : undefined) as Record<string, unknown> | undefined;
      if (!args || args.dry_run !== true) return (handler as Handler)(...callArgs);
      const { dry_run: _dryRun, confirmed: _confirmed, confirmation_token: _token, ...rest } = args;
      const result = (await runQuoteOnly(() => (handler as Handler)(rest, ...callArgs.slice(1)))) as {
        content?: Array<{ type: string; text?: string }>;
      };
      annotateToolCall({ execution_mode: "dry_run" });
      if (result && Array.isArray(result.content)) {
        return { ...result, content: [{ type: "text", text: DRY_RUN_NOTE }, ...result.content] };
      }
      return result;
    };
    return register(name, withDryRun, wrapped);
  };
}
