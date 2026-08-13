import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
const KEY_LENGTH = 64;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 64 * 1024 * 1024;

interface ParsedPasswordHash {
  cost: 16384 | 32768;
  salt: Buffer;
  expected: Buffer;
}

function parsePasswordHash(encoded: string): ParsedPasswordHash {
  const [algorithm, costRaw, blockRaw, parallelRaw, saltRaw, hashRaw, extra] = encoded.split("$");
  const cost = Number(costRaw);
  if (
    algorithm !== "scrypt" ||
    (cost !== 16384 && cost !== 32768) ||
    blockRaw !== String(BLOCK_SIZE) ||
    parallelRaw !== String(PARALLELIZATION) ||
    !saltRaw ||
    !hashRaw ||
    extra !== undefined
  ) {
    throw new Error("Unsupported password hash format");
  }
  const salt = Buffer.from(saltRaw, "base64url");
  const expected = Buffer.from(hashRaw, "base64url");
  if (salt.length < 16 || expected.length !== KEY_LENGTH) {
    throw new Error("Invalid password hash parameters");
  }
  return { cost, salt, expected };
}

async function derive(password: string, parsed: ParsedPasswordHash): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, parsed.salt, KEY_LENGTH, {
      N: parsed.cost,
      r: BLOCK_SIZE,
      p: PARALLELIZATION,
      maxmem: MAX_MEMORY,
    }, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(result));
    });
  });
}

export async function hashPassword(password: string, cost: 16384 | 32768 = 16384): Promise<string> {
  if (password.length < 16 || password.length > 1024) {
    throw new Error("Password must contain between 16 and 1024 characters");
  }
  const salt = randomBytes(16);
  const expected = await derive(password, { cost, salt, expected: Buffer.alloc(KEY_LENGTH) });
  return [
    "scrypt",
    String(cost),
    String(BLOCK_SIZE),
    String(PARALLELIZATION),
    salt.toString("base64url"),
    expected.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (password.length === 0 || password.length > 1024) return false;
  try {
    const parsed = parsePasswordHash(encoded);
    const actual = await derive(password, parsed);
    return timingSafeEqual(actual, parsed.expected);
  } catch {
    return false;
  }
}
