import {
  ObjectBackend,
  ObjectInfo,
  PutOptions,
  PreconditionFailedError,
} from "../../src/store/backend";

/** In-memory ObjectBackend for unit tests. Records put/head counts for dedup assertions. */
export class MemoryBackend implements ObjectBackend {
  store = new Map<string, Uint8Array>();
  putCount = 0;
  headCount = 0;

  async put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void> {
    if (opts?.ifNoneMatch && this.store.has(key)) throw new PreconditionFailedError(key);
    this.store.set(key, body.slice());
    this.putCount++;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const v = this.store.get(key);
    return v ? v.slice() : null;
  }

  async head(key: string): Promise<ObjectInfo | null> {
    this.headCount++;
    const v = this.store.get(key);
    return v ? { key, size: v.length } : null;
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    for (const [key, v] of this.store) {
      if (key.startsWith(prefix)) out.push({ key, size: v.length });
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
