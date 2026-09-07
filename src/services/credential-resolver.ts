import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { HttpServerConfig } from "../config.js";
import {
  createRedisLinkedAtlasCredentialStore,
  type LinkedAtlasCredentialStore,
} from "./linked-credential-store.js";
import { createTokenExchanger, TokenExchangeError, type TokenExchanger } from "./token-exchange.js";

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialResolutionError";
  }
}

export interface ResolvedCredential {
  subject: string;
  apiKey: string;
  /**
   * 上游拒绝这份凭据时调用。只有令牌交换模式会给出它——那种模式下凭据是缓存的
   * 短期令牌，被拒说明缓存该丢了；API key 模式没有可丢的东西。
   */
  onRejected?: () => void;
}

export interface AtlasCredentialResolver {
  resolve(authInfo: AuthInfo): Promise<ResolvedCredential>;
  ready?(): Promise<boolean>;
  close?(): Promise<void>;
}

export function authSubject(authInfo: AuthInfo): string {
  const candidate = authInfo.extra?.sub ?? authInfo.extra?.subject;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new CredentialResolutionError("The validated OAuth token has no subject");
  }
  return candidate;
}

export class ConfiguredCredentialResolver implements AtlasCredentialResolver {
  constructor(
    private readonly config: HttpServerConfig,
    private readonly linkedStore?: LinkedAtlasCredentialStore,
    private readonly exchanger?: TokenExchanger
  ) {}

  async resolve(authInfo: AuthInfo): Promise<ResolvedCredential> {
    const subject = authSubject(authInfo);

    // 不用任何 API key：把客户端发来的这枚令牌换成面向模型 API 的令牌，直接当凭据用。
    // 调用方（api-client）只管把它放进 Authorization: Bearer，所以这里返回令牌即可。
    if (this.config.credentialMode === "oauth-exchange") {
      if (!this.exchanger) {
        throw new CredentialResolutionError("Token exchange is not configured");
      }
      const subjectToken = authInfo.token;
      if (!subjectToken) {
        throw new CredentialResolutionError("The validated OAuth token is not available for exchange");
      }
      // 缓存键用 grant identity（grant_id 或 jti）而不是原始令牌：令牌刷新后身份不变，
      // 缓存还能命中；也避免把令牌本身当 map 的键。
      const identity =
        typeof authInfo.extra?.grant_id === "string" ? authInfo.extra.grant_id : subject;
      try {
        const cacheKey = `${subject} ${identity}`;
        const exchanged = await this.exchanger.exchange(subjectToken, cacheKey);
        return {
          subject,
          apiKey: exchanged.accessToken,
          onRejected: () => this.exchanger?.invalidate(cacheKey),
        };
      } catch (error) {
        if (error instanceof TokenExchangeError) {
          throw new CredentialResolutionError(error.message);
        }
        throw error;
      }
    }

    if (this.config.credentialMode === "service-account") {
      const apiKey = this.config.atlasServiceAccountKey;
      if (!apiKey) {
        throw new CredentialResolutionError("Atlas service account is not configured");
      }
      return { subject, apiKey };
    }

    const apiKey = this.config.credentialMode === "redis-subject-map"
      ? await this.linkedStore?.get(subject)
      : this.config.atlasSubjectKeys[subject];
    if (!apiKey) {
      throw new CredentialResolutionError(
        "This OAuth account is not linked to an Atlas Cloud credential"
      );
    }
    return { subject, apiKey };
  }

  async ready(): Promise<boolean> {
    return this.linkedStore ? this.linkedStore.ready() : true;
  }

  async close(): Promise<void> {
    await this.linkedStore?.close();
  }
}

export async function createConfiguredCredentialResolver(
  config: HttpServerConfig
): Promise<ConfiguredCredentialResolver> {
  if (config.credentialMode === "oauth-exchange") {
    // config 已经保证了这几项齐全（缺就在加载配置时报错，不会静默降级）
    return new ConfiguredCredentialResolver(
      config,
      undefined,
      createTokenExchanger(config.tokenExchange!)
    );
  }
  if (config.credentialMode !== "redis-subject-map") {
    return new ConfiguredCredentialResolver(config);
  }
  const store = await createRedisLinkedAtlasCredentialStore(
    config.redisUrl!,
    config.credentialRedisPrefix,
    config.credentialEncryptionKeys
  );
  return new ConfiguredCredentialResolver(config, store);
}
