// Base64 helpers shared by the workers (TextEncoder/TextDecoder safe for UTF-8).
// Cloudflare Workers have btoa/atob but no Buffer, so byte loops are required.

function bytesToB64(bytes, url) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  let b64 = btoa(bin);
  if (url) b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64;
}

export function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function b64url(bytes) {
  return bytesToB64(bytes, true);
}

export function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export function encodeBase64(str) {
  return bytesToB64(new TextEncoder().encode(str), false);
}

export function decodeBase64(b64) {
  return new TextDecoder().decode(b64ToBytes(b64));
}