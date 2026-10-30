import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import net from "node:net";
import { Agent, request } from "undici";

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
export function inputLinks(params: Record<string, unknown>): Array<{ field: string; url: string }> {
  const out: Array<{ field: string; url: string }> = [];
  const visit = (field: string, value: unknown, depth: number): void => {
    if (out.length >= MAX_LINKS || depth > 3) return;
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
    const v6 = address.toLowerCase();
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return (
      v6 === "::" ||
      v6 === "::1" ||
      /^f[cd][0-9a-f]{2}:/.test(v6) ||
      /^fe[89ab][0-9a-f]:/.test(v6) ||
      /^ff[0-9a-f]{2}:/.test(v6)
    );
  }
  return true;
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
  return { status: res.statusCode, contentType: header("content-type").toLowerCase(), location: header("location") || undefined };
}

async function probe(raw: string, allowPrivate: boolean, agent: Agent, timeoutMs: number): Promise<Probe | { reason: string }> {
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
      if (result.status >= 400 || (result.status < 300 && !result.contentType)) {
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
    return { status: result.status, contentType: result.contentType };
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

/** 逐条检查素材链接，返回不能用的那些；全部能用时返回空数组。 */
export async function checkInputLinks(
  params: Record<string, unknown>,
  options: InputLinkCheckOptions = {}
): Promise<InputLinkProblem[]> {
  const links = inputLinks(params);
  if (links.length === 0) return [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowPrivate = options.allowPrivateAddresses === true;
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

/** 写给模型和用户看的说明：哪条不能用、为什么、可以怎么换。不报价、不扣费。 */
export function formatInputLinkProblems(problems: InputLinkProblem[]): string {
  const lines = problems.map((p) => `- ${p.field}: ${p.url} — ${p.reason}.`);
  return [
    `No quote was made and nothing was charged: ${problems.length === 1 ? "this input link can't" : "these input links can't"} be used.`,
    ...lines,
    "A direct link to the file itself (not a web page), an uploaded file, or a file from the Asset Library works instead.",
  ].join("\n");
}
