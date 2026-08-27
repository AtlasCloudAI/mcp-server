import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ApiRequestError, readTerminalTaskStatus } from "../services/api-client.js";
import { findModel } from "../services/doc-fetcher.js";
import { handleError } from "../utils/error-handler.js";
import {
  collectOutputs,
  renderPrediction,
  resolveOutputMode,
  toErrorMessage,
} from "../utils/prediction-format.js";
import { truncate } from "../utils/formatter.js";
import { describeOutputUrl } from "../utils/model-kind.js";
import type {
  HistoryResponse,
  Model,
  PredictionData,
  PredictionResponse,
} from "../types.js";

/**
 * A failed prediction is reported as HTTP 5xx carrying the terminal payload.
 * That is an answer, not an outage, so unwrap it and render it like any other
 * result instead of surfacing a transport error.
 */
function terminalPayloadOf(error: unknown): PredictionData | null {
  if (!(error instanceof ApiRequestError)) return null;
  const body = error.responseBody;
  if (!readTerminalTaskStatus(body)) return null;
  const outer = body as Record<string, unknown>;
  const task =
    outer.data && typeof outer.data === "object"
      ? (outer.data as PredictionData)
      : (outer as PredictionData);
  // The outer envelope often carries the clearer message
  if (!task.error && typeof outer.message === "string" && outer.message) {
    return { ...task, error: outer.message };
  }
  return task;
}

// Look up model metadata so outputs can be labelled by kind. Never fatal:
// the catalogue lookup is a nicety, the prediction payload is the source of truth.
async function lookupModel(modelId?: string): Promise<Model | null> {
  if (!modelId) return null;
  try {
    return (await findModel(modelId)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Shorten an error for a one-line preview.
 * Upstream errors often start with the full signed URL of the offending input,
 * which is longer than the whole preview budget — cutting from the front would
 * show nothing but the URL and hide the actual reason.
 */
function condenseError(message: string): string {
  const condensed = message.replace(/https?:\/\/\S{40,}/g, "<url>").trim();
  return condensed.length > 110 ? `${condensed.slice(0, 110)}…` : condensed;
}

// One-line preview of a result, for the history listing
function previewOutput(data: PredictionData | undefined): string {
  if (!data) return "-";
  const outputs = collectOutputs(data);
  if (outputs.length === 0) {
    const err = toErrorMessage(data.error);
    return err ? `error: ${condenseError(err)}` : "-";
  }
  const mode = resolveOutputMode(outputs);
  if (mode === "text") {
    const text = outputs[0].replace(/\s+/g, " ").trim();
    return `text: ${text.slice(0, 90)}${text.length > 90 ? "…" : ""}`;
  }
  const kind = describeOutputUrl(outputs[0]);
  const extra = outputs.length > 1 ? ` (+${outputs.length - 1} more)` : "";
  return `${kind}: ${outputs[0]}${extra}`;
}

export function registerPredictionTools(server: McpServer): void {
  server.registerTool(
    "atlas_get_prediction",
    {
      title: "Get Prediction Result",
      description: `Check the status and result of an Atlas Cloud generation task (image, video, 3D, audio/TTS, music, or speech-to-text).

Use this after submitting a generation request to check if the result is ready.

If the status is still "processing", "created", "starting" or "queued", wait a moment and try again. "completed"/"succeeded" means success; "failed", "timeout" and "canceled" are final — do not keep polling those.

IMPORTANT: the result is not always a file URL. Depending on the model it can be:
  - Media URLs (image / video / audio / 3D files) — show them to the user and offer to download them
  - Plain TEXT returned directly in the output (speech-to-text transcripts, generated lyrics) — this IS the content; do not try to download it
  - Extra structured data: transcript timing info, lyrics title/style tags, or the cover art that ships with a generated song

Args:
  - prediction_id (string, required): The prediction ID returned from a generation request

Returns:
  Status, cost, and the result rendered according to what the model actually returned.

Examples:
  - prediction_id="6fca9369e2fa4998a0fcad1e61bdd30a" -> check generation status`,
      inputSchema: {
        prediction_id: z
          .string()
          .min(1)
          .describe("Prediction ID from a generation request"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ prediction_id }) => {
      try {
        let data: PredictionData;
        try {
          const result = await api<PredictionResponse>(
            `/model/prediction/${prediction_id}`
          );
          data = result.data ?? {};
        } catch (error) {
          const terminal = terminalPayloadOf(error);
          if (!terminal) throw error;
          data = terminal;
        }

        if (!data.id) data.id = prediction_id;
        const model = await lookupModel(data.model);

        return {
          content: [
            { type: "text", text: renderPrediction(data, { model }) },
          ],
        };
      } catch (error) {
        if (error instanceof ApiRequestError && error.statusCode === 404) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `No prediction found with ID \`${prediction_id}\`. Check the ID, or use \`atlas_list_predictions\` to find recent tasks made with this API key.`,
              },
            ],
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );

  server.registerTool(
    "atlas_list_predictions",
    {
      title: "List Generation History",
      description: `List past generation tasks (image, video, 3D, audio, speech-to-text) made with this API key, newest first.

Use this to:
  - Recover a prediction ID that was lost (e.g. the submit call timed out but the task was created and is still billed)
  - Review what was generated earlier and fetch the output URLs again
  - Check which recent tasks failed and why

Each row shows the prediction ID, time, model, status and a short preview of the result. Pass the ID to atlas_get_prediction for the full result.

Args:
  - prediction_id (string, optional): Look up one exact task by ID.
  - model (string, optional): Filter by exact model ID, e.g. "bytedance/seed-asr-2.0".
  - status (string, optional): Filter by status: "created", "processing", "completed", "failed", "timeout".
  - limit (number, optional): Rows per page, 1-50. Default 10.
  - page (number, optional): 1-based page number. Default 1.

Returns:
  A Markdown list of past tasks with IDs, statuses and result previews.

Examples:
  - (no params) -> the 10 most recent tasks
  - status="failed" -> recent failures with their error messages
  - model="suno/chirp-v5", limit=5 -> the last 5 Suno songs`,
      inputSchema: {
        prediction_id: z
          .string()
          .optional()
          .describe("Look up one exact task by its prediction ID"),
        model: z.string().optional().describe("Filter by exact model ID"),
        status: z
          .enum(["created", "processing", "completed", "failed", "timeout"])
          .optional()
          .describe("Filter by task status"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Rows per page, 1-50. Default 10"),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based page number. Default 1"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ prediction_id, model, status, limit, page }) => {
      try {
        const size = limit ?? 10;
        const no = page ?? 1;
        const res = await api<HistoryResponse>("/model/history", {
          params: {
            no,
            size,
            ...(prediction_id ? { sessionID: prediction_id } : {}),
            ...(model ? { model } : {}),
            ...(status ? { status } : {}),
          },
        });

        const items = res.data?.items ?? [];
        const total = res.data?.total ?? items.length;

        if (items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `No generation history found${
                    model ? ` for model \`${model}\`` : ""
                  }${status ? ` with status "${status}"` : ""}.`,
              },
            ],
          };
        }

        const lines: string[] = ["# Generation History\n"];
        lines.push(
          `Showing ${items.length} of ${total} tasks (page ${res.data?.pageNo ?? no}).\n`
        );

        for (const item of items) {
          // createdAt is a unix timestamp in seconds
          const when = Number.isFinite(item.createdAt)
            ? new Date(item.createdAt * 1000).toISOString().replace(".000Z", "Z")
            : "unknown";
          lines.push(`- \`${item.ID}\` — **${item.status}** — ${when}`);
          lines.push(`  Model: \`${item.model}\``);
          lines.push(`  Result: ${previewOutput(item.result)}`);
        }

        lines.push(
          "",
          "Use `atlas_get_prediction` with any of these IDs for the full result."
        );
        if (total > items.length) {
          lines.push(
            `There are ${total} tasks in total — pass \`page\` to see older ones.`
          );
        }

        return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );
}
