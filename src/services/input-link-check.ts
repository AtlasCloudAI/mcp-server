import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import net from "node:net";
import { Agent, request } from "undici";
import { IMAGE_HEADER_BYTES, type ImageShape, imageShape, imageSizeFromBytes } from "./image-size.js";

/**
 * 素材链接报价前先检查（一期需求文档 5.2：素材链接要「检查能否访问，以及是否满足模型要求；
 * 不可用时提示更换」；素材失效或无法访问时「标明具体素材不可用，让用户重新选择；不静默忽略」）。
 *
 * 报价之前对参数里每个 http(s) 链接先探一次：HEAD，不行再退回只取第一个字节的 GET。看三件事：
 * 能不能打开（2xx）、是不是文件而不是网页、类型和字段对不对得上（视频字段给了图片之类）。
 * 有一条不行就不报价，逐条写明是哪个字段的哪条链接、为什么。模型对分辨率、时长的要求要下载
 * 文件才看得出，这里不判，留给网关。
 *
 * 这是服务端替用户去访问任意地址，所以必须挡住内网：连接前把域名解析出的每个地址都核一遍，
 * 回环、私有、链路本地、CGNAT、组播等网段一律拒绝；写成 IP 的地址同样判；重定向逐跳重判，
 * 最多 3 跳。
 */

export interface InputLinkProblem {
  field: string;
  url: string;
  reason: string;
}

export interface InputLinkCheckOptions {
  /** 只给测试用：允许本机和内网地址（测试的假服务起在 127.0.0.1）。 */
  allowPrivateAddresses?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const MAX_LINKS = 8;

// 文字字段里的链接是用户写给模型看的，不是素材。
const TEXT_FIELDS = new Set(["prompt", "negative_prompt", "user_prompt", "text", "lyrics", "system_prompt"]);

/** MCP_INPUT_LINK_CHECK=off 时不检查（本机走代理、DNS 被改写成保留网段时会全部误判）。 */
export function inputLinkCheckEnabled(): boolean {
  return (process.env.MCP_INPUT_LINK_CHECK ?? "").trim().toLowerCase() !== "off";
}

/** 取参数里的素材链接：字段名 + 链接，按出现顺序去重，最多 8 条。 */
export function inputLinks(
  params: Record<string, unknown>,
  limits: { maxLinks?: number; maxDepth?: number } = {}
): Array<{ field: string; url: string }> {
  const maxLinks = limits.maxLinks ?? MAX_LINKS;
  const maxDepth = limits.maxDepth ?? 3;
  const out: Array<{ field: string; url: string }> = [];
  const visit = (field: string, value: unknown, depth: number): void => {
    if (out.length >= maxLinks || depth > maxDepth) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      // 按「字段 + 链接」去重：同一个链接放在图片和视频两个字段里，两边的要求不一样，都要判。
      if (/^https?:\/\//i.test(trimmed) && !out.some((l) => l.url === trimmed && l.field === field)) out.push({ field, url: trimmed });
    } else if (Array.isArray(value)) {
      for (const item of value) visit(field, item, depth + 1);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) visit(`${field}.${key}`, item, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(params)) {
    if (key === "model" || TEXT_FIELDS.has(key)) continue;
    visit(key, value, 0);
  }
  return out;
}

/** 按字段名猜这个字段要的媒体类型；猜不出返回 undefined，只要求「是文件不是网页」。 */
export function expectedKind(field: string): "image" | "video" | "audio" | undefined {
  const name = field.toLowerCase();
  if (/video/.test(name)) return "video";
  if (/audio|voice|speech|music|sound|song/.test(name)) return "audio";
  if (/image|img|photo|picture|frame|mask|logo|avatar/.test(name)) return "image";
  return undefined;
}

/** 回环、私有、链路本地、CGNAT、组播、保留网段——服务端不该替用户去连的地址。 */
export function isBlockedAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return true;
    // 内嵌 IPv4 的写法按里面那个 IPv4 判：URL 会把 [::ffff:127.0.0.1] 规范成 ::ffff:7f00:1，
    // 只认点分写法的话内网地址就漏过去了。
    const embedded = embeddedIpv4(groups);
    if (embedded) return isBlockedAddress(embedded);
    const first = groups[0]!;
    return (
      groups.every((group) => group === 0) || // ::
      (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) || // ::1
      (first & 0xfe00) === 0xfc00 || // fc00::/7 唯一本地
      (first & 0xffc0) === 0xfe80 || // fe80::/10 链路本地
      (first & 0xff00) === 0xff00 // ff00::/8 组播
    );
  }
  return true;
}

/** 把 IPv6 地址展开成 8 个 16 位整数；末尾是点分 IPv4 的写法也认。解析不了返回 undefined。 */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (net.isIP(dotted[2]!) !== 4) return undefined;
    const [a, b, c, d] = dotted[2]!.split(".").map(Number) as [number, number, number, number];
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
}

/** IPv4 映射（::ffff:0:0/96）、IPv4 兼容（::/96）、NAT64（64:ff9b::/96）、6to4（2002::/16）里的那个 IPv4。 */
function embeddedIpv4(groups: number[]): string | undefined {
  const quad = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  if (zeros(0, 5) && groups[5] === 0xffff) return quad(groups[6]!, groups[7]!);
  if (zeros(0, 6) && (groups[6] !== 0 || groups[7]! > 1)) return quad(groups[6]!, groups[7]!);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) return quad(groups[6]!, groups[7]!);
  if (groups[0] === 0x2002) return quad(groups[1]!, groups[2]!);
  return undefined;
}

class BlockedAddressError extends Error {}

function guardedAgent(allowPrivate: boolean, timeoutMs: number): Agent {
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup(hostname, options, callback) {
        dnsLookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
          if (err) return callback(err, "", 4);
          if (!allowPrivate && addresses.some((a) => isBlockedAddress(a.address))) {
            return callback(new BlockedAddressError(hostname), "", 4);
          }
          const first = addresses[0];
          if (!first) return callback(new Error(`no address for ${hostname}`), "", 4);
          if ((options as { all?: boolean }).all) {
            return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
          }
          return callback(null, first.address, first.family);
        });
      },
    },
  });
}

interface Probe {
  status: number;
  contentType: string;
  /** Content-Length 响应头；没有或不是数字时 undefined。 */
  contentLength?: number;
}

async function probeOnce(url: URL, method: "HEAD" | "GET", agent: Agent, timeoutMs: number): Promise<Probe & { location?: string }> {
  const res = await request(url, {
    method,
    dispatcher: agent,
    headers: method === "GET" ? { range: "bytes=0-0", "user-agent": "AtlasCloud-MCP-LinkCheck/1.0" } : { "user-agent": "AtlasCloud-MCP-LinkCheck/1.0" },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    maxRedirections: 0,
  } as Parameters<typeof request>[1]);
  // 只要响应头。正文用 dump 丢掉：最多读 64 KB（服务器无视 Range、整个文件往回推时就此截断），
  // 不像 destroy 那样把「主动中止」当错误抛出来。
  await res.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
  const header = (name: string): string => {
    const v = res.headers[name];
    return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  };
  const length = Number(header("content-length"));
  return {
    status: res.statusCode,
    contentType: header("content-type").toLowerCase(),
    ...(header("content-length") !== "" && Number.isSafeInteger(length) && length >= 0 ? { contentLength: length } : {}),
    location: header("location") || undefined,
  };
}

async function probe(
  raw: string,
  allowPrivate: boolean,
  agent: Agent,
  timeoutMs: number,
  options: { headOnly?: boolean } = {}
): Promise<Probe | { reason: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: "it is not a valid link" };
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return { reason: "only http and https links can be used" };
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && (host === "localhost" || (net.isIP(host) && isBlockedAddress(host)))) {
      return { reason: "it points to a private or local address, which Atlas cannot reach" };
    }
    let result: Probe & { location?: string };
    try {
      result = await probeOnce(url, "HEAD", agent, timeoutMs);
      // 有些存储不接 HEAD（405、403），或者 HEAD 不给类型：退回只取一个字节的 GET 再看一次。
      if (!options.headOnly && (result.status >= 400 || (result.status < 300 && !result.contentType))) {
        result = await probeOnce(url, "GET", agent, timeoutMs);
      }
    } catch (err) {
      if (err instanceof BlockedAddressError || (err as { cause?: unknown })?.cause instanceof BlockedAddressError) {
        return { reason: "it points to a private or local address, which Atlas cannot reach" };
      }
      const code = (err as { code?: string })?.code ?? "";
      if (/TIMEOUT/i.test(code)) return { reason: "it did not respond in time" };
      if (code === "ENOTFOUND") return { reason: "its host name could not be found" };
      return { reason: "it could not be opened" };
    }
    if (result.status >= 300 && result.status < 400 && result.location) {
      url = new URL(result.location, url);
      continue;
    }
    return {
      status: result.status,
      contentType: result.contentType,
      ...(result.contentLength !== undefined ? { contentLength: result.contentLength } : {}),
    };
  }
  return { reason: "it redirects too many times" };
}

function judge(field: string, found: Probe): string | undefined {
  if (found.status === 401 || found.status === 403) return `it is not publicly accessible (HTTP ${found.status})`;
  if (found.status === 404 || found.status === 410) return `the file is not there anymore (HTTP ${found.status})`;
  if (found.status >= 300) return `it could not be opened (HTTP ${found.status})`;
  const type = found.contentType.split(";")[0]!.trim();
  if (type.startsWith("text/") || type === "application/json" || type === "application/xhtml+xml") {
    return `it is a web page (${type}), not a media file`;
  }
  const kind = expectedKind(field);
  const generic = !type || type === "application/octet-stream" || type === "binary/octet-stream";
  if (kind && !generic && /^(image|video|audio)\//.test(type) && !type.startsWith(`${kind}/`)) {
    return `it is ${type.split("/")[0] === "image" ? "an" : "a"} ${type.split("/")[0]} file, but ${field} needs ${kind === "image" ? "an" : "a"} ${kind}`;
  }
  return undefined;
}

const PRIVATE_REASON = "it points to a private or local address, which Atlas cannot reach";
// 只挡内网时最多看多少条、嵌多深：参数里本来就不会有这么多链接。
const MAX_GUARDED_LINKS = 64;
const MAX_GUARDED_DEPTH = 8;

const UNRESOLVED_REASON = "its host name could not be found";

/**
 * 主机名解析的结果：有内网地址、全是公网地址、还是解析不出来。
 *
 * 解析不出来不能当作「不是内网」放过去：只在后端内网 DNS 里才有的名字（*.internal…），
 * 在 MCP 这边查不到，到了网关那边却解析成内网地址（11-16 安全审查 M2）。
 */
async function resolveHost(hostname: string, timeoutMs: number): Promise<"private" | "public" | "unresolved"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("unresolved"), timeoutMs);
    dnsLookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
      clearTimeout(timer);
      if (err || addresses.length === 0) resolve("unresolved");
      else resolve(addresses.some((a) => isBlockedAddress(a.address)) ? "private" : "public");
    });
  });
}

/** 探测上限之外的链接（以及嵌得更深的）：指向内网的、解析不出来的都报出来。 */
async function privateLinksBeyondProbe(params: Record<string, unknown>, timeoutMs: number): Promise<InputLinkProblem[]> {
  const probed = new Set(inputLinks(params).map((link) => `${link.field}\0${link.url}`));
  const rest = inputLinks(params, { maxLinks: MAX_GUARDED_LINKS, maxDepth: MAX_GUARDED_DEPTH }).filter(
    (link) => !probed.has(`${link.field}\0${link.url}`)
  );
  const results = await Promise.all(
    rest.map(async ({ field, url }) => {
      let host: string;
      try {
        host = new URL(url).hostname.replace(/^\[|\]$/g, "");
      } catch {
        return { field, url, reason: "it is not a valid link" };
      }
      if (host === "localhost") return { field, url, reason: PRIVATE_REASON };
      if (net.isIP(host)) return isBlockedAddress(host) ? { field, url, reason: PRIVATE_REASON } : undefined;
      const resolved = await resolveHost(host, Math.min(timeoutMs, 2_000));
      if (resolved === "private") return { field, url, reason: PRIVATE_REASON };
      if (resolved === "unresolved") return { field, url, reason: UNRESOLVED_REASON };
      return undefined;
    })
  );
  return results.filter((r): r is InputLinkProblem => r !== undefined);
}

// ---------- 不是网址的素材值 ----------

// 网关和下载器认得、但服务端绝不该替用户去读的写法：本机文件和各种非 http 协议。
// data:（内联）、assetd:// 和 asset://（资产库、上游资产引用）是正常写法，不在这里。
const LOCAL_SCHEMES = /^(?:file|gopher|ftp|ftps|sftp|tftp|dict|ldap|ldaps|smb|jar|netdoc|unix|phar|php|expect|glob|ws|wss):/i;
// 本机路径：~/、./、../、Windows 盘符、UNC、以及像路径的绝对路径。base64 的 JPEG 以 "/9j/" 开头，
// base64 的 MP3 可能以 "//" 开头，都不是路径，所以绝对路径只认「/ 后面跟路径字符」且不太长的串。
const LOCAL_PATH = /^(?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)|^\/(?!9j\/|\/)[\w.\-~/%@]{0,511}$/;
// 只看素材类字段：文字字段里的路径是写给模型看的。
const SOURCE_FIELD = /url|uri|file|path|src|source|ref|input|media|asset/i;

function isSourceField(field: string): boolean {
  return expectedKind(field) !== undefined || SOURCE_FIELD.test(field);
}

/**
 * 素材字段里写成本机路径或非 http 协议的值（file:///etc/passwd、/etc/passwd、gopher://…）。
 * 这些值链接预检从来不看（它只认 http/https），却会原样送到网关；后端下载器只要开着本地路径或
 * 认这些协议，就是读服务器上的文件（11-16 安全审查 M2）。
 */
export function localInputValues(params: Record<string, unknown>): InputLinkProblem[] {
  const out: InputLinkProblem[] = [];
  const visit = (field: string, value: unknown, depth: number): void => {
    if (out.length >= MAX_GUARDED_LINKS || depth > MAX_GUARDED_DEPTH) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!isSourceField(field)) return;
      if (LOCAL_SCHEMES.test(trimmed)) {
        out.push({ field, url: trimmed, reason: "only http and https links can be used" });
      } else if (LOCAL_PATH.test(trimmed)) {
        out.push({ field, url: trimmed, reason: "it is a file path, not a link; upload the file first" });
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(field, item, depth + 1);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) visit(`${field}.${key}`, item, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(params)) {
    if (key === "model" || TEXT_FIELDS.has(key)) continue;
    visit(key, value, 0);
  }
  return out;
}

/** 逐条检查素材链接，返回不能用的那些；全部能用时返回空数组。 */
export async function checkInputLinks(
  params: Record<string, unknown>,
  options: InputLinkCheckOptions = {}
): Promise<InputLinkProblem[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowPrivate = options.allowPrivateAddresses === true;
  const local = localInputValues(params);
  if (local.length > 0) return local;
  // 只完整探前 8 条；更多的、嵌得更深的也要挡内网（只解析地址，不连），
  // 不然把内网地址放在第 9 条就绕过去了，网关照样会去下载它（11-16 review）。
  if (!allowPrivate) {
    const blocked = await privateLinksBeyondProbe(params, timeoutMs);
    if (blocked.length > 0) return blocked;
  }
  const links = inputLinks(params);
  if (links.length === 0) return [];
  const agent = guardedAgent(allowPrivate, timeoutMs);
  // 同一个链接只探一次，结果给用到它的每个字段共用。
  const probes = new Map<string, ReturnType<typeof probe>>();
  const probeOnceFor = (url: string) => {
    let pending = probes.get(url);
    if (!pending) {
      pending = probe(url, allowPrivate, agent, timeoutMs);
      probes.set(url, pending);
    }
    return pending;
  };
  try {
    const results = await Promise.all(
      links.map(async ({ field, url }) => {
        const found = await probeOnceFor(url);
        const reason = "reason" in found ? found.reason : judge(field, found);
        return reason ? { field, url, reason } : undefined;
      })
    );
    return results.filter((r): r is InputLinkProblem => r !== undefined);
  } finally {
    await agent.close().catch(() => undefined);
  }
}

/**
 * 外部媒体地址还能不能打开（结果卡的过期检查）：true 能打开，false 明确 403/404/410，null 说不准。
 * 地址来自上游模型，探之前和素材预检一样挡内网（字面量和 DNS 解析结果都查），跳转逐跳重查，不走代理。
 */
export async function publicUrlStillServes(
  raw: string,
  timeoutMs = 3_000,
  options: { allowPrivate?: boolean } = {}
): Promise<boolean | null> {
  const allowPrivate = options.allowPrivate === true;
  const agent = guardedAgent(allowPrivate, timeoutMs);
  try {
    const found = await probe(raw, allowPrivate, agent, timeoutMs);
    if ("reason" in found) return null;
    if (found.status >= 200 && found.status < 300) return true;
    return [403, 404, 410].includes(found.status) ? false : null;
  } catch {
    return null;
  } finally {
    await agent.close().catch(() => undefined);
  }
}

/**
 * 产出文件的字节数（下载完整性检查用），读不到返回 null。和 publicUrlStillServes 一样挡内网、
 * 逐跳重判重定向；只发 HEAD。原来的实现用全局 fetch，自动跟随重定向、不挡内网（11-16 安全审查 L1）。
 */
export async function publicContentLength(
  raw: string,
  timeoutMs = 3_000,
  options: { allowPrivate?: boolean } = {}
): Promise<number | null> {
  const allowPrivate = options.allowPrivate === true;
  const agent = guardedAgent(allowPrivate, timeoutMs);
  try {
    const found = await probe(raw, allowPrivate, agent, timeoutMs, { headOnly: true });
    if ("reason" in found || found.status < 200 || found.status >= 300) return null;
    return found.contentLength && found.contentLength > 0 ? found.contentLength : null;
  } catch {
    return null;
  } finally {
    await agent.close().catch(() => undefined);
  }
}

/** 写给模型和用户看的说明：哪条不能用、为什么、可以怎么换。不报价、不扣费。 */
export function formatInputLinkProblems(problems: InputLinkProblem[]): string {
  const lines = problems.map((p) => `- ${p.field}: ${p.url} — ${p.reason}.`);
  return [
    `No quote was made and nothing was charged: ${problems.length === 1 ? "this input link can't" : "these input links can't"} be used.`,
    ...lines,
    "A direct link to the file itself (not a web page), an uploaded file, or a file from the Asset Library works instead.",
  ].join("\n");
}

// ---------- 图片宽高 ----------

const MAX_SHAPE_LINKS = 4;
const SHAPE_TIMEOUT_MS = 3000;

/** 取开头 128 KB（Range 请求），挡内网、逐跳重判重定向和上面一样。读不到返回 undefined。 */
async function readHead(raw: string, allowPrivate: boolean, agent: Agent, timeoutMs: number): Promise<Uint8Array | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && (host === "localhost" || (net.isIP(host) && isBlockedAddress(host)))) return undefined;
    const res = await request(url, {
      method: "GET",
      dispatcher: agent,
      headers: { range: `bytes=0-${IMAGE_HEADER_BYTES - 1}`, "user-agent": "AtlasCloud-MCP-LinkCheck/1.0" },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      maxRedirections: 0,
    } as Parameters<typeof request>[1]);
    if (res.statusCode >= 300) {
      const location = res.headers.location;
      await res.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
      const next = Array.isArray(location) ? location[0] : location;
      if (res.statusCode >= 400 || !next) return undefined;
      url = new URL(next, url);
      continue;
    }
    // 服务器无视 Range、整个文件往回推时，读够就停（跳出循环会关掉连接）。
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk as Buffer);
      total += (chunk as Buffer).length;
      if (total >= IMAGE_HEADER_BYTES) break;
    }
    return Buffer.concat(chunks).subarray(0, IMAGE_HEADER_BYTES);
  }
  return undefined;
}

/** 几张图片地址 → 各自的宽高和横竖；读不出的不在结果里。 */
export async function readImageShapes(urls: string[], options: InputLinkCheckOptions = {}): Promise<Map<string, ImageShape>> {
  const unique = [...new Set(urls)].slice(0, MAX_SHAPE_LINKS);
  const shapes = new Map<string, ImageShape>();
  if (unique.length === 0) return shapes;
  const timeoutMs = options.timeoutMs ?? SHAPE_TIMEOUT_MS;
  const allowPrivate = options.allowPrivateAddresses === true;
  const agent = guardedAgent(allowPrivate, timeoutMs);
  try {
    await Promise.all(
      unique.map(async (url) => {
        try {
          const head = await readHead(url, allowPrivate, agent, timeoutMs);
          const size = head ? imageSizeFromBytes(head) : undefined;
          if (size) shapes.set(url, imageShape(size));
        } catch {
          // 读不出就不写宽高，别的照常。
        }
      })
    );
    return shapes;
  } finally {
    await agent.close().catch(() => undefined);
  }
}

export interface InputImageShape extends ImageShape {
  field: string;
}

/** 参数里图片字段的宽高（视频报价告诉模型出片会是什么形状）。 */
export async function inputImageShapes(
  params: Record<string, unknown>,
  options: InputLinkCheckOptions = {}
): Promise<InputImageShape[]> {
  const links = inputLinks(params).filter((link) => expectedKind(link.field) === "image");
  const shapes = await readImageShapes(links.map((link) => link.url), options);
  return links.flatMap((link) => {
    const shape = shapes.get(link.url);
    return shape ? [{ field: link.field, ...shape }] : [];
  });
}
