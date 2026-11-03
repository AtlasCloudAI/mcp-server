/**
 * 从文件开头几十 KB 读出图片宽高（PNG、JPEG、WebP、GIF），不解码像素。
 *
 * 模型看不到图片，拿到的只是地址，判断不了横竖：用户要竖屏视频时只能反问「你的图是不是竖的」
 * （2026-11-03 Claude 验收问题 13）。资产库接口不给宽高（AssetD 只在上传时读一次），所以在用到
 * 素材的地方自己读文件头：取素材地址、视频报价。读不出（格式不认识、头部太靠后）就当没有，不影响别的。
 *
 * JPEG 照 EXIF 方向换算：手机竖拍的照片像素是横着存的，方向 5～8 要把宽高对调，才是看到的样子。
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** 读文件头要的字节数：JPEG 的 EXIF 里可能夹着缩略图，SOF 会排到几十 KB 之后。 */
export const IMAGE_HEADER_BYTES = 128 * 1024;

function u16be(b: Uint8Array, i: number): number {
  return (b[i]! << 8) | b[i + 1]!;
}

function u16le(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8);
}

function u24le(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
}

function u32be(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
}

function ascii(b: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...b.subarray(start, start + length));
}

function valid(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function png(b: Uint8Array): ImageSize | undefined {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return undefined;
  return valid(u32be(b, 16), u32be(b, 20));
}

function gif(b: Uint8Array): ImageSize | undefined {
  return b.length < 10 ? undefined : valid(u16le(b, 6), u16le(b, 8));
}

function webp(b: Uint8Array): ImageSize | undefined {
  if (b.length < 30) return undefined;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") return valid(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  if (chunk === "VP8L") {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") return valid(u24le(b, 24) + 1, u24le(b, 27) + 1);
  return undefined;
}

/** EXIF（APP1 段）里的方向，1～8；没有或读不出返回 1。 */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (end - start < 14 || ascii(b, start, 6) !== "Exif\0\0") return 1;
  const tiff = start + 6;
  const little = ascii(b, tiff, 2) === "II";
  const u16 = (i: number) => (little ? u16le(b, i) : u16be(b, i));
  const u32 = (i: number) => (little ? (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0 : u32be(b, i));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpeg(b: Uint8Array): ImageSize | undefined {
  let orientation = 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    // 填充字节和不带长度的标记。
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const length = u16be(b, i + 2);
    if (length < 2) return undefined;
    if (marker === 0xe1) orientation = exifOrientation(b, i + 4, Math.min(b.length, i + 2 + length));
    // SOF0～SOF15，除了 DHT（C4）、JPG（C8）、DAC（CC）。
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 > b.length) return undefined;
      const height = u16be(b, i + 5);
      const width = u16be(b, i + 7);
      return orientation >= 5 ? valid(height, width) : valid(width, height);
    }
    i += 2 + length;
  }
  return undefined;
}

/** 文件开头的字节 → 看到的宽高；不认识的格式或字节不够时返回 undefined。 */
export function imageSizeFromBytes(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length >= 8 && u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a) return png(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webp(bytes);
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return gif(bytes);
  return undefined;
}

export type Orientation = "landscape" | "portrait" | "square";

export interface ImageShape extends ImageSize {
  orientation: Orientation;
  /** 常见比例（"4:3"、"9:16"），差得远就写成小数（"1.43:1"）。 */
  ratio: string;
}

const COMMON_RATIOS: Array<[number, number]> = [
  [1, 1], [4, 3], [3, 4], [3, 2], [2, 3], [16, 9], [9, 16], [5, 4], [4, 5], [21, 9], [9, 21], [2, 1], [1, 2],
];

export function imageShape(size: ImageSize): ImageShape {
  const value = size.width / size.height;
  const orientation: Orientation = Math.abs(value - 1) < 0.03 ? "square" : value > 1 ? "landscape" : "portrait";
  const common = COMMON_RATIOS.find(([w, h]) => Math.abs(value - w / h) / (w / h) < 0.02);
  const ratio = common
    ? `${common[0]}:${common[1]}`
    : value >= 1
      ? `${value.toFixed(2)}:1`
      : `1:${(1 / value).toFixed(2)}`;
  return { ...size, orientation, ratio };
}

/** 写给模型看的一句：「1600×1200, landscape (4:3)」。 */
export function describeImageShape(shape: ImageShape): string {
  return `${shape.width}×${shape.height}, ${shape.orientation} (${shape.ratio})`;
}
