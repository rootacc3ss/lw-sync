import { describe, test, expect } from "vitest";
import {
  sha256,
  toHex,
  base32,
  objectKeyFor,
  encryptObject,
  decryptObject,
} from "../../src/crypto/object-cipher";

const enc = new TextEncoder();

describe("sha256", () => {
  test("matches the known NIST vector for 'abc'", async () => {
    const digest = await sha256(enc.encode("abc"));
    expect(toHex(digest)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("base32", () => {
  test("encodes RFC 4648 lowercase without padding", () => {
    // "foobar" -> MZXW6YTBOI (RFC 4648), lowercased, no '='.
    expect(base32(enc.encode("foobar"))).toBe("mzxw6ytboi");
  });
});

describe("objectKeyFor", () => {
  const nameKey = new Uint8Array(32).fill(7);

  test("is deterministic for identical content (content-addressed)", async () => {
    const a = await objectKeyFor(nameKey, enc.encode("hello world"));
    const b = await objectKeyFor(nameKey, enc.encode("hello world"));
    expect(a).toBe(b);
  });

  test("differs for different content", async () => {
    const a = await objectKeyFor(nameKey, enc.encode("hello world"));
    const b = await objectKeyFor(nameKey, enc.encode("hello worle"));
    expect(a).not.toBe(b);
  });

  test("differs when the naming key differs (keyed, not a bare hash)", async () => {
    const other = new Uint8Array(32).fill(9);
    const a = await objectKeyFor(nameKey, enc.encode("secret.pdf contents"));
    const b = await objectKeyFor(other, enc.encode("secret.pdf contents"));
    expect(a).not.toBe(b);
  });
});

describe("encryptObject / decryptObject", () => {
  const encKey = new Uint8Array(32).fill(1);
  const nonceKey = new Uint8Array(32).fill(2);

  test("round-trips arbitrary bytes", async () => {
    const plaintext = enc.encode("the quick brown fox 🦊 \x00\x01\x02");
    const blob = await encryptObject(encKey, nonceKey, plaintext);
    const out = await decryptObject(encKey, blob);
    expect(new Uint8Array(out)).toEqual(plaintext);
  });

  test("is convergent: same plaintext encrypts to identical bytes (enables dedup)", async () => {
    const plaintext = enc.encode("dedupe me");
    const a = await encryptObject(encKey, nonceKey, plaintext);
    const b = await encryptObject(encKey, nonceKey, plaintext);
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
  });

  test("produces different ciphertext for different content", async () => {
    const a = await encryptObject(encKey, nonceKey, enc.encode("aaaa"));
    const b = await encryptObject(encKey, nonceKey, enc.encode("bbbb"));
    expect(new Uint8Array(a)).not.toEqual(new Uint8Array(b));
  });

  test("rejects a tampered blob (GCM auth tag failure)", async () => {
    const blob = await encryptObject(encKey, nonceKey, enc.encode("integrity"));
    blob[blob.length - 1] ^= 0xff; // flip a ciphertext byte
    await expect(decryptObject(encKey, blob)).rejects.toThrow();
  });
});
