// The bucket's bootstrap + shared (non-secret) config.
//
// meta/keyparams  — PLAINTEXT Argon2id params + salt (a salt is non-secret); lets a new
//                   device reproduce the key derivation.
// meta/verifier   — encrypted passphrase verifier (fast wrong-passphrase rejection).
// meta/vaultconfig — encrypted VaultConfig: device registry, vault name, classification
//                   rules. NO secrets (creds/passphrase never leave the device).

import { ObjectBackend } from "./backend";
import { sealJson, openJson } from "../crypto/box";
import type { KdfParams, Verifier } from "../crypto/keys";
import type { VaultConfig } from "../types";
import { DEFAULT_DEVICE_CONFIG_GLOBS, DEFAULT_EXCLUSION_GLOBS } from "../types";

const KEYPARAMS = "meta/keyparams";
const VAULTCONFIG = "meta/vaultconfig";

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface KeyParamsDoc {
  params: KdfParams;
  verifier: Verifier;
}

export function defaultVaultConfig(vaultName: string, device: string): VaultConfig {
  return {
    schema: 1,
    vaultName,
    devices: [device],
    classificationOverrides: {},
    exclusionGlobs: [...DEFAULT_EXCLUSION_GLOBS],
    deviceConfigGlobs: [...DEFAULT_DEVICE_CONFIG_GLOBS],
    retentionDays: 0, // keep everything forever — nothing is ever purged by default
  };
}

/** Fill in defaults for fields added after a config was first written. */
export function normalizeVaultConfig(config: VaultConfig): VaultConfig {
  return { ...config, retentionDays: config.retentionDays ?? 0 };
}

export class VaultConfigStore {
  constructor(private backend: ObjectBackend) {}

  /** True if this prefix already hosts an initialized vault. */
  async isInitialized(): Promise<boolean> {
    return (await this.backend.head(KEYPARAMS)) !== null;
  }

  /** Plaintext bootstrap doc (salt + KDF params + verifier). Safe to read pre-auth. */
  async readKeyParams(): Promise<KeyParamsDoc | null> {
    const blob = await this.backend.get(KEYPARAMS);
    if (!blob) return null;
    return JSON.parse(dec.decode(blob)) as KeyParamsDoc;
  }

  async writeKeyParams(doc: KeyParamsDoc): Promise<void> {
    await this.backend.put(KEYPARAMS, enc.encode(JSON.stringify(doc)));
  }

  async readConfig(manifestKey: Uint8Array): Promise<VaultConfig | null> {
    const blob = await this.backend.get(VAULTCONFIG);
    if (!blob) return null;
    const config = await openJson<VaultConfig>(manifestKey, blob);
    return normalizeVaultConfig(config);
  }

  async writeConfig(manifestKey: Uint8Array, config: VaultConfig): Promise<void> {
    await this.backend.put(VAULTCONFIG, await sealJson(manifestKey, config));
  }

  /** Register a device in the shared config if not already present. */
  async registerDevice(manifestKey: Uint8Array, device: string): Promise<VaultConfig> {
    const config = (await this.readConfig(manifestKey))!;
    if (!config.devices.includes(device)) {
      config.devices.push(device);
      await this.writeConfig(manifestKey, config);
    }
    return config;
  }
}
