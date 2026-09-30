import { describe, test, expect, beforeAll } from "vitest";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { S3Backend } from "../../src/store/s3-client";
import { PrefixedBackend } from "../../src/store/prefixed-backend";
import { VaultConfigStore, defaultVaultConfig } from "../../src/store/vault-config";
import { discoverVaults } from "../../src/store/vault-locator";
import { migrateLayout } from "../../src/engine/layout-migrator";
import { deviceDir } from "../../src/store/manifest-store";
import { archiveKeyFor } from "../../src/engine/archive-job";
import { sealJson } from "../../src/crypto/box";
import {
  deriveMasterKey,
  deriveSubkeys,
  generateKdfParams,
  createVerifier,
  type Subkeys,
} from "../../src/crypto/keys";
import type { S3Config } from "../../src/types";

const cfg: S3Config = {
  endpoint: process.env.LWS_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  region: "us-east-1",
  accessKeyId: process.env.LWS_S3_ACCESS_KEY ?? "minioadmin",
  secretAccessKey: process.env.LWS_S3_SECRET_KEY ?? "minioadmin",
  bucket: process.env.LWS_S3_BUCKET ?? "lws-test",
  forcePathStyle: true,
};

let reachable = false;
let subkeys: Subkeys;
const legacyName = `e2e-mig-${Math.floor(Date.now() / 1000)}`;

beforeAll(async () => {
  const admin = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  try {
    await admin.send(new CreateBucketCommand({ Bucket: cfg.bucket })).catch(() => {});
    await new S3Backend(cfg).testConnection();
    reachable = true;
  } catch {
    reachable = false;
  }
  const p = generateKdfParams();
  p.memoryKiB = 8192;
  p.iterations = 1;
  subkeys = await deriveSubkeys(await deriveMasterKey("pw", p));
}, 30_000);

const bytes = (s: string) => new TextEncoder().encode(s);

describe("layout migration + discovery over real MinIO", () => {
  test("passphrase discovery finds the vault; migration re-keys it server-side", async () => {
    if (!reachable) return;
    const raw = new S3Backend(cfg);

    // --- Lay out a realistic LEGACY vault (pre-0.5: name in the prefix, names in keys).
    const params = generateKdfParams();
    params.memoryKiB = 8192;
    params.iterations = 1;
    const sk = await deriveSubkeys(await deriveMasterKey("pw", params));
    const verifier = await createVerifier(sk.verifyKey);
    const legacyP = `lwsync/${legacyName}`;
    const vc = new VaultConfigStore(new PrefixedBackend(raw, legacyP));
    await vc.writeKeyParams({ params, verifier });
    await vc.writeConfig(sk.manifestKey, defaultVaultConfig("Migration E2E", "desktop"));
    await raw.put(`${legacyP}/objects/ab/abcdef`, bytes("object-1"));
    await raw.put(`${legacyP}/objects/xy/xyzxyz`, bytes("object-2"));
    await raw.put(
      `${legacyP}/manifests/desktop/0.manifest`,
      await sealJson(sk.manifestKey, { schema: 1, generatedAt: 1, device: "desktop", paths: {} }),
    );
    await raw.put(
      `${legacyP}/devices/desktop/manifest`,
      await sealJson(sk.manifestKey, { ".obsidian/workspace.json": null }),
    );
    await raw.put(`${legacyP}/devices/desktop/objects/ab/objkey`, bytes("device-config-object"));
    await raw.put(`${legacyP}/archives/1727000000000.lwa.enc`, bytes("archive-blob"));

    // --- Discovery (real listing + real verifier check) finds it by passphrase.
    const found = await discoverVaults(raw, "pw");
    const mine = found.find((v) => v.vaultId === legacyName);
    expect(mine).toBeDefined();
    expect(mine!.vaultName).toBe("Migration E2E");
    expect(await discoverVaults(raw, "wrong")).toEqual([]);

    // --- Migrate: server-side CopyObject path, verify, delete old keys.
    const report = await migrateLayout(raw, legacyName, "opaquee2eid1234", subkeys);
    expect(report.copied).toBe(8);
    expect(report.deleted).toBe(8);

    // Old prefix fully gone; nothing anywhere carries the legacy names.
    const all = await raw.list("lwsync/");
    expect(all.filter((o) => o.key.includes(legacyName))).toEqual([]);
    for (const o of all) {
      expect(o.key).not.toContain("desktop");
      expect(o.key).not.toContain("1727000000000");
    }

    // Contents byte-identical under the new prefix; old keys truly deleted.
    const toP = "lwsync/opaquee2eid1234";
    expect(await raw.get(`${toP}/objects/ab/abcdef`)).toEqual(bytes("object-1"));
    expect(await raw.get(`${legacyP}/objects/ab/abcdef`)).toBeNull();

    // Device dirs are HMAC'd, with encrypted .id reverse-maps.
    const dir = await deviceDir(subkeys.nameKey, "desktop");
    expect(await raw.get(`${toP}/manifests/${dir}/0.manifest`)).not.toBeNull();
    expect(await raw.get(`${toP}/manifests/${dir}/.id`)).not.toBeNull();
    expect(await raw.get(`${toP}/devices/${dir}/objects/ab/objkey`)).toEqual(
      bytes("device-config-object"),
    );
    expect(await raw.get(`${toP}/devices/${dir}/.id`)).not.toBeNull();

    // Archive renamed to its opaque key + indexed.
    const archKey = await archiveKeyFor(subkeys.nameKey, 1727000000000);
    expect(await raw.get(`${toP}/${archKey}`)).toEqual(bytes("archive-blob"));
    expect(await raw.get(`${toP}/meta/archives`)).not.toBeNull();

    // Discovery still finds the vault after migration (new random id, same passphrase).
    const after = await discoverVaults(raw, "pw");
    expect(after.find((v) => v.vaultId === "opaquee2eid1234")).toBeDefined();
    expect(after.find((v) => v.vaultName === "Migration E2E")).toBeDefined();
  }, 60_000);
});
