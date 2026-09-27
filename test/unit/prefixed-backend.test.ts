import { describe, test, expect } from "vitest";
import { PrefixedBackend } from "../../src/store/prefixed-backend";
import { MemoryBackend } from "../helpers/memory-backend";

const enc = new TextEncoder();

describe("PrefixedBackend", () => {
  test("scopes keys under the prefix and hides it from callers", async () => {
    const inner = new MemoryBackend();
    const pb = new PrefixedBackend(inner, "lwsync/vault1");
    await pb.put("objects/ab/key1", enc.encode("data"));

    // inner sees the full key...
    expect([...inner.store.keys()]).toEqual(["lwsync/vault1/objects/ab/key1"]);
    // ...callers see the vault-relative key.
    const listed = await pb.list("objects/");
    expect(listed.map((i) => i.key)).toEqual(["objects/ab/key1"]);
  });

  test("isolates two vaults sharing one bucket", async () => {
    const inner = new MemoryBackend();
    const v1 = new PrefixedBackend(inner, "lwsync/vault1");
    const v2 = new PrefixedBackend(inner, "lwsync/vault2");
    await v1.put("meta/x", enc.encode("one"));
    await v2.put("meta/x", enc.encode("two"));

    expect(await v1.head("meta/x")).not.toBeNull();
    expect((await v1.list("")).length).toBe(1);
    expect((await v2.list("")).length).toBe(1);
    expect(new TextDecoder().decode((await v1.get("meta/x"))!)).toBe("one");
  });
});
