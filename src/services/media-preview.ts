import { fetchExternalBinary } from "./api-client.js";

// Why this exists: a generated image is returned to us as a URL on the object
// store's default domain, and that domain forces `Content-Disposition: attachment`
// plus `x-oss-force-download: true` at the gateway. A client that renders the URL
// gets a download, not a picture. Codex also refuses http(s) image URLs outright —
// an image item has to carry a base64 `data:` payload — so even once the platform
// binds a custom domain, showing the result in chat still means sending bytes.
//
// So we fetch the object server-side and hand the client an MCP image block. The
// client never touches the object store, and the response headers stop mattering.
//
// The model sees the block too, which is the part that is not just cosmetic: it
// can look at what it generated and say the hands are wrong.

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "heic", "heif", "tiff",
]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "opus"]);

export type OutputKind = "image" | "video" | "audio" | "other";

export interface ImagePreviewBlock {
  type: "image";
  data: string;
  mimeType: string;
}

function extensionOf(url: string): string {
  try {
    // Query and fragment first: signed object URLs carry an expiry and a
    // signature, and "…/a.png?Expires=1&Signature=x" has no extension without this.
    const { pathname } = new URL(url);
    const last = pathname.split("/").pop() ?? "";
    const dot = last.lastIndexOf(".");
    return dot === -1 ? "" : last.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
}

export function classifyOutput(url: string): OutputKind {
  const ext = extensionOf(url);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "other";
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function previewsEnabled(): boolean {
  return boolEnv("MCP_MEDIA_PREVIEW_ENABLED", true);
}

export function maxPreviews(): number {
  // A batch of four 1024px JPEGs is already a few thousand tokens of context.
  return intEnv("MCP_MEDIA_PREVIEW_MAX", 4, 0, 8);
}

// Aliyun OSS resizes on read, which is the difference between a 4 MB PNG and a
// ~100 KB JPEG in the response. `l_<n>` bounds the long edge, so portrait and
// landscape both come back bounded without us knowing the aspect ratio.
export function withResizeParams(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("x-oss-process")) return null;
    const edge = intEnv("MCP_MEDIA_PREVIEW_EDGE", 1024, 256, 2048);
    parsed.searchParams.set(
      "x-oss-process",
      `image/resize,l_${edge}/format,jpg/quality,q_80`
    );
    return parsed.toString();
  } catch {
    return null;
  }
}

function mimeFor(contentType: string | null, url: string): string | null {
  if (contentType) {
    const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (bare.startsWith("image/")) return bare;
  }
  const ext = extensionOf(url);
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

/**
 * Fetch one image and return it as an MCP image block, or null if anything at
 * all goes wrong.
 *
 * Fail-open is deliberate. The prediction result is the answer to the user's
 * question; the picture is a nicety on top. An object store hiccup, a bucket
 * that has image processing switched off, an object larger than the cap — none
 * of those should turn a successful generation into a failed tool call.
 */
export async function buildImagePreview(url: string): Promise<ImagePreviewBlock | null> {
  // Resized first. If the bucket has no image processing the request 400s, and
  // the original is still worth trying — it just costs more context.
  const candidates = [withResizeParams(url), url].filter(
    (candidate): candidate is string => Boolean(candidate)
  );

  for (const candidate of candidates) {
    try {
      const { bytes, contentType } = await fetchExternalBinary(candidate);
      const mimeType = mimeFor(contentType, url);
      if (!mimeType || bytes.byteLength === 0) continue;
      return {
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export async function buildImagePreviews(urls: string[]): Promise<ImagePreviewBlock[]> {
  if (!previewsEnabled()) return [];
  const limit = maxPreviews();
  if (limit === 0) return [];
  const targets = urls.filter((url) => classifyOutput(url) === "image").slice(0, limit);
  const settled = await Promise.all(targets.map((url) => buildImagePreview(url)));
  return settled.filter((block): block is ImagePreviewBlock => block !== null);
}

/**
 * What to tell the model about outputs it cannot be shown.
 *
 * Codex has no video content type — not in MCP's blocks and not in its own input
 * items, which are text, image and audio only. So a video can never appear in the
 * conversation, and the default-domain URL downloads rather than plays. Saving the
 * file where the user is working is the one thing that actually helps, so say so
 * instead of leaving the model to hand over a link and stop.
 */
export function playbackGuidance(kinds: Set<OutputKind>): string | null {
  const notes: string[] = [];
  if (kinds.has("video")) {
    notes.push(
      "Video cannot be displayed in this conversation. Offer to save it to the user's " +
        "working directory (`curl -L -o <name>.mp4 '<url>'`) so they can open it locally — " +
        "opening the URL in a browser downloads the file rather than playing it."
    );
  }
  if (kinds.has("other")) {
    notes.push(
      "Some outputs are not images, video or audio (for example 3D assets such as GLB or " +
        "OBJ). Offer to download those to the user's working directory as well."
    );
  }
  return notes.length > 0 ? notes.join("\n") : null;
}
