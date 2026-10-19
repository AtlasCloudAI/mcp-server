import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  UPLOAD_FILENAME_HEADER,
  issueUploadTicketFromContext,
} from "../services/upload-ticket.js";
import { currentClientProfile, type ClientProfile } from "../services/client-profile.js";
import { toolAnnotations } from "../tool-policy.js";

// 只用来填 curl 示例：去掉路径和会破坏 shell 引号的字符。
function exampleFilename(hint: string | undefined): string {
  const cleaned = basename((hint ?? "").replace(/\\/g, "/"))
    .replace(/["'`$\\\r\n]/g, "")
    .trim();
  return cleaned === "" ? "input.png" : cleaned;
}

// 2026-10-19 实测：从用户自己的网络上传，1.77 MB 的图要 6~7 秒（上行约 250~300 KB/s），
// 中转还要再转投一次。Codex 的命令工具约 10 秒就交回控制权，模型把还在传的 curl 当成
// 「上传无响应」，于是放弃或换票重来。另外默认权限的沙箱没有网络，ChatGPT 的沙箱解析不了
// 我们的域名。指引把这几种情况分别说清楚。
function uploadNotes(profile: ClientProfile): string[] {
  const notes = [
    "- Uploads go over the user's own connection: a 2 MB image can take 10 seconds or more. " +
      "Wait for the curl command to exit; if your shell tool returns while it is still running, " +
      "keep waiting on that same process — a running upload is not a failure.",
    "- A reference image does not need full resolution. Shrink anything over about 2 MB before " +
      "uploading (on macOS: `sips -Z 2048 -s format jpeg in.png --out ref.jpg`).",
    "- Success is HTTP 200 with JSON containing `url`. If the upload fails or times out, call " +
      "atlas_get_upload_url again for a fresh URL and retry once.",
  ];
  if (profile === "chat") {
    notes.push(
      "- If the command cannot resolve or reach the upload host, this sandbox has no network. " +
        "Do not fall back to sending the file as base64 in a tool call (it is rejected as too " +
        "large); ask the user for a public link to the file instead."
    );
  } else {
    notes.push(
      "- If the sandbox has no network access, ask to run that one command with network access " +
        "(escalated permissions) instead of giving up."
    );
  }
  return notes;
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
        `curl -sS --max-time 180 -w "\\nHTTP %{http_code}\\n" -X POST "${issued.uploadUrl}"`,
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
        "",
        ...uploadNotes(currentClientProfile()),
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
