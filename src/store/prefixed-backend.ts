// Scopes every key under a fixed prefix (e.g. `lwsync/<vaultName>/`) so one bucket can
// hold many vaults without collision. Transparent: callers use vault-relative keys.

import { ObjectBackend, ObjectInfo, PutOptions } from "./backend";

export class PrefixedBackend implements ObjectBackend {
  private prefix: string;

  constructor(
    private inner: ObjectBackend,
    prefix: string,
  ) {
    // normalise to exactly one trailing slash, no leading slash.
    this.prefix = prefix.replace(/^\/+/, "").replace(/\/+$/, "") + "/";
  }

  private full(key: string): string {
    return this.prefix + key;
  }
  private strip(key: string): string {
    return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
  }

  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void> {
    return this.inner.put(this.full(key), body, opts);
  }
  get(key: string): Promise<Uint8Array | null> {
    return this.inner.get(this.full(key));
  }
  async head(key: string): Promise<ObjectInfo | null> {
    const info = await this.inner.head(this.full(key));
    return info ? { key, size: info.size } : null;
  }
  async list(prefix: string): Promise<ObjectInfo[]> {
    const infos = await this.inner.list(this.full(prefix));
    return infos.map((i) => ({ key: this.strip(i.key), size: i.size }));
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(this.full(key));
  }
}
