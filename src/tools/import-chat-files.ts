import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getApiKey } from "../services/api-client.js";
import {
  chatFileHostsFromEnv,
  formatBytes,
  importChatFiles,
  type ChatFileImportOptions,
  type ChatFileImportResult,
} from "../services/chat-file-import.js";
import { IdempotencyUncertainError, executeIdempotently } from "../services/idempotency.js";
import { getRequestContext } from "../services/request-context.js";
import { idempotencyKeySchema } from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";
import { handleError } from "../utils/error-handler.js";

/** 托管版的上传上限（MCP_UPLOAD_MAX_BYTES 的默认值），stdio 没有这项配置时用它。 */
const DEFAULT_MAX_BYTES = 33_554_432;
const MAX_FILES = 10;

/** 一个都没存成时抛出，免得这次失败被幂等缓存住、用户重新附上文件也重试不了。 */
class NothingImportedError extends Error {
  constructor(readonly result: ChatFileImportResult) {
    super("No attachment could be stored");
  }
}

// Apps SDK 规定：文件对象四个字段都要声明，download_url 和 file_id 必填，
// 少一个就过不了扫描和提审。ChatGPT 可能不给 mime_type 和 file_name。
const chatFileSchema = z
  .object({
    download_url: z.string().describe("Temporary download link supplied by the chat host"),
    file_id: z.string().describe("The chat host's identifier for the file"),
    mime_type: z.string().optional().describe("MIME type, when the host provides it"),
    file_name: z.string().optional().describe("Original file name, when the host provides it"),
  })
  .strict();

export interface ImportChatFilesDependencies {
  /** 测试注入：下载附件、转投 Atlas 用的 fetch。 */
  downloadFetcher?: ChatFileImportOptions["downloadFetcher"];
  uploadFetcher?: ChatFileImportOptions["uploadFetcher"];
}

export function registerImportChatFilesTool(
  server: McpServer,
  dependencies: ImportChatFilesDependencies = {}
): void {
  server.registerTool(
    "atlas_import_chat_files",
    {
      title: "Import Chat Attachments",
      description: `Store files the user attached in this chat in Atlas Cloud and return public URLs for them.

The returned URLs work as the image, video or audio inputs of atlas_generate_image, atlas_generate_video, atlas_generate_audio, atlas_transcribe_audio and atlas_quick_generate, including Atlas workflows such as product ads or try-on.

The chat host supplies each file as a temporary download link, so nothing has to be uploaded from a sandbox. This works in hosts that pass attachments as download links, such as ChatGPT; for files on the user's machine in other clients, use atlas_get_upload_url. Images, videos and audio are accepted, up to ${MAX_FILES} files per call. Storing files is free; nothing is billed until a generation runs with the returned URL. Stored files are temporary generation inputs, not permanent hosting.

Args:
  - idempotency_key (string, required): a new UUID per import; reuse it only to retry the same files.
  - files (array, required): the attached files.

Returns:
  For each file: url, file_name, media_type and size_bytes; files that could not be stored are listed with the reason.`,
      inputSchema: {
        idempotency_key: idempotencyKeySchema,
        files: z
          .array(chatFileSchema)
          .min(1)
          .max(MAX_FILES)
          .describe("Files the user attached in this chat"),
      },
      outputSchema: {
        files: z.array(
          z.object({
            file_id: z.string(),
            file_name: z.string(),
            url: z.string(),
            media_type: z.enum(["image", "video", "audio"]),
            size_bytes: z.number().int().nonnegative(),
          })
        ),
        failed: z.array(
          z.object({
            file_id: z.string(),
            file_name: z.string().optional(),
            reason: z.string(),
          })
        ),
      },
      annotations: toolAnnotations("atlas_import_chat_files"),
      _meta: {
        "openai/fileParams": ["files"],
        "openai/toolInvocation/invoking": "Storing your files in Atlas Cloud",
        "openai/toolInvocation/invoked": "Files stored in Atlas Cloud",
      },
    },
    async ({ idempotency_key, files }) => {
      let apiKey: string;
      try {
        apiKey = getApiKey();
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: handleError(error) }] };
      }
      const maxBytes = getRequestContext()?.uploadMaxBytes ?? DEFAULT_MAX_BYTES;
      const runImport = () =>
        importChatFiles(files, {
          apiKey,
          maxBytes,
          allowedHosts: chatFileHostsFromEnv(),
          ...(dependencies.downloadFetcher ? { downloadFetcher: dependencies.downloadFetcher } : {}),
          ...(dependencies.uploadFetcher ? { uploadFetcher: dependencies.uploadFetcher } : {}),
        });
      let result: ChatFileImportResult;
      try {
        // 下载链接每次可能不同（宿主重新签发），同一次导入只按文件编号认。
        result = await executeIdempotently(
          "atlas_import_chat_files",
          { file_ids: files.map((file) => file.file_id) },
          idempotency_key,
          async () => {
            const imported = await runImport();
            if (imported.imported.length === 0) throw new NothingImportedError(imported);
            return imported;
          }
        );
      } catch (error) {
        if (error instanceof NothingImportedError) {
          result = error.result;
        } else if (error instanceof IdempotencyUncertainError) {
          // 幂等存储为计费安全把失败记成「结果不确定」。导入不计费、重复存一次也无害，
          // 所以上一次失败后用同一个 key 重试时直接再跑一次，不走缓存。
          result = await runImport();
        } else {
          return { isError: true, content: [{ type: "text", text: handleError(error) }] };
        }
      }

      const lines = ["# Attachments stored", ""];
      for (const file of result.imported) {
        lines.push(
          `- **${file.file_name}** (${file.media_type}, ${formatBytes(file.size_bytes)}): ${file.url}`
        );
      }
      if (result.failed.length > 0) {
        if (result.imported.length > 0) lines.push("");
        lines.push(result.imported.length > 0 ? "## Not stored" : "No file could be stored.", "");
        for (const file of result.failed) {
          lines.push(`- **${file.file_name ?? file.file_id}**: ${file.reason}`);
        }
      }
      lines.push("", `Each file can be up to ${formatBytes(maxBytes)}.`);

      return {
        ...(result.imported.length === 0 ? { isError: true } : {}),
        structuredContent: { files: result.imported, failed: result.failed },
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }
  );
}
