// The storage abstraction every layer above talks to. The real S3 implementation
// (s3-client.ts), the per-vault prefix wrapper (prefixed-backend.ts), and the in-memory
// test backend all implement this. Keys are plain strings; the object store composes the
// `objects/<fanout>/...` layout, the prefix wrapper scopes everything under `lwsync/<vault>/`.
//
// `copy` is server-side copy where the provider supports it (migrations); callers must
// be ready to fall back to get+put. `listDirs` lists immediate child "directories"
// (S3 CommonPrefixes) — used to enumerate vaults without listing every key.

export interface ObjectInfo {
  key: string;
  size: number;
}

export interface PutOptions {
  /** Only create if absent (S3 `If-None-Match: *`). Used for immutable objects + CAS. */
  ifNoneMatch?: boolean;
}

export interface ObjectBackend {
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<ObjectInfo | null>;
  list(prefix: string): Promise<ObjectInfo[]>;
  delete(key: string): Promise<void>;
  /** Server-side copy when the provider supports it; may throw — callers fall back. */
  copy(fromKey: string, toKey: string): Promise<void>;
  /** Immediate child directory names under `prefix` (no trailing slash), no recursion. */
  listDirs(prefix: string): Promise<string[]>;
}

/** Thrown by `put` when `ifNoneMatch` is set and the key already exists. */
export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`object already exists: ${key}`);
    this.name = "PreconditionFailedError";
  }
}
