// Random-nonce AES-256-GCM for non-deduplicated blobs (manifests, vault config). Unlike
// the convergent object cipher, these are intentionally NOT content-addressed, so a fresh
// random nonce each time is both correct and desirable.

import { view } from "./bytes";

const subtle = globalThis.crypto.subtle;
const NONCE_LEN = 12;

async function key(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("raw", view(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt -> nonce(12) || ciphertext+tag. */
export async function seal(k: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = new Uint8Array(NONCE_LEN);
  globalThis.crypto.getRandomValues(nonce);
  const ck = await key(k);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: view(nonce) }, ck, view(plaintext)),
  );
  const out = new Uint8Array(NONCE_LEN + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_LEN);
  return out;
}

export async function open(k: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  const nonce = blob.slice(0, NONCE_LEN);
  const ct = blob.slice(NONCE_LEN);
  const ck = await key(k);
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: view(nonce) }, ck, view(ct)));
}

export async function sealJson(k: Uint8Array, obj: unknown): Promise<Uint8Array> {
  return seal(k, new TextEncoder().encode(JSON.stringify(obj)));
}

export async function openJson<T>(k: Uint8Array, blob: Uint8Array): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await open(k, blob))) as T;
}
