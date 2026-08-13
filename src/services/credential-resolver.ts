import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { HttpServerConfig } from "../config.js";
import {
  createRedisLinkedAtlasCredentialStore,
  type LinkedAtlasCredentialStore,
} from "./linked-credential-store.js";

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialResolutionError";
  }
}

export interface AtlasCredentialResolver {
  resolve(authInfo: AuthInfo): Promise<{ subject: string; apiKey: string }>;
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
    private readonly linkedStore?: LinkedAtlasCredentialStore
  ) {}

  async resolve(authInfo: AuthInfo): Promise<{ subject: string; apiKey: string }> {
    const subject = authSubject(authInfo);
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
