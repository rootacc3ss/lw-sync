import { describe, test, expect } from "vitest";
import { MemoryBackend } from "../helpers/memory-backend";
import { PrefixedBackend } from "../../src/store/prefixed-backend";
import { VaultConfigStore, defaultVaultConfig } from "../../src/store/vault-config";
import {
  discoverVaults,
  listVaultIds,
  tryOpenVault,
  randomVaultId,
  DISCOVERY_LIMIT,
} from "../../src/store/vault-locator";
import {
  deriveMasterKey,
  deriveSubkeys,
  generateKdfParams,
  createVerifier,
  type KdfParams,
} from "../../src/crypto/keys";

/** A light-but-real vault in the bucket, exactly as initNewVault would lay it out. */
async function createVault(
  be: MemoryBackend,
  locator: string,
  passphrase: string,
  label: string,
): Promise<{ params: KdfParams }> {
  const params = generateKdfParams();
  params.memoryKiB = 8192;
  params.iterations = 1;
  const subkeys = await deriveSubkeys(await deriveMasterKey(passphrase, params));
  const verifier = await createVerifier(subkeys.verifyKey);
  const vc = new VaultConfigStore(new PrefixedBackend(be, `lwsync/${locator}`));
  await vc.writeKeyParams({ params, verifier });
  await vc.writeConfig(subkeys.manifestKey, defaultVaultConfig(label, "desktop"));
  return { params };
}

describe("vault locator — discovery by passphrase", () => {
  test("finds the vault that opens with the passphrase, with its decrypted label", async () => {
    const be = new MemoryBackend();
    await createVault(be, "abc234def", "correct horse", "my secret vault");
    const found = await discoverVaults(be, "correct horse");
    expect(found).toHaveLength(1);
    expect(found[0].vaultId).toBe("abc234def");
    expect(found[0].vaultName).toBe("my secret vault");
  });

  test("a wrong passphrase finds nothing (and does not throw)", async () => {
    const be = new MemoryBackend();
    await createVault(be, "abc234def", "correct horse", "v");
    expect(await discoverVaults(be, "wrong pass")).toEqual([]);
    expect(await tryOpenVault(be, "abc234def", "wrong pass")).toBeNull();
  });

  test("several vaults sharing a passphrase are all found", async () => {
    const be = new MemoryBackend();
    await createVault(be, "id1111", "shared pass", "work vault");
    await createVault(be, "id2222", "shared pass", "personal vault");
    const found = await discoverVaults(be, "shared pass");
    expect(found.map((v) => v.vaultName).sort()).toEqual(["personal vault", "work vault"]);
  });

  test("a legacy pre-0.5 vault (its name IS the locator) is still discovered", async () => {
    const be = new MemoryBackend();
    await createVault(be, "My Plain Vault Name", "pass", "My Plain Vault Name");
    const found = await discoverVaults(be, "pass");
    expect(found).toHaveLength(1);
    expect(found[0].vaultId).toBe("My Plain Vault Name");
  });

  test("listVaultIds returns top-level ids only; tryOpenVault misses absent vaults", async () => {
    const be = new MemoryBackend();
    await createVault(be, "idA", "p", "a");
    await createVault(be, "idB", "p", "b");
    expect((await listVaultIds(be)).sort()).toEqual(["idA", "idB"]);
    expect(await tryOpenVault(be, "nope", "p")).toBeNull();
  });

  test("discovery is bounded by the candidate limit", async () => {
    expect(DISCOVERY_LIMIT).toBeLessThanOrEqual(10); // each candidate = one Argon2id
    const be = new MemoryBackend();
    // Fill every slot with decoy vaults; the needle sits BEYOND the limit.
    const ids = Array.from({ length: DISCOVERY_LIMIT + 3 }, (_, i) => `id${i}`);
    for (const id of ids.slice(0, DISCOVERY_LIMIT))
      await createVault(be, id, "decoy", `vault ${id}`);
    await createVault(be, ids[ids.length - 1], "needle", "find me"); // beyond the limit
    expect(await discoverVaults(be, "needle")).toEqual([]); // never reached it
    expect((await discoverVaults(be, "decoy")).map((v) => v.vaultId)).toEqual(
      ids.slice(0, DISCOVERY_LIMIT),
    );
  });

  test("randomVaultId is opaque, unique-ish, and never a name", async () => {
    const a = randomVaultId();
    const b = randomVaultId();
    expect(a).toMatch(/^[a-z2-7]{20,}$/);
    expect(a).not.toBe(b);
  });
});
