import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  UPLOAD_FILENAME_HEADER,
  issueUploadTicketFromContext,
} from "../services/upload-ticket.js";
import { toolAnnotations } from "../tool-policy.js";

// 只用来填 curl 示例：去掉路径和会破坏 shell 引号的字符。
function exampleFilename(hint: string | undefined): string {
  const cleaned = basename((hint ?? "").replace(/\\/g, "/"))
    .replace(/["'`$\\\r\n]/g, "")
    .trim();
  return cleaned === "" ? "input.png" : cleaned;
}

export function registerUploadUrlTool(server: McpServer): void {
  server.registerTool(
    "atlas_get_upload_url",
    {
      title: "Get Upload URL",
      description: `Get a short-lived URL that accepts a local file and returns a public Atlas media URL, for use as the image/audio URL parameter of generation tools.

Use this when the user has a local file (product photo, reference image, audio to transcribe) and the target model needs a URL. The hosted MCP server cannot read files on the user's machine; this URL lets you push the bytes yourself.

Steps:
  1. Call this tool. It returns upload_url, expires_at and max_bytes.
  2. POST the raw file bytes to upload_url with the file name (keep the extension) in the ${UPLOAD_FILENAME_HEADER} header. The curl_example in the result is ready to run.
  3. The response JSON has "url". Pass that URL to atlas_generate_image, atlas_generate_video or atlas_quick_generate.

Rules:
  - One URL serves several files until it expires (about 10 minutes); do not request a new one per file.
  - Uploads are free; nothing is billed until a generation is submitted with the returned URL.
  - Files larger than max_bytes are rejected with 413. Ask the user to host those elsewhere and give you a public link.
  - Only report a file as uploaded when the response contained "url". If the command fails, say so and offer the public-link fallback.
  - Uploaded files are temporary inputs for generation, not permanent hosting.

Args:
  - filename_hint (string, optional): the file name you intend to upload; only used to fill in curl_example.

Returns:
  upload_url, method, filename_header, expires_at, max_bytes, curl_example.`,
      inputSchema: {
        filename_hint: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "File name (with extension) you intend to upload; only used to fill in curl_example"
          ),
      },
      outputSchema: {
        upload_url: z.string().url(),
        method: z.literal("POST"),
        filename_header: z.string(),
        expires_at: z.string(),
        max_bytes: z.number().int().positive(),
        curl_example: z.string(),
      },
      annotations: toolAnnotations("atlas_get_upload_url"),
    },
    async ({ filename_hint }) => {
      const issued = issueUploadTicketFromContext();
      if (!issued) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Error: upload URLs are only issued by the hosted Atlas MCP server. " +
                "In a local (stdio) setup, use atlas_upload_media with the file path instead.",
            },
          ],
        };
      }
      const name = exampleFilename(filename_hint);
      const curlExample = [
        `curl -sS -X POST "${issued.uploadUrl}"`,
        `  -H "Content-Type: application/octet-stream"`,
        `  -H "${UPLOAD_FILENAME_HEADER}: ${name}"`,
        `  --data-binary @"/path/to/${name}"`,
      ].join(" \\\n");
      const expiresAt = new Date(issued.expiresAt).toISOString();
      const megabytes = Math.floor(issued.maxBytes / 1_048_576);
      const text = [
        "# Upload URL",
        "",
        `- **Expires**: ${expiresAt}`,
        `- **Max size**: ${issued.maxBytes} bytes (${megabytes} MB)`,
        `- **Method**: POST the raw bytes; file name in the \`${UPLOAD_FILENAME_HEADER}\` header`,
        "",
        "```bash",
        curlExample,
        "```",
        "",
        "The response is JSON with `url`; use it as the media URL in a generation tool. " +
          "For larger files, ask the user for a public link instead.",
      ].join("\n");
      return {
        structuredContent: {
          upload_url: issued.uploadUrl,
          method: "POST" as const,
          filename_header: UPLOAD_FILENAME_HEADER,
          expires_at: expiresAt,
          max_bytes: issued.maxBytes,
          curl_example: curlExample,
        },
        content: [{ type: "text", text }],
      };
    }
  );
}
