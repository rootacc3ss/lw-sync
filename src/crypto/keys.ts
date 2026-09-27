// Key derivation and the passphrase verifier.
//
// passphrase --Argon2id--> master key --HKDF(distinct info)--> { enc, name, nonce,
// manifest, verify } subkeys. The Argon2id salt + params are non-secret and stored in
// the bucket (meta/keyparams) so any device can reproduce the derivation.

import { argon2id } from "hash-wasm";
import { view, b64encode, b64decode } from "./bytes";

const subtle = globalThis.crypto.subtle;

export interface KdfParams {
  algo: "argon2id";
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
  saltB64: string;
  version: number;
}

export interface Subkeys {
  encKey: Uint8Array;
  nameKey: Uint8Array;
  nonceKey: Uint8Array;
  manifestKey: Uint8Array;
  verifyKey: Uint8Array;
}

export interface Verifier {
  nonceB64: string;
  ctB64: string;
}

const VERIFY_PLAINTEXT = "littlewooly-v1-verify";

function b64(bytes: Uint8Array): string {
  return b64encode(bytes);
}
function unb64(s: string): Uint8Array {
  return b64decode(s);
}

/**
 * Fresh params with a random 16-byte salt. Uses the RFC 9106 low-memory profile
 * (64 MiB, 3 iterations, 1 lane) — the strongest Argon2id profile that reliably fits
 * in a mobile (iOS WKWebView) WASM memory budget, so a vault created on desktop can
 * still be unlocked on a phone.
 */
export function generateKdfParams(): KdfParams {
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  return {
    algo: "argon2id",
    memoryKiB: 65536, // 64 MiB — RFC 9106 §4 second recommended profile
    iterations: 3,
    parallelism: 1,
    hashLength: 32,
    saltB64: b64(salt),
    version: 1,
  };
}

export async function deriveMasterKey(passphrase: string, params: KdfParams): Promise<Uint8Array> {
  const hash = await argon2id({
    password: passphrase,
    salt: unb64(params.saltB64),
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: params.hashLength,
    outputType: "binary",
  });
  return new Uint8Array(hash);
}

const enc = new TextEncoder();

const SUBKEY_INFO: Record<keyof Subkeys, string> = {
  encKey: "lws:v1:content-enc",
  nameKey: "lws:v1:object-name",
  nonceKey: "lws:v1:nonce",
  manifestKey: "lws:v1:manifest",
  verifyKey: "lws:v1:verifier",
};

export async function deriveSubkeys(master: Uint8Array): Promise<Subkeys> {
  const hkdfKey = await subtle.importKey("raw", view(master), "HKDF", false, ["deriveBits"]);
  const out = {} as Subkeys;
  for (const [name, info] of Object.entries(SUBKEY_INFO) as [keyof Subkeys, string][]) {
    const bits = await subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: view(new Uint8Array(0)),
        info: view(enc.encode(info)),
      },
      hkdfKey,
      256,
    );
    out[name] = new Uint8Array(bits);
  }
  return out;
}

export async function createVerifier(verifyKey: Uint8Array): Promise<Verifier> {
  const nonce = new Uint8Array(12);
  globalThis.crypto.getRandomValues(nonce);
  const key = await subtle.importKey("raw", view(verifyKey), { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ct = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv: view(nonce) },
      key,
      view(enc.encode(VERIFY_PLAINTEXT)),
    ),
  );
  return { nonceB64: b64(nonce), ctB64: b64(ct) };
}

export async function checkVerifier(verifyKey: Uint8Array, verifier: Verifier): Promise<boolean> {
  try {
    const key = await subtle.importKey("raw", view(verifyKey), { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: view(unb64(verifier.nonceB64)) },
      key,
      view(unb64(verifier.ctB64)),
    );
    return new TextDecoder().decode(pt) === VERIFY_PLAINTEXT;
  } catch {
    return false;
  }
}
