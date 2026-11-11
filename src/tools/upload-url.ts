import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  UPLOAD_FILENAME_HEADER,
  issueUploadTicketFromContext,
} from "../services/upload-ticket.js";
import { currentClientProfile, type ClientProfile } from "../services/client-profile.js";
import { CARD_TOOL_POLICIES, toolAnnotations } from "../tool-policy.js";
import {
  clientRendersCards,
  generationCardEnabled,
  generationCardToolMeta,
} from "../apps/generation-card.js";
import { UPLOAD_CARD_NOTE, UPLOAD_META_KEY, uploadCardData } from "../apps/upload-card.js";
import { getRequestContext } from "../services/request-context.js";
import { assetLibraryAvailable } from "./assets.js";

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
        "Files the user attached in this chat can be stored with atlas_import_chat_files instead, " +
        "which needs no sandbox network. Do not send the file as base64 in a tool call (it is " +
        "rejected as too large); for anything else, ask the user for a public link."
    );
  } else {
    notes.push(
      "- If the sandbox has no network access, ask to run that one command with network access " +
        "(escalated permissions) instead of giving up."
    );
  }
  return notes;
}

const UPLOAD_OUTPUT_SCHEMA = {
  upload_url: z.string().url(),
  method: z.literal("POST"),
  filename_header: z.string(),
  expires_at: z.string(),
  max_bytes: z.number().int().positive(),
  max_video_bytes: z.number().int().positive().optional(),
  saves_to_asset_library: z.boolean(),
  curl_example: z.string(),
};

type UploadResult = {
  isError?: true;
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
};

/**
 * 签一张上传票，拼好 curl 指引。两个工具共用：atlas_get_upload_url 只给模型自己传，
 * atlas_open_upload_card 在会显示卡片的客户端里把同一张票交给上传卡。
 */
async function issueUpload(filenameHint: string | undefined, withCard: boolean): Promise<UploadResult | {
  structuredContent: Record<string, unknown>;
  cardMeta: Record<string, unknown>;
  sizeLine: string;
  text: string;
}> {
  // 开着「上传存进资产库」时先查资产库能不能用（要充值后才开通）；能用才签存进资产库的票。
  const library = getRequestContext()?.libraryUpload ? await assetLibraryAvailable() : false;
  const issued = await issueUploadTicketFromContext({ library });
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
  const name = exampleFilename(filenameHint);
  const curlExample = [
    `curl -sS --max-time 180 -w "\\nHTTP %{http_code}\\n" -X POST "${issued.uploadUrl}"`,
    `  -H "Content-Type: application/octet-stream"`,
    `  -H "${UPLOAD_FILENAME_HEADER}: ${name}"`,
    `  --data-binary @"/path/to/${name}"`,
  ].join(" \\\n");
  const expiresAt = new Date(issued.expiresAt).toISOString();
  const megabytes = Math.floor(issued.maxBytes / 1_048_576);
  const sizeLine = issued.maxVideoBytes
    ? `images and audio up to ${megabytes} MB, videos and 3D models up to ${Math.floor(issued.maxVideoBytes / 1_048_576)} MB`
    : `${megabytes} MB`;
  const cardMeta = withCard && generationCardEnabled() ? { _meta: { [UPLOAD_META_KEY]: uploadCardData(issued) } } : {};
  const structuredContent = {
    upload_url: issued.uploadUrl,
    method: "POST" as const,
    filename_header: UPLOAD_FILENAME_HEADER,
    expires_at: expiresAt,
    max_bytes: issued.maxBytes,
    ...(issued.maxVideoBytes ? { max_video_bytes: issued.maxVideoBytes } : {}),
    saves_to_asset_library: issued.library,
    curl_example: curlExample,
  };
  const text = [
    "# Upload URL",
    "",
    `- **Expires**: ${expiresAt}`,
    issued.maxVideoBytes
      ? `- **Max size**: ${issued.maxBytes} bytes for images and audio, ${issued.maxVideoBytes} bytes for videos and 3D models (${sizeLine})`
      : `- **Max size**: ${issued.maxBytes} bytes (${megabytes} MB)`,
    ...(issued.library
      ? [
          "- **Saved to**: the user's Asset Library. The returned `url` lasts about 15 minutes; if it expires, call atlas_use_assets with the returned `asset_id`.",
          ...(issued.maxImagePixels ? [`- **Images**: up to ${Math.floor(issued.maxImagePixels / 1_000_000)} MP; larger ones are rejected, so resize them first`] : []),
          "- **If the Asset Library is full**: the response is HTTP 413 `upload_quota_exceeded` with a `fallback_upload_url`. POST the same file there: it still works for this request but isn't saved to the Asset Library, so tell the user.",
        ]
      : []),
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
  return { structuredContent, cardMeta, sizeLine, text };
}

const RETURNS = `Returns:
  upload_url, method, filename_header, expires_at, max_bytes, max_video_bytes (when uploads go to the Asset Library), saves_to_asset_library, curl_example.`;

const UPLOAD_RULES = `Rules:
  - One URL serves several files until it expires (about 10 minutes); do not request a new one per file.
  - Uploads are free; nothing is billed until a generation is submitted with the returned URL.
  - Files larger than max_bytes are rejected with 413; when max_video_bytes is present, it is the limit for videos and 3D files and max_bytes is the limit for images and audio. Ask the user to host larger files elsewhere and give you a public link.
  - Only report a file as uploaded when the response contained "url". If the command fails, say so and offer the public-link fallback.
  - When saves_to_asset_library is true, uploads are saved in the user's Asset Library and the returned url is temporary (about 15 minutes); if it has expired, call atlas_use_assets with the asset_id. For an image the upload response also gives width, height, orientation and ratio, so there is no need to call atlas_use_assets just to learn its shape. Otherwise uploaded files are temporary inputs for generation, not permanent hosting.`;

/**
 * 模型自己传：拿到地址后在命令行里 curl。2026-11-11 在 Cursor 里，旧版说明让会显示卡片的客户端
 * 都去等上传卡，模型手里有本地路径也让用户去卡片里再选一遍。Higgsfield 也是同样的拆法：
 * media_upload 是默认路径，media_upload_widget 只兜底。
 */
export function registerUploadUrlTool(server: McpServer): void {
  server.registerTool(
    "atlas_get_upload_url",
    {
      title: "Get Upload URL",
      description: `Get a short-lived URL that accepts a file and returns a public Atlas media URL, for use as the image/video/audio URL parameter of generation tools.

This is the default path for any file whose bytes you can read: a path on this machine (in a coding agent such as Cursor, Codex or Claude Code) or a file in your code sandbox. Upload it yourself; do not ask the user to pick or attach the file again. The hosted MCP server cannot read files on the user's machine; this URL lets you push the bytes yourself.

Steps:
  1. Call this tool. It returns upload_url, expires_at and max_bytes.
  2. POST the raw file bytes to upload_url with the file name (keep the extension) in the ${UPLOAD_FILENAME_HEADER} header. The curl_example in the result is ready to run.
  3. The response JSON has "url" (and "asset_id" when the file was saved to the user's Asset Library). Pass that URL to atlas_generate_image, atlas_generate_video, atlas_generate_audio, atlas_transcribe_audio or atlas_quick_generate.

Only when you cannot read the file (it is only on the user's device), cannot run commands, or the upload failed, call atlas_open_upload_card instead (in apps that show Atlas cards) so the user can pick the file there.

${UPLOAD_RULES}

Args:
  - filename_hint (string, optional): the file name you intend to upload; only used to fill in curl_example.

${RETURNS}`,
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
      outputSchema: UPLOAD_OUTPUT_SCHEMA,
      annotations: toolAnnotations("atlas_get_upload_url"),
    },
    async ({ filename_hint }) => {
      const issued = await issueUpload(filename_hint, false);
      if ("content" in issued) return issued;
      return { structuredContent: issued.structuredContent, content: [{ type: "text", text: issued.text }] };
    }
  );
}

/**
 * 上传卡（兜底）：只注册给会显示卡片的客户端。卡片里「Upload again」和资产库的上传格也调它换新地址。
 */
export function registerUploadCardTool(server: McpServer): void {
  server.registerTool(
    "atlas_open_upload_card",
    {
      title: "Open Upload Card",
      description: `Fallback for getting the user's own image, video or audio into Atlas: opens an upload card in the chat where the user picks files on their device and the card uploads them.

Use it only when you cannot upload the file yourself with atlas_get_upload_url: the file is not readable from your shell or sandbox (it is only on the user's device), you cannot run commands or reach the network, or the upload command failed. If you can read the file, use atlas_get_upload_url instead and do not open this card. Files the user attached in a ChatGPT chat go through atlas_import_chat_files instead.

Call it as the only tool in that turn. Briefly tell the user to add their files in the card, then wait: when they press "Use files", the uploaded URLs (and Asset Library IDs) arrive in a new message or in your context. Do not ask the user to attach the files in the chat.

${UPLOAD_RULES}

${RETURNS}`,
      inputSchema: {},
      outputSchema: UPLOAD_OUTPUT_SCHEMA,
      annotations: { ...CARD_TOOL_POLICIES.atlas_open_upload_card.annotations },
      // 卡片里的「Upload again」、资产库上传格也调这个工具换一张新地址。
      ...(generationCardEnabled() ? { _meta: generationCardToolMeta() } : {}),
    },
    async () => {
      const issued = await issueUpload(undefined, true);
      if ("content" in issued) return issued;
      // 客户端不显示卡片（不该发生：只注册给显示卡片的客户端）时，退回给模型 curl 指引。
      if (!clientRendersCards(server)) {
        return { ...issued.cardMeta, structuredContent: issued.structuredContent, content: [{ type: "text", text: issued.text }] };
      }
      return {
        ...issued.cardMeta,
        structuredContent: issued.structuredContent,
        content: [{ type: "text", text: `# Upload card\n\n${UPLOAD_CARD_NOTE}\n\nMax size per file: ${issued.sizeLine}.` }],
      };
    }
  );
}
