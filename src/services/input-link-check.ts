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
      const trimmed = urlPreprocess(value);
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
 * 参数里的链接超过 MAX_GUARDED_LINKS 条、或嵌套超过 MAX_GUARDED_DEPTH 层：整个请求退回。
 * 下面几道检查都只看这个范围以内，原来超出的部分静默放过，把内网地址放在第 65 条或第 9 层就绕过去了，
 * 网关照样会去下载（11-18 上线前审查 M7）。正常请求远到不了这个量。
 */
export function inputLimitProblems(params: Record<string, unknown>): InputLinkProblem[] {
  const links = new Set<string>();
  let tooDeep: string | undefined;
  const visit = (field: string, value: unknown, depth: number): void => {
    if (tooDeep !== undefined || links.size > MAX_GUARDED_LINKS) return;
    if (typeof value === "string") {
      const link = urlPreprocess(value);
      if (/^https?:/i.test(link)) links.add(`${field}\0${link}`);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (depth >= MAX_GUARDED_DEPTH) {
      tooDeep = field;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(field, item, depth + 1);
    } else {
      for (const [key, item] of Object.entries(value)) visit(`${field}.${key}`, item, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(params)) {
    if (key === "model" || TEXT_FIELDS.has(key)) continue;
    visit(key, value, 0);
  }
  if (tooDeep !== undefined) {
    return [
      {
        field: tooDeep,
        url: "",
        reason: `the inputs are nested more than ${MAX_GUARDED_DEPTH} levels deep, which can't be checked; flatten them`,
      },
    ];
  }
  if (links.size > MAX_GUARDED_LINKS) {
    return [
      {
        field: "params",
        url: "",
        reason: `the request has more than ${MAX_GUARDED_LINKS} input links, which can't all be checked; split it into smaller requests`,
      },
    ];
  }
  return [];
}

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
// 素材字段只放行白名单里的协议：http(s)、data:（内联）、asset:// 和 assetd://（资产库、上游资产引用）。
// 原来是黑名单，tcp://、rtsp://、concat:、hls+http://、s3://、URL:http://… 都漏过去了（11-19 第二轮复审）。
const ALLOWED_SOURCE_SCHEMES = new Set(["http", "https", "data", "asset", "assetd"]);
// 别的非文字字段（字段名看不出是素材的）：明确危险的协议、带 + 的组合协议、URL: 前缀、ffmpeg 的协议写法一律退回。
const DANGEROUS_SCHEMES = new Set([
  "file", "gopher", "ftp", "ftps", "sftp", "tftp", "dict", "ldap", "ldaps", "smb", "jar", "netdoc", "unix", "phar",
  "php", "expect", "glob", "ws", "wss", "tcp", "udp", "rtsp", "rtsps", "rtmp", "rtmps", "rtmpt", "rtmpe", "rtp",
  "srtp", "srt", "mms", "mmsh", "mmst", "concat", "concatf", "subfile", "hls", "crypto", "cache", "async", "pipe",
  "fd", "s3", "gs", "gcs", "hdfs", "url", "jdbc", "redis", "mongodb", "mysql", "postgres", "ssh", "telnet", "nfs",
]);
const ANY_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const FFMPEG_PROTOCOL = /^(?:subfile|concat|concatf|crypto|cache|async|pipe|fd)\s*[,:]/i;
const URL_PREFIX = /^<\s*url\s*:|^url\s*:/i;
// 非素材字段里的 //host：IP（点分、十进制、方括号 IPv6）照算；别的主机名后面要跟路径、端口或 ?#，
// 这样 //localhost/x、//intranet/x 拦得住，"//bass.drop"、"//minimal" 这样的风格写法不误拒（第四轮复审）。
const PROTOCOL_RELATIVE_HOST =
  /^[\\/]{2}(?:(?:\d{1,3}(?:\.\d{1,3}){3}|\d{8,10}|\[[0-9a-f:.]+\])(?::\d+)?(?:[\\/?#]|$)|[^\s\\/?#:]+(?::\d+(?:[\\/?#]|$)|[\\/?#]))/i;
const LINKISH = /^<?\s*([a-z][a-z0-9+.-]*)\s*:\s*(?:[\\/.~]|[a-z][a-z0-9+.-]*\s*:)/i;
const URL_PREFIX_LINK = /^<?\s*url\s*:\s*\S+?\s*>?$/i;
// 别的非文字字段里也不该出现的系统路径。
const SENSITIVE_PATH = /^\/(?:etc|proc|sys|dev|root|home|var|usr|tmp|private|Users|opt|run|mnt|srv|boot|lib|bin|sbin)(?:\/|$)/;

/**
 * 这个值是不是指向某个协议或位置、而不是普通取值。
 * - 素材字段：URL: 前缀、ffmpeg 协议写法、危险协议、带 + 的组合协议，以及白名单以外的「协议://」。
 * - 别的非文字字段（字段名看不出是素材，比如 face、garment、target）：同样的判断，但只看不含空白的值。
 *   链接和路径不含空白；「Crypto: neon」「R+B: smooth」「Async, glitchy」这样的风格、标签、台词是普通文字，
 *   原来会被当成协议误拒（11-19 第三轮复审）。这类字段里白名单以外的「协议://」也一律退回。
 */
function schemeProblem(cleaned: string, _source: boolean): boolean {
  // Python urllib 的 unwrap 会去掉 <URL:…> 和 URL: 前缀再去空白，"URL: http://…" 照样是链接：
  // 前缀后面只剩一段不含空白的内容就退回（"URL: what it means" 是普通文字）。
  if (URL_PREFIX_LINK.test(cleaned)) return true;
  // 「协议:」后面紧跟（可隔空白）/ \ . ~ 或另一个「协议:」，就是协议写法，哪怕中间或后面有空白：
  // "concat: /etc/passwd"、"file:/// etc/passwd"、"URL: http://… x"（第四轮复审）。"Concat: the two scenes" 不算。
  const linkish = LINKISH.exec(cleaned);
  if (linkish) {
    const scheme = linkish[1]!.toLowerCase();
    if (scheme === "url" || DANGEROUS_SCHEMES.has(scheme) || scheme.includes("+")) return true;
    const afterColon = cleaned.slice(cleaned.indexOf(":") + 1);
    if (/^\s*[\\/]{2}/.test(afterColon) && !ALLOWED_SOURCE_SCHEMES.has(scheme)) return true;
  }
  // 别的含空白的是文字（素材字段里也有，比如 TTS 的 input），不是链接或协议写法。
  if (/\s/.test(cleaned)) return false;
  if (URL_PREFIX.test(cleaned) || FFMPEG_PROTOCOL.test(cleaned)) return true;
  const scheme = ANY_SCHEME.exec(cleaned)?.[1]?.toLowerCase();
  if (scheme === undefined) return false;
  if (DANGEROUS_SCHEMES.has(scheme) || scheme.includes("+")) return true;
  // 白名单只管「协议://」这种写法：素材字段里也有 en-US:Neural 这样的普通取值（音色编号）。
  return cleaned.slice(scheme.length + 1).startsWith("//") && !ALLOWED_SOURCE_SCHEMES.has(scheme);
}

/**
 * 这个值是不是本机路径。素材字段沿用 LOCAL_PATH；别的非文字字段里不含空白的路径写法也算：
 * 相对路径（../、./、~/）、任何以 / 开头的绝对路径（/app/.env、/data/…，不只是系统目录）、Windows 路径。
 */
function pathProblem(cleaned: string, source: boolean): boolean {
  if (source && /\s/.test(cleaned)) return LOCAL_PATH.test(cleaned) || SENSITIVE_PATH.test(cleaned);
  if (/\s/.test(cleaned)) return false;
  if (SENSITIVE_PATH.test(cleaned)) return true;
  if (!LOCAL_PATH.test(cleaned)) return false;
  // 单段的 /imagine、/ootd、/ 是指令或标签写法，不当路径（第四轮复审）；相对路径、~/、Windows 路径、
  // 两段以上的绝对路径（/app/.env、/data/x.png）照算。
  return !cleaned.startsWith("/") || /^\/[^/]+\/./.test(cleaned);
}
// 本机路径：~/、./、../、Windows 盘符、UNC、以及像路径的绝对路径。base64 的 JPEG 以 "/9j/" 开头，
// base64 的 MP3 可能以 "//" 开头，都不是路径，所以绝对路径只认「/ 后面跟路径字符」且不太长的串。
const LOCAL_PATH = /^(?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)|^\/(?!9j\/|\/)[\w.\-~/%@]{0,511}$/;
// 只看素材类字段：文字字段里的路径是写给模型看的。
const SOURCE_FIELD = /url|uri|file|path|src|source|ref|input|media|asset/i;

function isSourceField(field: string): boolean {
  return expectedKind(field) !== undefined || SOURCE_FIELD.test(field);
}

// ---------- 写得不规整、但下载器照样当网址的值 ----------
// 链接预检只认以 http:// 或 https:// 开头的串。浏览器和不少下载器按 WHATWG URL 规则解析：先去掉
// 首尾的控制字符和空格、删掉中间所有 tab 和换行，http/https 后面的 / 和 \ 一样算，少写斜杠也补上，
// 没有协议的 //host 按当前页面的协议补。所以 http:/169.254.169.254、http:\\169.254.169.254、
// h<tab>ttp://…、//169.254.169.254 在那边都是内网地址，在这边却不算链接，原样送到网关（11-17 实测）。
const MALFORMED_LINK_REASON = "it is not a complete link; write it as https://… with two forward slashes";

// 首尾要去掉的字符：WHATWG URL 解析器去的 C0 控制字符和空格，加上各家下载器 trim 时会去的 Unicode 空白
// （不换行空格、BOM、全角空格、零宽字符等；Go 的 strings.TrimSpace、JS 的 trim 都去其中大部分）。
// 「是不是链接」「链接上限」「内网检查」三处必须用同一个判断：原来上限检查只去 C0、链接收集用 trim()，
// 开头加一个不换行空格的内网链接两边都漏掉（11-19 增量审查 S1）。
const LINK_PADDING = "\\u0000-\\u0020\\u007f-\\u00a0\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u2064\\u3000\\ufeff";
const LINK_PADDING_EDGES = new RegExp(`^[${LINK_PADDING}]+|[${LINK_PADDING}]+$`, "g");
const HAS_LINK_PADDING = new RegExp(`^[${LINK_PADDING}]|[${LINK_PADDING}]$`);
// 只有空白和零宽字符（不含控制字符）：粘贴来的链接首尾常带全角空格、不换行空格，直接去掉照常用。
const LINK_WHITESPACE = "\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u2064\\u3000\\ufeff";
const LINK_WHITESPACE_EDGES = new RegExp(`^[${LINK_WHITESPACE}]+|[${LINK_WHITESPACE}]+$`, "g");
const LINK_WHITESPACE_LEAD = new RegExp(`^[${LINK_WHITESPACE}]+`);
const LINK_WHITESPACE_TRAIL = new RegExp(`[${LINK_WHITESPACE}]+$`);

/**
 * 素材链接首尾只多了空白或零宽字符（中文输入法、网页粘贴常见）：去掉后交给后面的检查和网关，
 * 网关拿到的就是检查过的那个值（11-19 第二轮复审：原来直接退回，用户看不出哪里错了）。
 * 夹着控制字符的不动，交给 localInputValues 退回。文字字段不碰。
 */
export function trimLinkPadding<T extends Record<string, unknown>>(params: T): T {
  const clean = (value: unknown, depth: number): unknown => {
    if (depth > MAX_GUARDED_DEPTH) return value;
    if (typeof value === "string") {
      const stripped = value.replace(LINK_WHITESPACE_EDGES, "");
      if (stripped === value || !/^https?:\/\//i.test(stripped) || HAS_LINK_PADDING.test(stripped)) return value;
      // 首尾只有普通 ASCII 空白时不动：之前的版本照原样收下、按原样算请求指纹，改了会让发布前的报价、
      // 已提交记录对不上（11-19 第三轮复审）。只有带了全角空格、不换行空格这类字符才去掉。
      const padding = (LINK_WHITESPACE_LEAD.exec(value)?.[0] ?? "") + (LINK_WHITESPACE_TRAIL.exec(value)?.[0] ?? "");
      return /[^\x00-\x7f]/.test(padding) ? stripped : value;
    }
    if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item, depth + 1)]));
    }
    return value;
  };
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, key === "model" || TEXT_FIELDS.has(key) ? value : clean(value, 0)])
  ) as T;
}

/** 当作链接判断前的预处理：去掉首尾控制字符和各种空白，删掉所有 tab、换行。 */
function urlPreprocess(value: string): string {
  return value.replace(LINK_PADDING_EDGES, "").replace(/[\t\n\r]/g, "");
}

/** 去掉首尾普通空白（空格、tab、换行）后的原值：用来判断写法是否规整。 */
function plainTrim(value: string): string {
  return value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
}

const BASE64_ONLY = /^[A-Za-z0-9+/=_-]+$/;

/**
 * 以 // 开头、只有 base64 字符的串可能是 base64 编码的 MP3（帧同步字节 0xFF 编码出来就是 "//"）。
 * 只有开头 4 个字节是一个合法的 MP3 帧头才当音频数据放过；否则按「没写协议的网址」处理。
 */
function looksLikeBase64Mp3(value: string): boolean {
  if (!BASE64_ONLY.test(value) || value.length < 8) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value.slice(0, 8).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return false;
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return false;
  const version = (bytes[1]! >> 3) & 0b11;
  const layer = (bytes[1]! >> 1) & 0b11;
  const bitrate = bytes[2]! >> 4;
  const sampleRate = (bytes[2]! >> 2) & 0b11;
  return version !== 0b01 && layer !== 0b00 && bitrate !== 0b1111 && sampleRate !== 0b11;
}

const PADDED_LINK_REASON =
  "it has an invisible character (a control character, no-break space or zero-width space) at its start or end; " +
  "send the plain https:// link without it";
const BACKSLASH_LINK_REASON =
  "it contains a backslash, which link parsers read differently; use forward slashes only (write a literal backslash as %5C)";

/**
 * 这个值是不是「写得不规整的网址」，是的话为什么：http:/x、http:\\x、中间夹 tab 换行、没写协议的 //x；
 * 首尾夹着不可见字符（11-19 S1）；带反斜杠（Python urllib 把 http://a\\@b 的主机读成 b，
 * WHATWG 读成 a，两边对「访问的是哪台主机」理解不一样，11-19 第一轮复审）。
 */
function malformedLinkReason(raw: string, field: string): string | undefined {
  // 只去普通空白：首尾夹着控制字符、不换行空格、零宽字符的链接整条退回，
  // 免得网关和这里对「这是不是链接」理解不一样（11-19 S1）。
  const trimmed = plainTrim(raw);
  const cleaned = urlPreprocess(raw);
  if (/^https?:/i.test(cleaned)) {
    if (HAS_LINK_PADDING.test(trimmed)) return PADDED_LINK_REASON;
    if (!/^https?:\/\//i.test(trimmed)) return MALFORMED_LINK_REASON;
    if (cleaned.includes("\\")) return BACKSLASH_LINK_REASON;
    return undefined;
  }
  // 没写协议的写法（//host/…）：素材字段里一律算；别的非文字字段只看不含空白的值（"// TODO" 是普通文字）。
  if (!/^[\\/]{2}/.test(cleaned)) return undefined;
  // 别的非文字字段：只有 // 后面跟着 IP 或带点的域名才算（"//minimal" 这类风格写法是普通取值）。
  if (!isSourceField(field) && !PROTOCOL_RELATIVE_HOST.test(cleaned)) return undefined;
  // base64 的 MP3 只会出现在音频字段；单段主机名（//backend/…）解码后也可能碰巧像帧头，
  // 所以别的素材字段不放这个口子。
  return expectedKind(field) === "audio" && looksLikeBase64Mp3(cleaned) ? undefined : MALFORMED_LINK_REASON;
}

/**
 * 素材字段里写成本机路径或非 http 协议的值（file:///etc/passwd、/etc/passwd、gopher://…）。
 * 这些值链接预检从来不看（它只认 http/https），却会原样送到网关；后端下载器只要开着本地路径或
 * 认这些协议，就是读服务器上的文件（11-16 安全审查 M2）。
 * 另外，任何非文字字段里写得不规整的网址（http:/x、http:\x、夹 tab 换行；素材字段里还有没写协议的 //x）
 * 一律退回，让用户写成完整的 https:// 链接，免得绕过下面的内网检查（11-17）。
 */
export function localInputValues(params: Record<string, unknown>): InputLinkProblem[] {
  const out: InputLinkProblem[] = [];
  const visit = (field: string, value: unknown, depth: number): void => {
    if (out.length >= MAX_GUARDED_LINKS || depth > MAX_GUARDED_DEPTH) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      // 协议和路径按和链接一样的规则去首尾（控制字符、Unicode 空白）：原来用 trim()，
      // "\x01file:///etc/passwd" 不算本机协议，Python、WHATWG 解析器去掉控制字符后却是 file:（11-19 复审）。
      const cleaned = urlPreprocess(value);
      const source = isSourceField(field);
      const malformed = malformedLinkReason(value, field);
      if (schemeProblem(cleaned, source)) {
        out.push({ field, url: trimmed, reason: "only http and https links can be used" });
      } else if (pathProblem(cleaned, source)) {
        out.push({ field, url: trimmed, reason: "it is a file path, not a link; upload the file first" });
      } else if (malformed) {
        out.push({ field, url: trimmed, reason: malformed });
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
  const overLimit = inputLimitProblems(params);
  if (overLimit.length > 0) return overLimit;
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
  const lines = problems.map((p) => `- ${p.field}${p.url ? `: ${p.url}` : ""} — ${p.reason}.`);
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
