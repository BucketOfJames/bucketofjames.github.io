// PBKDF2 verification shared between the login handler and the debug route,
// so debug reports the exact same code path used for real logins.

import { b64ToBytes } from "../../shared/base64.js";

export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// EDIT_PASS_HASH format: PBKDF2$<iterations>$<salt_b64>$<hash_b64>
export async function verifyPassword(password, stored) {
  try {
    const [tag, iterStr, saltB64, hashB64] = stored.split("$");
    if (tag !== "PBKDF2") return false;
    const iterations = parseInt(iterStr, 10);
    const salt = b64ToBytes(saltB64);
    const expected = b64ToBytes(hashB64);
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations,
      },
      keyMaterial,
      expected.length * 8
    );
    const actual = new Uint8Array(bits);
    return constantTimeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}
