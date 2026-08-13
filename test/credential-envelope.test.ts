import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  decryptAtlasCredential,
  encryptAtlasCredential,
  parseCredentialEncryptionKeys,
  type CredentialEncryptionKey,
} from "../src/services/credential-envelope.js";

function key(kid: string): CredentialEncryptionKey {
  return { kid, key: randomBytes(32) };
}

test("credential envelopes encrypt plaintext and bind ciphertext to the OAuth subject", () => {
  const keys = [key("primary-2026-08"), key("previous-2026-07")];
  const apiKey = "atlas-secret-key-that-must-never-appear-in-storage";
  const envelope = encryptAtlasCredential("subject-a", apiKey, keys);

  assert.equal(envelope.includes(apiKey), false);
  assert.equal(envelope.includes("subject-a"), false);
  assert.equal(decryptAtlasCredential("subject-a", envelope, keys), apiKey);
  assert.throws(
    () => decryptAtlasCredential("subject-b", envelope, keys),
    /decrypt Atlas credential/
  );
});

test("credential envelopes reject tampering and support encryption-key rotation", () => {
  const oldKey = key("old-2026-07");
  const newKey = key("new-2026-08");
  const oldEnvelope = encryptAtlasCredential("subject-a", "atlas-old-key", [oldKey]);

  assert.equal(
    decryptAtlasCredential("subject-a", oldEnvelope, [newKey, oldKey]),
    "atlas-old-key"
  );
  const parsed = JSON.parse(oldEnvelope) as Record<string, unknown>;
  const ciphertext = String(parsed.ciphertext);
  parsed.ciphertext = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
  assert.throws(
    () => decryptAtlasCredential("subject-a", JSON.stringify(parsed), [newKey, oldKey]),
    /decrypt Atlas credential/
  );
});

test("credential encryption key configuration rejects weak and duplicate keys", () => {
  const encoded = randomBytes(32).toString("base64url");
  const keys = parseCredentialEncryptionKeys(JSON.stringify([
    { kid: "primary-2026-08", key: encoded },
    { kid: "previous-2026-07", key: randomBytes(32).toString("base64url") },
  ]));
  assert.equal(keys.length, 2);
  assert.equal(keys[0].key.length, 32);

  assert.throws(
    () => parseCredentialEncryptionKeys(JSON.stringify([
      { kid: "duplicate-key", key: encoded },
      { kid: "duplicate-key", key: randomBytes(32).toString("base64url") },
    ])),
    /duplicate key IDs/
  );
  assert.throws(
    () => parseCredentialEncryptionKeys(JSON.stringify([
      { kid: "weak-key", key: randomBytes(16).toString("base64url") },
    ])),
    /32-byte/
  );
});
