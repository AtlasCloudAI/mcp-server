import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

export interface CredentialEncryptionKey {
  kid: string;
  key: Buffer;
}

const base64url = /^[A-Za-z0-9_-]+$/;
const keyConfigSchema = z
  .array(
    z
      .object({
        kid: z.string().regex(/^[A-Za-z0-9._-]{8,64}$/),
        key: z.string().regex(base64url),
      })
      .strict()
  )
  .min(1)
  .max(4);

const envelopeSchema = z
  .object({
    v: z.literal(1),
    kid: z.string().regex(/^[A-Za-z0-9._-]{8,64}$/),
    iv: z.string().regex(base64url),
    ciphertext: z.string().regex(base64url),
    tag: z.string().regex(base64url),
  })
  .strict();

function decodeCanonicalBase64url(value: string, name: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw new Error(`${name} must use canonical base64url encoding`);
  }
  return decoded;
}

export function parseCredentialEncryptionKeys(raw: string): CredentialEncryptionKey[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Credential encryption keys must contain valid JSON");
  }
  const parsed = keyConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Credential encryption keys must be a bounded keyring with valid key IDs");
  }
  if (new Set(parsed.data.map(({ kid }) => kid)).size !== parsed.data.length) {
    throw new Error("Credential encryption keys contain duplicate key IDs");
  }
  return parsed.data.map(({ kid, key }) => {
    const decoded = decodeCanonicalBase64url(key, `Credential encryption key ${kid}`);
    if (decoded.length !== 32) {
      throw new Error(`Credential encryption key ${kid} must be exactly 32-byte AES-256 material`);
    }
    return { kid, key: Buffer.from(decoded) };
  });
}

function associatedData(subject: string): Buffer {
  if (subject.length < 1 || subject.length > 512) {
    throw new Error("OAuth subject is outside the credential-envelope boundary");
  }
  return Buffer.from(`atlascloud-credential:v1:${subject}`, "utf8");
}

export function encryptAtlasCredential(
  subject: string,
  apiKey: string,
  keyring: readonly CredentialEncryptionKey[]
): string {
  if (apiKey.length < 1 || apiKey.length > 4096) {
    throw new Error("Atlas credential is outside the supported length boundary");
  }
  const primary = keyring[0];
  if (!primary || primary.key.length !== 32) {
    throw new Error("A valid primary credential encryption key is required");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", primary.key, iv, { authTagLength: 16 });
  cipher.setAAD(associatedData(subject));
  const ciphertext = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    kid: primary.kid,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
  });
}

export function decryptAtlasCredential(
  subject: string,
  envelope: string,
  keyring: readonly CredentialEncryptionKey[]
): string {
  try {
    const parsed = envelopeSchema.parse(JSON.parse(envelope));
    const key = keyring.find(({ kid }) => kid === parsed.kid);
    if (!key || key.key.length !== 32) throw new Error("unknown credential key ID");
    const iv = decodeCanonicalBase64url(parsed.iv, "Credential envelope IV");
    const ciphertext = decodeCanonicalBase64url(
      parsed.ciphertext,
      "Credential envelope ciphertext"
    );
    const tag = decodeCanonicalBase64url(parsed.tag, "Credential envelope tag");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 4096) {
      throw new Error("invalid credential envelope boundaries");
    }
    const decipher = createDecipheriv("aes-256-gcm", key.key, iv, { authTagLength: 16 });
    decipher.setAAD(associatedData(subject));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const apiKey = plaintext.toString("utf8");
    if (apiKey.length < 1 || apiKey.length > 4096) {
      throw new Error("invalid decrypted credential boundary");
    }
    return apiKey;
  } catch {
    throw new Error("Unable to decrypt Atlas credential");
  }
}
