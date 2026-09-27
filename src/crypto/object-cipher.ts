// Convergent AES-256-GCM object encryption + content-addressed naming.
//
// Convergent (deterministic) encryption is what lets identical plaintext dedupe to a
// single stored object: the nonce is derived from the plaintext, so encrypting the same
// bytes twice yields byte-identical output. GCM nonce-reuse is structurally safe here
// because a given nonce only ever co-occurs with the plaintext it was derived from.
//
// Object key = base32(HMAC(nameKey, sha256(plaintext))). The HMAC is keyed with a secret
// subkey, so the bucket operator cannot confirm known-plaintext from the opaque key.

import { view } from "./bytes";

const subtle = globalThis.crypto.subtle;

const MAGIC = new Uint8Array([0x4c, 0x57, 0x53, 0x31]); // "LWS1"
const VERSION = 1;
const NONCE_LEN = 12;
const HEADER_LEN = MAGIC.length + 1 + NONCE_LEN; // magic + version + nonce

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await subtle.digest("SHA-256", view(data));
  return new Uint8Array(digest);
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", view(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await subtle.sign("HMAC", k, view(data));
  return new Uint8Array(sig);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648, lowercased

/** RFC 4648 base32, lowercase, no padding — safe for S3 object keys. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Opaque, content-addressed object key. */
export async function objectKeyFor(nameKey: Uint8Array, plaintext: Uint8Array): Promise<string> {
  const h = await sha256(plaintext);
  const mac = await hmacSha256(nameKey, h);
  return base32(mac);
}

async function importAesKey(encKey: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("raw", view(encKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt plaintext into a self-describing blob: magic || version || nonce || ciphertext+tag.
 * Deterministic (convergent) given (encKey, nonceKey, plaintext).
 */
export async function encryptObject(
  encKey: Uint8Array,
  nonceKey: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const h = await sha256(plaintext);
  const nonce = (await hmacSha256(nonceKey, h)).slice(0, NONCE_LEN);
  const key = await importAesKey(encKey);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: view(nonce) }, key, view(plaintext)),
  );

  const blob = new Uint8Array(HEADER_LEN + ct.length);
  blob.set(MAGIC, 0);
  blob[MAGIC.length] = VERSION;
  blob.set(nonce, MAGIC.length + 1);
  blob.set(ct, HEADER_LEN);
  return blob;
}

export async function decryptObject(encKey: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) throw new Error("not a Little Wooly object (bad magic)");
  }
  const version = blob[MAGIC.length];
  if (version !== VERSION) throw new Error(`unsupported object version ${version}`);
  const nonce = blob.slice(MAGIC.length + 1, HEADER_LEN);
  const ct = blob.slice(HEADER_LEN);
  const key = await importAesKey(encKey);
  // subtle.decrypt throws on GCM tag mismatch — never swallow this.
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: view(nonce) }, key, view(ct));
  return new Uint8Array(pt);
}
