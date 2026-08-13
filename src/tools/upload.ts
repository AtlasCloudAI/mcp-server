import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { uploadMedia } from "../services/api-client.js";
import { executeIdempotently } from "../services/idempotency.js";
import { handleError } from "../utils/error-handler.js";
import { idempotencyKeySchema } from "../tool-contracts.js";
import { toolAnnotations } from "../tool-policy.js";

export function registerUploadTools(server: McpServer): void {
  server.registerTool(
    "atlas_upload_media",
    {
      title: "Upload Media File",
      description: `Upload a local image or media file to Atlas Cloud and get a publicly accessible URL.

Use this tool when you need to provide an image URL to image-editing or image-to-video models, but only have a local file path.

Workflow:
  1. Upload the local file with this tool to get a URL
  2. Use the returned URL as the "image_url" parameter in atlas_generate_image, atlas_generate_video, or atlas_quick_generate

Supported file types: images (jpg, png, webp, etc.), videos, and other media files.

IMPORTANT: This upload is intended for temporary use with Atlas Cloud generation tasks only. Uploaded files may be cleaned up periodically. Do NOT use this as a permanent file hosting service. Abuse (e.g., bulk uploads unrelated to generation tasks) may result in API key suspension.

Args:
  - file_path (string, required): Absolute path to the local file to upload

Returns:
  The publicly accessible download URL of the uploaded file.

Examples:
  - file_path="/Users/me/photos/cat.jpg" -> uploads and returns a URL like "https://atlas-img.oss-accelerate-overseas.aliyuncs.com/media/xxx.jpg"`,
      inputSchema: {
        idempotency_key: idempotencyKeySchema,
        file_path: z
          .string()
          .min(1)
          .describe("Absolute path to the local file to upload"),
      },
      outputSchema: {
        url: z.string().url(),
        filename: z.string(),
        size_bytes: z.number().int().nonnegative(),
        media_type: z.string(),
      },
      annotations: toolAnnotations("atlas_upload_media"),
    },
    async ({ idempotency_key, file_path }) => {
      try {
        const result = await executeIdempotently(
          "atlas_upload_media",
          { idempotency_key, file_path },
          idempotency_key,
          () => uploadMedia(file_path)
        );

        return {
          structuredContent: {
            url: result.data.download_url,
            filename: result.data.filename,
            size_bytes: result.data.size,
            media_type: result.data.type,
          },
          content: [
            {
              type: "text",
              text:
                `File uploaded successfully.\n\n` +
                `- **URL**: ${result.data.download_url}\n` +
                `- **Filename**: ${result.data.filename}\n` +
                `- **Size**: ${result.data.size} bytes\n\n` +
                `You can now use this URL as the \`image_url\` parameter in image edit or video generation tools.\n\n` +
                `> **Note**: This URL is for temporary use with Atlas Cloud generation tasks only. It may expire after a period of time. Do not use it as permanent file hosting.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleError(error) }],
        };
      }
    }
  );
}
