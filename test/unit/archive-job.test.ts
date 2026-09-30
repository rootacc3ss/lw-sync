import { describe, test, expect, beforeEach } from "vitest";
import { packArchive, unpackArchive, ArchiveJob } from "../../src/engine/archive-job";
import { MemoryBackend } from "../helpers/memory-backend";
import { MemoryVaultFS } from "../helpers/memory-vault-fs";
import { makeClassifyOptions } from "../../src/engine/file-classifier";
import { defaultVaultConfig } from "../../src/store/vault-config";
import {
  deriveMasterKey,
  deriveSubkeys,
  generateKdfParams,
  type Subkeys,
} from "../../src/crypto/keys";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("LWA1 archive container", () => {
  test("round-trips multiple files (including empty and binary-ish)", () => {
    const files = [
      { path: ".obsidian/app.json", data: bytes('{"theme":"moonstone"}') },
      { path: "a.md", data: bytes("") },
      { path: "dir/b.md", data: new Uint8Array([0, 1, 2, 255, 254, 0]) },
    ];
    const packed = packArchive(files);
    const unpacked = unpackArchive(packed);
    expect(unpacked.map((f) => f.path)).toEqual([".obsidian/app.json", "a.md", "dir/b.md"]);
    expect(unpacked[0].data).toEqual(files[0].data);
    expect(unpacked[1].data).toEqual(files[1].data);
    expect(unpacked[2].data).toEqual(files[2].data);
  });

  test("handles file contents that themselves look like the container header", () => {
    // A file whose bytes begin with a plausible headerLen must not confuse the parser.
    const tricky = new Uint8Array([16, 0, 0, 0, 123, 125]); // len=16 + "{}"
    const packed = packArchive([{ path: "t.bin", data: tricky }]);
    const out = unpackArchive(packed);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("t.bin");
    expect(out[0].data).toEqual(tricky);
  });

  test("produces byte-identical output for identical input (deterministic)", () => {
    const files = [{ path: "x.md", data: bytes("hello") }];
    expect(packArchive(files)).toEqual(packArchive(files));
  });
});

describe("ArchiveJob storage (opaque keys + encrypted chronological index)", () => {
  let be: MemoryBackend;
  let subkeys: Subkeys;
  let fs: MemoryVaultFS;

  beforeEach(async () => {
    be = new MemoryBackend();
    const p = generateKdfParams();
    p.memoryKiB = 8192;
    p.iterations = 1;
    subkeys = await deriveSubkeys(await deriveMasterKey("pw", p));
    fs = new MemoryVaultFS(makeClassifyOptions(defaultVaultConfig("v", "d"), "littlewooly-sync"));
    fs.set(".obsidian/app.json", '{"theme":"moonstone"}', 100);
    fs.set("note.md", "just a note", 100); // CONTENT — not archived
  });

  test("keys are opaque HMACs — no timestamp digits anywhere", async () => {
    const job = new ArchiveJob(be, subkeys);
    const key = await job.create(fs, 1727000000000);
    expect(key).toMatch(/^archives\/[a-z2-7]+\.enc$/);
    expect(key).not.toContain("1727000000000");
    for (const k of be.store.keys()) expect(k).not.toContain("1727000000000");
  });

  test("list() is chronological and prune() keeps the newest N", async () => {
    const job = new ArchiveJob(be, subkeys);
    await job.create(fs, 1000);
    await job.create(fs, 2000);
    await job.create(fs, 3000);
    const listed = await job.list();
    expect(listed).toHaveLength(3);

    const pruned = await job.prune(2);
    expect(pruned).toBe(1);
    expect(await job.list()).toHaveLength(2);
    // The KEPT archives are the two newest — extract still works on them.
    expect((await job.extract((await job.list())[0])).map((f) => f.path)).toContain(
      ".obsidian/app.json",
    );
    // The deleted (oldest) key is really gone from the backend.
    expect([...be.store.keys()].filter((k) => k.startsWith("archives/"))).toHaveLength(2);
  });

  test("the index blob is encrypted (no plaintext stamps or paths)", async () => {
    const job = new ArchiveJob(be, subkeys);
    await job.create(fs, 1727000000000);
    const blob = await be.get("meta/archives");
    expect(new TextDecoder().decode(blob!)).not.toContain("1727000000000");
    expect(new TextDecoder().decode(blob!)).not.toContain("archives/");
  });
});
