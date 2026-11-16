/**
 * 能上传的媒体文件：扩展名白名单和按文件头认格式。
 *
 * 远程上传中转（http/upload-relay.ts）、聊天附件导入（chat-file-import.ts）和 stdio 的本地上传
 * （api-client.ts uploadMedia）共用这一套。Atlas 的 /model/uploadMedia 本身什么类型都收，
 * 收下的文件放在公开存储上（长亭 11-09 报告），所以服务端这一侧要先挡。
 */

/** 图片、视频、音频、GLB。和 AssetD 收的格式一致，另加 aac、ogg、flac。 */
export const UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg", "jpeg", "png", "webp", "gif",
  "mp4", "mov", "webm",
  "mp3", "wav", "m4a", "aac", "ogg", "flac",
  "glb",
]);

export function uploadExtensionAllowed(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  return dot > 0 && UPLOAD_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** 名字和类型都没说清时，按文件头认几种常见格式。认不出返回 undefined。 */
export function sniffExtension(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "png";
  if (ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF") {
    const kind = ascii(bytes, 8, 4);
    if (kind === "WEBP") return "webp";
    if (kind === "WAVE") return "wav";
    return undefined;
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
    if (brand === "qt  ") return "mov";
    if (brand === "M4A ") return "m4a";
    return "mp4";
  }
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "flac";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "mp3";
  return undefined;
}


/** 文件头认得出是媒体（含 GLB）。HEIC 也算认得出，调用方自己决定收不收。 */
export function looksLikeMedia(bytes: Uint8Array): boolean {
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "glTF") return true;
  return sniffExtension(bytes) !== undefined;
}
