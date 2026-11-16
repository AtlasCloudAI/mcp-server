/**
 * RFC 8693 令牌交换：把「客户端发给本 MCP server 的令牌」换成「面向模型 API 的令牌」。
 *
 * 为什么必须换而不能直接转发：收到的那枚 `aud` 是本 MCP server 的资源标识，模型 API 校验
 * `aud` 时会拒。契约里也明写禁止转发。
 *
 * 换成功之后，调 Atlas 用的是这枚令牌而不是用户的 API key —— 账单按令牌里的 `account_id`
 * 记，用户不需要粘贴任何东西。这是「登录即可用」的关键一环。
 */
import { Buffer } from "node:buffer";

const REQUEST_TIMEOUT_MS = 10_000;
/** 提前 60 秒过期，避免请求正在途中时令牌刚好失效。 */
const EXPIRY_SKEW_SECONDS = 60;
const MAX_JSON_BYTES = 64 * 1024;

export class TokenExchangeError extends Error {
  constructor(
    message: string,
    readonly oauthError?: string
  ) {
    super(message);
    this.name = "TokenExchangeError";
  }
}

export interface TokenExchangeConfig {
  /** 授权服务器的令牌端点。 */
  url: URL;
  /** 做交换的机密客户端。 */
  clientId: string;
  clientSecret: string;
  /** 目标资源标识（换出令牌的 `aud`）。逐字比对，不要带多余的尾斜杠。 */
  resource: string;
  /**
   * 申请的 scope。留空则由授权服务器按主体令牌的已批准范围收窄——
   * 但两端词表不一致时省略会直接 `invalid_scope`，所以通常要显式给出目标资源那套词表。
   */
  scope?: string;
}

export interface ExchangedToken {
  accessToken: string;
  /** 实际批准的 scope。可能少于请求值，调用方不要假设「请求即批准」。 */
  scope?: string;
  expiresAt: number;
}

export interface TokenExchanger {
  exchange(subjectToken: string, cacheKey: string): Promise<ExchangedToken>;
  /**
   * 丢弃这个身份缓存的令牌，下一次调用会重新交换。
   *
   * 用在模型 API 拒绝了我们换来的令牌时。最常见的原因是用户撤销了授权——授权服务器
   * 那侧撤销是立刻生效的，但我们缓存的令牌还没到期，不清掉就会一直拿废令牌去撞 401
   * 直到自然过期（最长十几分钟）。
   */
  invalidate(cacheKey: string): void;
}

/** 一个副本最多缓存多少份换好的令牌（每份约 1~2KB）。 */
export const MAX_CACHE_ENTRIES = 10_000;

interface CacheEntry {
  token: ExchangedToken;
  inflight?: Promise<ExchangedToken>;
}

export function createTokenExchanger(
  config: TokenExchangeConfig,
  fetcher: typeof fetch = fetch,
  now: () => number = () => Math.floor(Date.now() / 1000)
): TokenExchanger {
  // 按「主体令牌的身份 + 目标资源」缓存。同一个用户在令牌有效期内只换一次，
  // 否则每个工具调用都会打一次令牌端点，很快撞上限流（每个 client_id 60 次/分钟）。
  const cache = new Map<string, CacheEntry>();

  // 缓存键的构造必须只有一处。分隔符是 NUL 而不是空格：cacheKey 里本来就含空格
  // （"<subject> <grant>"），用空格拼会让不同的 (身份, 资源) 组合撞成同一个键。
  // 这个函数刚被抄错过一次——invalidate 里写成了空格，于是删不掉 exchange 写进去的
  // 那一条，缓存永远清不掉。要改分隔符就改这里，两边自然一致。
  const cacheKeyFor = (cacheKey: string): string => `${cacheKey}\0${config.resource}`;

  // 刷新令牌每次换新 jti，旧键不会再被访问：不清就一直留在内存里（11-16 review）。
  // 写入时超过上限先清过期的，还超就从最早写入的开始丢（正在换的不丢）。
  const store = (key: string, entry: CacheEntry): void => {
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size <= MAX_CACHE_ENTRIES) return;
    const at = now();
    for (const [existing, value] of cache) {
      if (!value.inflight && value.token.expiresAt <= at) cache.delete(existing);
    }
    for (const [existing, value] of cache) {
      if (cache.size <= MAX_CACHE_ENTRIES) break;
      if (!value.inflight && existing !== key) cache.delete(existing);
    }
  };

  async function request(subjectToken: string): Promise<ExchangedToken> {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: config.resource,
    });
    if (config.scope) body.set("scope", config.scope);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetcher(config.url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          // 机密客户端用 client_secret_basic。密钥只从部署侧的 Secret 读，不进日志。
          authorization:
            "Basic " +
            Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64"),
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
      });
    } catch (cause) {
      throw new TokenExchangeError("Token exchange request failed", undefined);
    } finally {
      clearTimeout(timer);
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_JSON_BYTES) {
      throw new TokenExchangeError("Token exchange response is too large");
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch {
      throw new TokenExchangeError(
        `Token exchange returned a non-JSON response (HTTP ${response.status})`
      );
    }

    if (!response.ok) {
      const error = typeof parsed.error === "string" ? parsed.error : undefined;
      // invalid_scope 在这条链路上几乎总是同一个原因：请求的 scope 不在主体令牌的已批准
      // 范围内，也就是两端 scope 词表没统一。把它说清楚，省掉一轮排查。
      const hint =
        error === "invalid_scope"
          ? " —— 请求的 scope 不在主体令牌已批准范围内，通常是两端 scope 词表没统一"
          : "";
      throw new TokenExchangeError(
        `Token exchange rejected: ${error ?? `HTTP ${response.status}`}${hint}`,
        error
      );
    }

    const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
    if (!accessToken) {
      throw new TokenExchangeError("Token exchange response has no access_token");
    }
    const expiresIn =
      typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
        ? parsed.expires_in
        : 900;
    return {
      accessToken,
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
      expiresAt: now() + Math.max(0, expiresIn - EXPIRY_SKEW_SECONDS),
    };
  }

  return {
    async exchange(subjectToken, cacheKey) {
      const key = cacheKeyFor(cacheKey);
      const entry = cache.get(key);
      if (entry && entry.token.expiresAt > now()) return entry.token;
      // 并发去重：同一个用户的多个工具调用同时进来时只换一次。
      if (entry?.inflight) return entry.inflight;

      const inflight = request(subjectToken)
        .then((token) => {
          store(key, { token });
          return token;
        })
        .catch((error: unknown) => {
          cache.delete(key);
          throw error;
        });
      store(key, {
        token: { accessToken: "", expiresAt: 0 },
        inflight,
      });
      return inflight;
    },
    invalidate(cacheKey) {
      cache.delete(cacheKeyFor(cacheKey));
    },
  };
}
