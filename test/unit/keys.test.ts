import { describe, test, expect } from "vitest";
import {
  generateKdfParams,
  deriveMasterKey,
  deriveSubkeys,
  createVerifier,
  checkVerifier,
} from "../../src/crypto/keys";

// Small Argon2id params keep the unit tests fast; production uses 256 MiB / t=3.
const fastParams = (saltB64?: string) => {
  const p = generateKdfParams();
  p.memoryKiB = 8192;
  p.iterations = 1;
  if (saltB64) p.saltB64 = saltB64;
  return p;
};

describe("deriveMasterKey", () => {
  test("is deterministic for the same passphrase + salt", async () => {
    const params = fastParams();
    const a = await deriveMasterKey("correct horse battery staple", params);
    const b = await deriveMasterKey("correct horse battery staple", params);
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });

  test("differs when the salt differs", async () => {
    const a = await deriveMasterKey("pw", fastParams());
    const b = await deriveMasterKey("pw", fastParams());
    // generateKdfParams produces a fresh random salt each call.
    expect(a).not.toEqual(b);
  });

  test("differs when the passphrase differs", async () => {
    const params = fastParams();
    const a = await deriveMasterKey("pw-one", params);
    const b = await deriveMasterKey("pw-two", params);
    expect(a).not.toEqual(b);
  });
});

describe("deriveSubkeys", () => {
  test("derives five independent 32-byte subkeys", async () => {
    const master = await deriveMasterKey("pw", fastParams());
    const k = await deriveSubkeys(master);
    const all = [k.encKey, k.nameKey, k.nonceKey, k.manifestKey, k.verifyKey];
    for (const sk of all) expect(sk.length).toBe(32);
    // All distinct (HKDF with distinct info labels).
    const hexes = new Set(all.map((x) => Buffer.from(x).toString("hex")));
    expect(hexes.size).toBe(5);
  });

  test("is deterministic for the same master key", async () => {
    const master = await deriveMasterKey("pw", fastParams());
    const a = await deriveSubkeys(master);
    const b = await deriveSubkeys(master);
    expect(a.encKey).toEqual(b.encKey);
    expect(a.nameKey).toEqual(b.nameKey);
  });
});

describe("verifier", () => {
  test("accepts the correct key and rejects a wrong one", async () => {
    const right = (
      await deriveSubkeys(await deriveMasterKey("right", fastParams("c2FsdHNhbHRzYWx0c2FsdA==")))
    ).verifyKey;
    const wrong = (
      await deriveSubkeys(await deriveMasterKey("wrong", fastParams("c2FsdHNhbHRzYWx0c2FsdA==")))
    ).verifyKey;
    const verifier = await createVerifier(right);
    expect(await checkVerifier(right, verifier)).toBe(true);
    expect(await checkVerifier(wrong, verifier)).toBe(false);
  });
});
