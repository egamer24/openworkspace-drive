import {
  base64UrlToBytes,
  bytesToBase64Url,
} from "@open-workspace/core/module";

/**
 * Passwords of public links: PBKDF2-SHA256 with a random salt, stored as
 * `pbkdf2$<iterations>$<salt>$<hash>` (base64url). 100,000 iterations is
 * the most Workers' Web Crypto allows; attempts are rate-limited too.
 */
const ITERATIONS = 100_000;

function fromBase64Url(value: string) {
  return new Uint8Array(base64UrlToBytes(value));
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );

  return new Uint8Array(bits);
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);

  return `pbkdf2$${ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, iterations, salt, hash] = stored.split("$");

  if (scheme !== "pbkdf2" || !iterations || !salt || !hash) return false;
  const expected = fromBase64Url(hash);

  const actual = await derive(
    password,
    fromBase64Url(salt),
    Number(iterations)
  );

  if (actual.length !== expected.length) return false;
  let difference = 0;

  for (const [index, byte] of actual.entries()) {
    difference |= byte ^ (expected[index] ?? 0);
  }

  return difference === 0;
}
