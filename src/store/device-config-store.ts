// DEVICE_CONFIG backup/restore. Each device's device-specific config (workspace.json, etc.)
// is stored under devices/<hmac-of-device-name>/ and is NEVER auto-applied to another
// device. The device name appears only inside encrypted content (the manifest + the
// per-dir `.id` reverse-map) — never in a plaintext key. A fresh device can optionally
// restore its own prior backup, or explicitly adopt another named device's, from Settings.

import type { ObjectBackend } from "./backend";
import { PrefixedBackend } from "./prefixed-backend";
import { ObjectStore, type StoredFile } from "./object-store";
import { sealJson, openJson } from "../crypto/box";
import { deviceDir } from "./manifest-store";
import type { Subkeys } from "../crypto/keys";
import type { VaultFS } from "../engine/vault-fs";

type DeviceManifest = Record<string, StoredFile>;

export class DeviceConfigStore {
  constructor(
    private backend: ObjectBackend, // already vault-prefixed (lwsync/<vault>/)
    private subkeys: Subkeys,
  ) {}

  private async dirFor(device: string): Promise<string> {
    return deviceDir(this.subkeys.nameKey, device);
  }
  private objectsFor(dir: string): ObjectStore {
    return new ObjectStore(new PrefixedBackend(this.backend, `devices/${dir}`), this.subkeys);
  }

  /** Encrypted reverse-map: dir hash -> device name (for the restore picker). */
  private async ensureId(dir: string, device: string): Promise<void> {
    const key = `devices/${dir}/.id`;
    if (await this.backend.head(key)) return;
    await this.backend.put(key, await sealJson(this.subkeys.manifestKey, { device }));
  }

  /** Back up this device's DEVICE_CONFIG files. */
  async backup(fs: VaultFS, device: string): Promise<number> {
    const dir = await this.dirFor(device);
    const store = this.objectsFor(dir);
    const manifest: DeviceManifest = {};
    for (const e of (await fs.walk()).entries) {
      if (e.tier !== "DEVICE_CONFIG") continue;
      manifest[e.path] = await store.putFile(await fs.read(e.path));
    }
    await this.backend.put(
      `devices/${dir}/manifest`,
      await sealJson(this.subkeys.manifestKey, manifest),
    );
    await this.ensureId(dir, device);
    return Object.keys(manifest).length;
  }

  /** Names of devices that have a device-config backup (via the encrypted `.id`s). */
  async listBackedUpDevices(): Promise<string[]> {
    const objs = await this.backend.list("devices/");
    const dirs = new Set<string>();
    for (const o of objs) {
      const m = o.key.match(/^devices\/([^/]+)\/manifest$/);
      if (m) dirs.add(m[1]);
    }
    const out: string[] = [];
    for (const dir of dirs) {
      const blob = await this.backend.get(`devices/${dir}/.id`);
      if (!blob) continue;
      try {
        out.push((await openJson<{ device: string }>(this.subkeys.manifestKey, blob)).device);
      } catch {
        /* corrupt .id — skip */
      }
    }
    return out;
  }

  /** Restore a (possibly other) device's config into the vault. */
  async restore(fs: VaultFS, fromDevice: string): Promise<number> {
    const dir = await this.dirFor(fromDevice);
    const blob = await this.backend.get(`devices/${dir}/manifest`);
    if (!blob) return 0;
    const manifest = await openJson<DeviceManifest>(this.subkeys.manifestKey, blob);
    const store = this.objectsFor(dir);
    let restored = 0;
    for (const [path, ref] of Object.entries(manifest)) {
      await fs.write(path, await store.getFile(ref));
      restored++;
    }
    return restored;
  }
}
