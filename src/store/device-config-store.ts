// DEVICE_CONFIG backup/restore. Each device's device-specific config (workspace.json, etc.)
// is stored under devices/<device>/ and is NEVER auto-applied to another device. A fresh
// device can optionally restore its own prior backup, or explicitly adopt another named
// device's, via the setup wizard.

import type { ObjectBackend } from "./backend";
import { PrefixedBackend } from "./prefixed-backend";
import { ObjectStore, type StoredFile } from "./object-store";
import { sealJson, openJson } from "../crypto/box";
import type { Subkeys } from "../crypto/keys";
import type { VaultFS } from "../engine/vault-fs";

type DeviceManifest = Record<string, StoredFile>;

export class DeviceConfigStore {
  constructor(
    private backend: ObjectBackend, // already vault-prefixed (lwsync/<vault>/)
    private subkeys: Subkeys,
  ) {}

  private objectsFor(device: string): ObjectStore {
    return new ObjectStore(new PrefixedBackend(this.backend, `devices/${device}`), this.subkeys);
  }
  private manifestKey(device: string): string {
    return `devices/${device}/manifest`;
  }

  /** Back up this device's DEVICE_CONFIG files. */
  async backup(fs: VaultFS, device: string): Promise<number> {
    const store = this.objectsFor(device);
    const manifest: DeviceManifest = {};
    for (const e of (await fs.walk()).entries) {
      if (e.tier !== "DEVICE_CONFIG") continue;
      manifest[e.path] = await store.putFile(await fs.read(e.path));
    }
    await this.backend.put(
      this.manifestKey(device),
      await sealJson(this.subkeys.manifestKey, manifest),
    );
    return Object.keys(manifest).length;
  }

  /** Names of devices that have a device-config backup. */
  async listBackedUpDevices(): Promise<string[]> {
    const objs = await this.backend.list("devices/");
    const out = new Set<string>();
    for (const o of objs) {
      const m = o.key.match(/^devices\/([^/]+)\/manifest$/);
      if (m) out.add(m[1]);
    }
    return [...out];
  }

  /** Restore a (possibly other) device's config into the vault. */
  async restore(fs: VaultFS, fromDevice: string): Promise<number> {
    const blob = await this.backend.get(this.manifestKey(fromDevice));
    if (!blob) return 0;
    const manifest = await openJson<DeviceManifest>(this.subkeys.manifestKey, blob);
    const store = this.objectsFor(fromDevice);
    let restored = 0;
    for (const [path, ref] of Object.entries(manifest)) {
      await fs.write(path, await store.getFile(ref));
      restored++;
    }
    return restored;
  }
}
