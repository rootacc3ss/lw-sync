// Bridges @types/node's generic `Uint8Array<ArrayBufferLike>` to WebCrypto's
// `BufferSource` (which requires an `ArrayBuffer`-backed view). Our byte arrays are
// always ArrayBuffer-backed at runtime, so this is a zero-copy type assertion, not a
// cast that hides a real mismatch.
export type Bytes = Uint8Array<ArrayBuffer>;

export function view(u: Uint8Array): Bytes {
  return u as Bytes;
}

// --- Pure-TS base64 (no Node Buffer, no atob — safe on desktop AND mobile webviews) ---

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function b64encode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

export function b64decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) throw new Error("invalid base64");
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff; // masked: never grows past 24 bits
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
