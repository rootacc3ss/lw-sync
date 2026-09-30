// Vault discovery: find which vault(s) under `lwsync/` open with a passphrase.
//
// A vault's location is a RANDOM opaque id (`lwsync/<vaultId>/`) — never derived from the
// vault name, so the bucket operator sees nothing. Discovery authenticates by
// passphrase: each candidate's plaintext `meta/keyparams` (salt + KDF params + verifier)
// is read, the keys derived, and the verifier checked. Only a vault that opens with the
// passphrase is returned. Wrong passphrase => zero candidates, cleanly.

import type { ObjectBackend } from "./backend";
import type { KdfParams, Subkeys } from "../crypto/keys";
import { deriveMasterKey, deriveSubkeys, checkVerifier } from "../crypto/keys";
import { base32 } from "../crypto/object-cipher";
import { VaultConfigStore } from "./vault-config";
import { PrefixedBackend } from "./prefixed-backend";

/** How many candidate vaults we'll try to open before giving up (each = one Argon2id). */
export const DISCOVERY_LIMIT = 8;

export function randomVaultId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return base32(b);
}

/** All vault ids present under `lwsync/` (opaque; a legacy vault's id is its name). */
export function listVaultIds(raw: ObjectBackend): Promise<string[]> {
  return raw.listDirs("lwsync/");
}

/**
 * Try to open one specific vault with the passphrase. Returns the derived keys, or null
 * when the vault is absent / the passphrase does not open it.
 */
export async function tryOpenVault(
  raw: ObjectBackend,
  vaultId: string,
  passphrase: string,
): Promise<{ params: KdfParams; subkeys: Subkeys } | null> {
  const vc = new VaultConfigStore(new PrefixedBackend(raw, `lwsync/${vaultId}`));
  const kp = await vc.readKeyParams();
  if (!kp) return null;
  try {
    const params = kp.params;
    const subkeys = await deriveSubkeys(await deriveMasterKey(passphrase, params));
    if (!(await checkVerifier(subkeys.verifyKey, kp.verifier))) return null;
    return { params, subkeys };
  } catch {
    return null; // corrupt keyparams or KDF failure on this device — skip, keep scanning
  }
}

export interface LocatedVault {
  vaultId: string;
  params: KdfParams;
  subkeys: Subkeys;
  /** Decrypted vault label (from the encrypted vaultconfig), when resolvable. */
  vaultName?: string;
}

/** Every vault under `lwsync/` that opens with this passphrase (up to DISCOVERY_LIMIT). */
export async function discoverVaults(
  raw: ObjectBackend,
  passphrase: string,
): Promise<LocatedVault[]> {
  const out: LocatedVault[] = [];
  const ids = await listVaultIds(raw);
  for (const vaultId of ids.slice(0, DISCOVERY_LIMIT)) {
    const hit = await tryOpenVault(raw, vaultId, passphrase);
    if (!hit) continue;
    const vc = new VaultConfigStore(new PrefixedBackend(raw, `lwsync/${vaultId}`));
    const config = await vc.readConfig(hit.subkeys.manifestKey).catch(() => null);
    out.push({ vaultId, ...hit, vaultName: config?.vaultName });
  }
  return out;
}
