import { describe, test, expect } from "vitest";
import { packArchive, unpackArchive } from "../../src/engine/archive-job";

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
    expect(unpacked.map((f) => f.path)).toEqual([
      ".obsidian/app.json",
      "a.md",
      "dir/b.md",
    ]);
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
