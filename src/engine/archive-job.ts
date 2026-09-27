// The redundant "catch-all" archive: a single encrypted blob holding the full config tree
// (.obsidian/**), uploaded to archives/. Deliberately redundant with per-file sync — a
// one-shot "restore everything" safety net. GFS-ish retention prunes old archives.
//
// Container format (LWA1): magic(4) | flags(1, bit0 = gzip) | headerLen uint32-LE(4) |
// UTF-8 JSON header [{path, size}] | raw file bytes concatenated in header order.
// Compression uses the platform CompressionStream (gzip) when available — no Node zlib,
// no tar dependency, no Buffer. Runs identically on desktop and mobile.

import type { ObjectBackend } from "../store/backend";
import { seal, open } from "../crypto/box";
import type { Subkeys } from "../crypto/keys";
import type { VaultFS } from "./vault-fs";

const SHARED_OR_DEVICE = new Set(["SHARED_CONFIG", "DEVICE_CONFIG"]);

const MAGIC = new Uint8Array([0x4c, 0x57, 0x41, 0x31]); // "LWA1"
const FLAG_GZIP = 1;

interface ArchiveHeaderEntry {
  path: string;
  size: number;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function readU32le(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0, true);
}

async function maybeGzip(data: Uint8Array): Promise<{ data: Uint8Array; gz: boolean }> {
  if (typeof CompressionStream === "undefined") return { data, gz: false };
  const stream = new Blob([data.buffer as ArrayBuffer])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return { data: new Uint8Array(await new Response(stream).arrayBuffer()), gz: true };
}

async function maybeGunzip(data: Uint8Array, gz: boolean): Promise<Uint8Array> {
  if (!gz) return data;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("archive is gzip-compressed but this platform lacks DecompressionStream");
  }
  const stream = new Blob([data.buffer as ArrayBuffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Pack files into an LWA1 container (uncompressed at this stage). */
export function packArchive(files: { path: string; data: Uint8Array }[]): Uint8Array {
  const header: ArchiveHeaderEntry[] = files.map((f) => ({ path: f.path, size: f.data.length }));
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  return concatBytes([u32le(headerBytes.length), headerBytes, ...files.map((f) => f.data)]);
}

/** Unpack an LWA1 container (the 4-byte magic/flags are stripped by the caller). */
export function unpackArchive(body: Uint8Array): { path: string; data: Uint8Array }[] {
  const headerLen = readU32le(body, 0);
  const headerStart = 4;
  const payloadStart = headerStart + headerLen;
  const header = JSON.parse(
    new TextDecoder().decode(body.subarray(headerStart, payloadStart)),
  ) as ArchiveHeaderEntry[];
  const out: { path: string; data: Uint8Array }[] = [];
  let off = payloadStart;
  for (const h of header) {
    out.push({ path: h.path, data: body.slice(off, off + h.size) });
    off += h.size;
  }
  return out;
}

export class ArchiveJob {
  constructor(
    private backend: ObjectBackend,
    private subkeys: Subkeys,
  ) {}

  /** Build + encrypt + upload an archive. `stamp` is the caller's timestamp (UTC ms). */
  async create(fs: VaultFS, stamp: number): Promise<string> {
    const files: { path: string; data: Uint8Array }[] = [];
    for (const e of (await fs.walk()).entries) {
      if (!SHARED_OR_DEVICE.has(e.tier)) continue;
      files.push({ path: e.path, data: await fs.read(e.path) });
    }
    const packed = packArchive(files);
    const { data: payload, gz } = await maybeGzip(packed);
    const blob = concatBytes([MAGIC, new Uint8Array([gz ? FLAG_GZIP : 0]), payload]);
    const sealedBlob = await seal(this.subkeys.manifestKey, blob);
    const key = `archives/${stamp}.lwa.enc`;
    await this.backend.put(key, sealedBlob);
    return key;
  }

  async list(): Promise<string[]> {
    return (await this.backend.list("archives/")).map((o) => o.key).sort();
  }

  /** Decrypt + decode an archive into [{path,data}] for restore. */
  async extract(key: string): Promise<{ path: string; data: Uint8Array }[]> {
    const blob = await this.backend.get(key);
    if (!blob) return [];
    const opened = await open(this.subkeys.manifestKey, blob);
    for (let i = 0; i < MAGIC.length; i++) {
      if (opened[i] !== MAGIC[i]) throw new Error("not a Little Wooly archive (bad magic)");
    }
    const gz = (opened[MAGIC.length] & FLAG_GZIP) !== 0;
    const payload = await maybeGunzip(opened.subarray(MAGIC.length + 1), gz);
    return unpackArchive(payload);
  }

  /** GFS-ish retention: keep the newest `keep` archives, delete the rest. */
  async prune(keep: number): Promise<number> {
    const all = await this.list();
    const toDelete = all.slice(0, Math.max(0, all.length - keep));
    for (const k of toDelete) await this.backend.delete(k);
    return toDelete.length;
  }
}
