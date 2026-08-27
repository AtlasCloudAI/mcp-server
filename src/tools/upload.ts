import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { uploadMedia } from "../services/api-client.js";
import { handleError } from "../utils/error-handler.js";

export function registerUploadTools(server: McpServer): void {
  server.registerTool(
    "atlas_upload_media",
    {
      title: "Upload Media File",
      description: `Upload a local file to Atlas Cloud and get a publicly accessible URL.

Use this whenever a model needs an input file but you only have a local path. Models take inputs by URL, never as raw bytes.

Supported file types:
  - Images (jpg, png, webp, gif, bmp, avif) — image editing, image-to-video, image-to-3D, reference images, vision chat
  - Audio (mp3, wav, m4a, aac, ogg, flac) — speech-to-text, lipsync / talking-avatar, voice cloning references
  - Video (mp4, mov, webm) — video-to-video, video editing, video understanding
  - Documents (pdf, docx, xlsx, pptx, txt, md) — models whose schema declares a document input field

Workflow:
  1. Upload the local file with this tool to get a URL
  2. Pass that URL to the parameter the model expects. The field name varies by model — check atlas_get_model_info. Common ones:
     - images (array) / image / image_url / first_frame_image / reference_images  for pictures
     - audio_url / audio / reference_audio                                        for sound
     - video / video_url / reference_videos                                       for footage
     - file                                                                       for documents

Note: the file extension decides how the file is classified downstream, so keep the real extension on the local path — a .png that actually contains AVIF data will be rejected by the model, not here.

IMPORTANT: This upload is intended for temporary use with Atlas Cloud generation tasks only. Uploaded files may be cleaned up periodically. Do NOT use this as a permanent file hosting service. Abuse (e.g. bulk uploads unrelated to generation tasks) may result in API key suspension.

Args:
  - file_path (string, required): Absolute path to the local file to upload

Returns:
  The publicly accessible download URL of the uploaded file.

Examples:
  - file_path="/Users/me/photos/cat.jpg" -> a URL to pass as image / images[0]
  - file_path="/Users/me/recordings/meeting.mp3" -> a URL to pass as audio_url for speech-to-text`,
      inputSchema: {
        file_path: z
          .string()
          .min(1)
          .describe("Absolute path to the local file to upload"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ file_path }) => {
      try {
        const result = await uploadMedia(file_path);
        const { download_url, filename, size, type } = result.data ?? {};

        const sizeLabel =
          typeof size === "number"
            ? size >= 1024 * 1024
              ? `${(size / (1024 * 1024)).toFixed(1)} MB`
              : `${(size / 1024).toFixed(0)} KB`
            : "unknown";

        return {
          content: [
            {
              type: "text",
              text:
                `File uploaded successfully.\n\n` +
                `- **URL**: ${download_url}\n` +
                `- **Filename**: ${filename}\n` +
                (type ? `- **Detected type**: ${type}\n` : "") +
                `- **Size**: ${sizeLabel}\n\n` +
                `Pass this URL to the input parameter the target model expects — the field name varies by model, so check \`atlas_get_model_info\` (commonly \`image\`/\`images\`, \`audio_url\`, \`video_url\`, or \`file\`).\n\n` +
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
