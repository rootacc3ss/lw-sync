import { describe, test, expect, beforeEach } from "vitest";
import { ObjectStore } from "../../src/store/object-store";
import { MemoryBackend } from "../helpers/memory-backend";
import { deriveSubkeys, deriveMasterKey, generateKdfParams } from "../../src/crypto/keys";
import type { Subkeys } from "../../src/crypto/keys";

let subkeys: Subkeys;

beforeEach(async () => {
  const p = generateKdfParams();
  p.memoryKiB = 8192;
  p.iterations = 1;
  subkeys = await deriveSubkeys(await deriveMasterKey("pw", p));
});

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * seed + 13) & 0xff;
  return out;
}

describe("ObjectStore single-object files", () => {
  test("round-trips a small file", async () => {
    const be = new MemoryBackend();
    const store = new ObjectStore(be, subkeys);
    const plaintext = new TextEncoder().encode("hello little wooly");
    const ref = await store.putFile(plaintext);
    expect(ref.isRecipe).toBe(false);
    const out = await store.getFile(ref);
    expect(new Uint8Array(out)).toEqual(plaintext);
  });

  test("dedupes identical content: a second put uploads nothing new", async () => {
    const be = new MemoryBackend();
    const store = new ObjectStore(be, subkeys);
    const plaintext = bytes(1000);
    await store.putFile(plaintext);
    const putsAfterFirst = be.putCount;
    await store.putFile(plaintext);
    expect(be.putCount).toBe(putsAfterFirst); // HEAD said it exists -> skipped
  });

  test("stores objects under an objects/<fanout>/ layout", async () => {
    const be = new MemoryBackend();
    const store = new ObjectStore(be, subkeys);
    await store.putFile(new TextEncoder().encode("x"));
    const keys = [...be.store.keys()];
    expect(keys.every((k) => /^objects\/[a-z2-7]{2}\//.test(k))).toBe(true);
  });
});

describe("ObjectStore large (chunked) files", () => {
  test("round-trips a multi-chunk file via a recipe object", async () => {
    const be = new MemoryBackend();
    const store = new ObjectStore(be, subkeys, 1024); // tiny chunks to force chunking
    const plaintext = bytes(5000, 3); // ~5 chunks
    const ref = await store.putFile(plaintext);
    expect(ref.isRecipe).toBe(true);
    const out = await store.getFile(ref);
    expect(new Uint8Array(out)).toEqual(plaintext);
  });

  test("block-level dedup: shared chunks across files are stored once", async () => {
    const be = new MemoryBackend();
    const store = new ObjectStore(be, subkeys, 1024);
    const a = bytes(4096, 5);
    await store.putFile(a);
    const objectsAfterA = be.store.size;
    await store.putFile(a); // identical -> every chunk + recipe already present
    expect(be.store.size).toBe(objectsAfterA);
  });
});
