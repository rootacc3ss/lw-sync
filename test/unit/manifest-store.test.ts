import { describe, test, expect } from "vitest";
import { ManifestStore } from "../../src/store/manifest-store";
import { VaultConfigStore, defaultVaultConfig } from "../../src/store/vault-config";
import { MemoryBackend } from "../helpers/memory-backend";
import type { Manifest, HistoryRecord } from "../../src/types";

const KEY = new Uint8Array(32).fill(5);

function snapshot(device: string, path: string, contentHash: string, mtime: number): Manifest {
  const r: HistoryRecord = {
    version: 0,
    objectKey: contentHash,
    isRecipe: false,
    contentHash,
    size: 1,
    mtime,
    author: device,
    ts: mtime,
    parentHash: null,
    deleted: false,
  };
  return { schema: 1, generatedAt: 0, device, paths: { [path]: { history: [r], head: 0 } } };
}

describe("ManifestStore persistence", () => {
  test("device manifests append, list, and fold into a merged view", async () => {
    const store = new ManifestStore(new MemoryBackend(), KEY);
    await store.writeDeviceManifest("desktop", snapshot("desktop", "a.md", "ha", 100));
    await store.writeDeviceManifest("mobile", snapshot("mobile", "b.md", "hb", 100));

    expect((await store.listDevices()).sort()).toEqual(["desktop", "mobile"]);
    const { merged } = await store.computeMerged();
    expect(Object.keys(merged.paths).sort()).toEqual(["a.md", "b.md"]);

    await store.advanceMerged(merged);
    const readBack = await store.readMerged();
    expect(readBack).not.toBeNull();
    expect(Object.keys(readBack!.paths).sort()).toEqual(["a.md", "b.md"]);
  });

  test("a device only reads its own latest seq", async () => {
    const store = new ManifestStore(new MemoryBackend(), KEY);
    await store.writeDeviceManifest("desktop", snapshot("desktop", "a.md", "v1", 100));
    await store.writeDeviceManifest("desktop", snapshot("desktop", "a.md", "v2", 200));
    const latest = await store.readDeviceLatest("desktop");
    expect(latest!.paths["a.md"].history[0].contentHash).toBe("v2");
  });
});

describe("VaultConfigStore", () => {
  test("bootstraps and round-trips encrypted config; registers devices", async () => {
    const be = new MemoryBackend();
    const vc = new VaultConfigStore(be);
    expect(await vc.isInitialized()).toBe(false);

    await vc.writeConfig(KEY, defaultVaultConfig("vault1", "desktop"));
    const cfg = await vc.readConfig(KEY);
    expect(cfg!.vaultName).toBe("vault1");
    expect(cfg!.devices).toEqual(["desktop"]);

    const updated = await vc.registerDevice(KEY, "mobile");
    expect(updated.devices.sort()).toEqual(["desktop", "mobile"]);
    // registering the same device again is a no-op
    expect((await vc.registerDevice(KEY, "mobile")).devices.length).toBe(2);
  });

  test("keyparams are stored in plaintext for new-device bootstrap", async () => {
    const be = new MemoryBackend();
    const vc = new VaultConfigStore(be);
    const doc = {
      params: {
        algo: "argon2id" as const,
        memoryKiB: 8,
        iterations: 1,
        parallelism: 1,
        hashLength: 32,
        saltB64: "AAAA",
        version: 1,
      },
      verifier: { nonceB64: "n", ctB64: "c" },
    };
    await vc.writeKeyParams(doc);
    expect(await vc.isInitialized()).toBe(true);
    expect((await vc.readKeyParams())!.params.saltB64).toBe("AAAA");
  });
});
