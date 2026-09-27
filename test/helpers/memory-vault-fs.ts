import type { VaultFS } from "../../src/engine/vault-fs";
import type { WalkEntry, WalkResult, RosterItem } from "../../src/engine/vault-walker";
import { classify, type ClassifyOptions } from "../../src/engine/file-classifier";

interface Stored {
  data: Uint8Array;
  mtime: number;
}

/** In-memory VaultFS for engine tests. Classifies via the real classifier.
 *
 * Writes stamp mtime from an injectable clock (default Date.now(), like a real
 * filesystem). Tests with multiple devices should share ONE monotonic clock across
 * devices AND engines so manifest fold (LWW by mtime, then ts) sees comparable values.
 */
export class MemoryVaultFS implements VaultFS {
  files = new Map<string, Stored>();
  trashed = new Map<string, Stored>();
  private clock: () => number;

  constructor(
    private opts: ClassifyOptions,
    clock: () => number = () => Date.now(),
  ) {
    this.clock = clock;
  }

  /** Test helper: create/replace a file with an explicit mtime. */
  set(path: string, content: string | Uint8Array, mtime?: number): void {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.files.set(path, { data, mtime: mtime ?? this.clock() });
  }

  async walk(): Promise<WalkResult> {
    const entries: WalkEntry[] = [];
    const roster: RosterItem[] = [];
    for (const [path, s] of this.files) {
      const c = classify(path, this.opts);
      if (c.tier === "EXCLUDE") {
        roster.push({ path, reason: c.reason });
        continue;
      }
      entries.push({ path, tier: c.tier, size: s.data.length, mtime: s.mtime });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    roster.sort((a, b) => a.path.localeCompare(b.path));
    return { entries, roster };
  }
  async read(path: string): Promise<Uint8Array> {
    const s = this.files.get(path);
    if (!s) throw new Error(`no such file: ${path}`);
    return s.data;
  }
  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, { data, mtime: this.clock() });
  }
  async trash(path: string): Promise<void> {
    const s = this.files.get(path);
    if (s) {
      this.trashed.set(path, s);
      this.files.delete(path);
    }
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}
