import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import {
  decryptAtlasCredential,
  encryptAtlasCredential,
  type CredentialEncryptionKey,
} from "./credential-envelope.js";

export const LINKED_CREDENTIAL_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface LinkedAtlasCredentialStore {
  get(subject: string): Promise<string | undefined>;
  put(subject: string, apiKey: string): Promise<void>;
  delete(subject: string): Promise<void>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export class RedisLinkedAtlasCredentialStore implements LinkedAtlasCredentialStore {
  constructor(
    private readonly client: RedisClientType,
    private readonly prefix: string,
    private readonly keyring: readonly CredentialEncryptionKey[],
    private readonly ownsClient: boolean = false
  ) {}

  private recordKey(subject: string): string {
    const digest = createHash("sha256").update(subject).digest("hex");
    return `${this.prefix}:${digest}`;
  }

  async get(subject: string): Promise<string | undefined> {
    const envelope = await this.client.get(this.recordKey(subject));
    return envelope === null
      ? undefined
      : decryptAtlasCredential(subject, envelope, this.keyring);
  }

  async put(subject: string, apiKey: string): Promise<void> {
    const envelope = encryptAtlasCredential(subject, apiKey, this.keyring);
    await this.client.set(this.recordKey(subject), envelope, {
      EX: LINKED_CREDENTIAL_TTL_SECONDS,
    });
  }

  async delete(subject: string): Promise<void> {
    await this.client.del(this.recordKey(subject));
  }

  async ready(): Promise<boolean> {
    return (await this.client.ping()) === "PONG";
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.client.isOpen) await this.client.quit();
  }
}

export async function createRedisLinkedAtlasCredentialStore(
  url: string,
  prefix: string,
  keyring: readonly CredentialEncryptionKey[]
): Promise<RedisLinkedAtlasCredentialStore> {
  const client: RedisClientType = createClient({ url });
  client.on("error", (error: Error) => {
    console.error(`Redis linked-credential store error: ${error.message}`);
  });
  await client.connect();
  return new RedisLinkedAtlasCredentialStore(client, prefix, keyring, true);
}
