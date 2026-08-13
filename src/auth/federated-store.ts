import { createHash } from "node:crypto";
import type { RedisClientType } from "redis";
import { z } from "zod";
import { LINKED_CREDENTIAL_TTL_SECONDS } from "../services/linked-credential-store.js";

export interface FederatedAccount {
  sub: string;
  email: string;
  name: string;
}

export interface UpstreamAuthorizationState {
  interactionUid: string;
  nonce: string;
  codeVerifier: string;
}

export interface CredentialLinkTicket {
  interactionUid: string;
  subject: string;
}

export interface FederatedIdentityStore {
  getAccount(subject: string): Promise<FederatedAccount | undefined>;
  putAccount(account: FederatedAccount): Promise<void>;
  beginUpstreamAuthorization(
    state: string,
    value: UpstreamAuthorizationState,
    ttlSeconds: number
  ): Promise<void>;
  consumeUpstreamAuthorization(state: string): Promise<UpstreamAuthorizationState | undefined>;
  beginCredentialLink(
    ticket: string,
    value: CredentialLinkTicket,
    ttlSeconds: number
  ): Promise<void>;
  getCredentialLink(ticket: string): Promise<CredentialLinkTicket | undefined>;
  consumeCredentialLink(ticket: string): Promise<CredentialLinkTicket | undefined>;
}

const token = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const accountSchema = z
  .object({
    sub: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/),
    email: z.string().email().max(254),
    name: z.string().trim().min(1).max(128),
  })
  .strict();
const upstreamStateSchema = z
  .object({
    interactionUid: z.string().min(1).max(256),
    nonce: token,
    codeVerifier: token,
  })
  .strict();
const linkTicketSchema = z
  .object({
    interactionUid: z.string().min(1).max(256),
    subject: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/),
  })
  .strict();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseStored<T>(raw: string | null, schema: z.ZodType<T>, label: string): T | undefined {
  if (raw === null) return undefined;
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new Error(`Stored ${label} record is invalid`);
  }
}

export class RedisFederatedIdentityStore implements FederatedIdentityStore {
  constructor(
    private readonly client: RedisClientType,
    private readonly prefix: string
  ) {}

  private accountKey(subject: string): string {
    return `${this.prefix}:federated-account:${digest(subject)}`;
  }

  private authorizationKey(state: string): string {
    return `${this.prefix}:upstream-state:${digest(state)}`;
  }

  private linkKey(ticket: string): string {
    return `${this.prefix}:credential-link:${digest(ticket)}`;
  }

  async getAccount(subject: string): Promise<FederatedAccount | undefined> {
    return parseStored(
      await this.client.get(this.accountKey(subject)),
      accountSchema,
      "federated account"
    );
  }

  async putAccount(account: FederatedAccount): Promise<void> {
    const parsed = accountSchema.parse(account);
    await this.client.set(this.accountKey(parsed.sub), JSON.stringify(parsed), {
      EX: LINKED_CREDENTIAL_TTL_SECONDS,
    });
  }

  async beginUpstreamAuthorization(
    state: string,
    value: UpstreamAuthorizationState,
    ttlSeconds: number
  ): Promise<void> {
    token.parse(state);
    const record = upstreamStateSchema.parse(value);
    const result = await this.client.set(
      this.authorizationKey(state),
      JSON.stringify(record),
      { EX: ttlSeconds, NX: true }
    );
    if (result !== "OK") throw new Error("Unable to reserve upstream OIDC state");
  }

  async consumeUpstreamAuthorization(
    state: string
  ): Promise<UpstreamAuthorizationState | undefined> {
    token.parse(state);
    return parseStored(
      await this.client.getDel(this.authorizationKey(state)),
      upstreamStateSchema,
      "upstream OIDC state"
    );
  }

  async beginCredentialLink(
    ticket: string,
    value: CredentialLinkTicket,
    ttlSeconds: number
  ): Promise<void> {
    token.parse(ticket);
    const record = linkTicketSchema.parse(value);
    const result = await this.client.set(
      this.linkKey(ticket),
      JSON.stringify(record),
      { EX: ttlSeconds, NX: true }
    );
    if (result !== "OK") throw new Error("Unable to reserve credential-link ticket");
  }

  async getCredentialLink(ticket: string): Promise<CredentialLinkTicket | undefined> {
    token.parse(ticket);
    return parseStored(
      await this.client.get(this.linkKey(ticket)),
      linkTicketSchema,
      "credential-link ticket"
    );
  }

  async consumeCredentialLink(ticket: string): Promise<CredentialLinkTicket | undefined> {
    token.parse(ticket);
    return parseStored(
      await this.client.getDel(this.linkKey(ticket)),
      linkTicketSchema,
      "credential-link ticket"
    );
  }
}
