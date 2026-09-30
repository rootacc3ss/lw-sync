import { describe, test, expect, beforeEach } from "vitest";
import { migrateLayout } from "../../src/engine/layout-migrator";
import { deviceDir } from "../../src/store/manifest-store";
import { archiveKeyFor } from "../../src/engine/archive-job";
import { sealJson } from "../../src/crypto/box";
import { MemoryBackend } from "../helpers/memory-backend";
import {
  deriveMasterKey,
  deriveSubkeys,
  generateKdfParams,
  type Subkeys,
} from "../../src/crypto/keys";

let subkeys: Subkeys;

beforeEach(async () => {
  const p = generateKdfParams();
  p.memoryKiB = 8192;
  p.iterations = 1;
  subkeys = await deriveSubkeys(await deriveMasterKey("pw", p));
});

const bytes = (s: string) => new TextEncoder().encode(s);

/** Lay out a realistic LEGACY (pre-0.5) vault: names + stamps in keys, as they were. */
async function legacyVault(be: MemoryBackend, name = "My Vault"): Promise<void> {
  const p = `lwsync/${name}`;
  await be.put(`${p}/meta/keyparams`, bytes(`{"params":{"algo":"argon2id"},"verifier":{}}`));
  await be.put(`${p}/meta/vaultconfig`, await sealJson(subkeys.manifestKey, { schema: 1 }));
  await be.put(`${p}/objects/ab/abcdef`, bytes("object-1"));
  await be.put(`${p}/objects/xy/xyzxyz`, bytes("object-2"));
  await be.put(
    `${p}/manifests/desktop/0.manifest`,
    await sealJson(subkeys.manifestKey, {
      schema: 1,
      generatedAt: 1,
      device: "desktop",
      paths: {},
    }),
  );
  await be.put(
    `${p}/manifests/merged/0.manifest`,
    await sealJson(subkeys.manifestKey, {
      schema: 1,
      generatedAt: 1,
      device: "merged",
      paths: {},
    }),
  );
  await be.put(
    `${p}/devices/desktop/manifest`,
    await sealJson(subkeys.manifestKey, { ".obsidian/workspace.json": null }),
  );
  await be.put(`${p}/devices/desktop/objects/ab/objkey`, bytes("device-config-object"));
  await be.put(`${p}/archives/1727000000000.lwa.enc`, bytes("archive-blob"));
  await be.put(`${p}/meta/.lws-cas-probe-junk`, bytes("1")); // transient litter — never copy
}

function relKeys(be: MemoryBackend, prefix: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [k, v] of be.store) if (k.startsWith(`${prefix}/`)) out.set(k, v);
  return out;
}

describe("layout migrator", () => {
  test("moves a legacy vault to opaque keys, byte-identical, then deletes the old prefix", async () => {
    const be = new MemoryBackend();
    await legacyVault(be);
    const legacySnapshot = relKeys(be, "lwsync/My Vault");
    expect(legacySnapshot.size).toBeGreaterThan(5);

    const report = await migrateLayout(be, "My Vault", "freshopaqueid123", subkeys);
    // Everything except the transient probe key (never copied) moved.
    expect(report.copied).toBe(legacySnapshot.size - 1);
    expect(report.deleted).toBe(legacySnapshot.size);

    // Old prefix fully gone.
    expect(relKeys(be, "lwsync/My Vault").size).toBe(0);
    // Nothing anywhere mentions the vault or device names.
    for (const key of be.store.keys()) {
      expect(key).not.toContain("My Vault");
      expect(key).not.toContain("desktop");
      expect(key).not.toContain("1727000000000");
    }

    const dir = await deviceDir(subkeys.nameKey, "desktop");
    const toP = "lwsync/freshopaqueid123";
    // Contents identical (server-side copy semantics).
    expect(await be.get(`${toP}/objects/ab/abcdef`)).toEqual(bytes("object-1"));
    expect(await be.get(`${toP}/meta/keyparams`)).toEqual(
      bytes(`{"params":{"algo":"argon2id"},"verifier":{}}`),
    );
    expect(await be.get(`${toP}/manifests/${dir}/0.manifest`)).toEqual(
      legacySnapshot.get("lwsync/My Vault/manifests/desktop/0.manifest"),
    );
    expect(await be.get(`${toP}/devices/${dir}/objects/ab/objkey`)).toEqual(
      bytes("device-config-object"),
    );
    expect(await be.get(`${toP}/manifests/merged/0.manifest`)).toEqual(
      legacySnapshot.get("lwsync/My Vault/manifests/merged/0.manifest"),
    );
    // Encrypted .id reverse-maps exist for both stores.
    expect(await be.get(`${toP}/manifests/${dir}/.id`)).not.toBeNull();
    expect(await be.get(`${toP}/devices/${dir}/.id`)).not.toBeNull();
    // Archive renamed to its HMAC key, byte-identical, and indexed.
    const archKey = await archiveKeyFor(subkeys.nameKey, 1727000000000);
    expect(await be.get(`${toP}/${archKey}`)).toEqual(bytes("archive-blob"));
    const indexBlob = await be.get(`${toP}/meta/archives`);
    expect(new TextDecoder().decode(indexBlob!)).not.toContain("1727000000000"); // encrypted index
    // Probe litter was NOT copied.
    expect(await be.get(`${toP}/meta/.lws-cas-probe-junk`)).toBeNull();
  });

  test("resumes: already-copied keys are skipped, verification still passes, old keys still deleted", async () => {
    const be = new MemoryBackend();
    await legacyVault(be);
    const legacyCount = relKeys(be, "lwsync/My Vault").size;
    const dir = await deviceDir(subkeys.nameKey, "desktop");
    // Simulate an interrupted earlier run: one key already migrated.
    await be.put(
      `lwsync/resumedid/manifests/${dir}/0.manifest`,
      (await be.get("lwsync/My Vault/manifests/desktop/0.manifest"))!,
    );
    const report = await migrateLayout(be, "My Vault", "resumedid", subkeys);
    expect(report.skipped).toBe(1);
    // legacy keys minus the probe litter (never copied) minus the pre-copied key
    expect(report.copied).toBe(legacyCount - 2);
    expect(relKeys(be, "lwsync/My Vault").size).toBe(0);
  });

  test("falls back to get+put when server-side copy is unavailable", async () => {
    const be = new MemoryBackend();
    await legacyVault(be);
    const originalCopy = be.copy.bind(be);
    be.copy = async () => {
      throw new Error("CopyObject not implemented by this provider");
    };
    const report = await migrateLayout(be, "My Vault", "fallbackid", subkeys);
    be.copy = originalCopy;
    expect(report.copied).toBeGreaterThan(0);
    expect(relKeys(be, "lwsync/My Vault").size).toBe(0);
    expect(await be.get("lwsync/fallbackid/objects/ab/abcdef")).toEqual(bytes("object-1"));
  });
});
