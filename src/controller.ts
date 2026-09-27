// The wiring brain: builds the full stack from settings + passphrase and exposes the
// operations the UI/commands call (connect, sync, audit, repair, device-config backup/
// restore, archive). Secrets live only here/in plugin data; nothing secret is uploaded.

import type { App } from "obsidian";
import { Notice, Platform } from "obsidian";
import type { S3Config, VaultConfig, Manifest } from "./types";
import { readPassphrase, writePassphrase, readS3Secret, writeS3Secret } from "./secrets";
import {
  SETUP_FILE,
  buildSetupDoc,
  serializeSetupDoc,
  parseSetupDoc,
  applySetupDoc,
  encryptSecrets,
  decryptSecrets,
} from "./portability";
import { collectPurgeable, applyPurge } from "./engine/retention";
import { S3Backend } from "./store/s3-client";
import { PrefixedBackend } from "./store/prefixed-backend";
import { ObjectStore } from "./store/object-store";
import { ManifestStore } from "./store/manifest-store";
import { VaultConfigStore, defaultVaultConfig } from "./store/vault-config";
import { DeviceConfigStore } from "./store/device-config-store";
import { ArchiveJob } from "./engine/archive-job";
import {
  deriveMasterKey,
  deriveSubkeys,
  generateKdfParams,
  createVerifier,
  checkVerifier,
  type Subkeys,
  type KdfParams,
  type Verifier,
} from "./crypto/keys";
import { makeClassifyOptions } from "./engine/file-classifier";
import { ObsidianVaultFS } from "./engine/obsidian-vault-fs";
import { LocalIndex } from "./engine/local-index";
import { IdbIndexBackend } from "./engine/idb-index";
import { SyncEngine, type SyncResult } from "./engine/sync-engine";
import { Repair, type RepairResult } from "./engine/repair";
import { runAudit } from "./engine/coverage-service";
import type { AuditReport } from "./engine/coverage-auditor";
import { log, logError } from "./log";

export const PLUGIN_ID = "littlewooly-sync";

/** Persisted S3 settings: everything except the secret, which lives in SecretStorage. */
export type LwsS3Settings = Omit<S3Config, "secretAccessKey">;

export interface LwsSettings {
  s3: LwsS3Settings;
  vaultName: string;
  deviceName: string;
  configured: boolean;
  syncIntervalSec: number;
  syncOnStart: boolean;
  syncOnSave: boolean;
}

export const DEFAULT_SETTINGS: LwsSettings = {
  s3: {
    endpoint: "",
    region: "us-east-1",
    accessKeyId: "",
    bucket: "",
    forcePathStyle: true,
  },
  vaultName: "",
  deviceName: "",
  configured: false,
  syncIntervalSec: 300,
  syncOnStart: true,
  syncOnSave: true,
};

interface Stack {
  prefixed: PrefixedBackend;
  s3: S3Backend;
  subkeys: Subkeys;
  objects: ObjectStore;
  manifests: ManifestStore;
  vaultConfig: VaultConfigStore;
  deviceConfig: DeviceConfigStore;
  archive: ArchiveJob;
  fs: ObsidianVaultFS;
  index: LocalIndex;
  engine: SyncEngine;
  repair: Repair;
  config: VaultConfig;
}

export class Controller {
  private stack: Stack | null = null;
  /** Paths we wrote during pull (path -> epoch ms), so vault-event handlers can tell our
   *  own sync writes apart from real user edits. */
  private selfWrites = new Map<string, number>();
  /** In-memory throttle: retention purge runs at most once a day (when enabled). */
  private lastRetentionRun = 0;

  constructor(
    private app: App,
    private settings: LwsSettings,
  ) {}

  get ready(): boolean {
    return this.stack !== null;
  }

  /** Current shared deletion-retention policy (days; 0 = keep everything forever). */
  get retentionDays(): number {
    return this.stack ? (this.stack.config.retentionDays ?? 0) : 0;
  }

  noteSelfWrite(path: string): void {
    this.selfWrites.set(path, Date.now());
    if (this.selfWrites.size > 500) {
      const cutoff = Date.now() - 60_000;
      for (const [p, t] of this.selfWrites) if (t < cutoff) this.selfWrites.delete(p);
    }
  }

  /** True if `path` was written by our own sync within the last `withinMs`. */
  recentlySelfWrote(path: string, withinMs = 10_000): boolean {
    const t = this.selfWrites.get(path);
    return t !== undefined && Date.now() - t < withinMs;
  }

  private prefix(): string {
    return `lwsync/${this.settings.vaultName}`;
  }

  private rawBackend(): S3Backend {
    // The secret is injected from SecretStorage; it is never persisted in data.json.
    return new S3Backend({ ...this.settings.s3, secretAccessKey: readS3Secret(this.app) });
  }

  /** Reachability + auth check, plus whether the backend honors conditional create. */
  async testConnection(): Promise<{ conditionalPut: boolean }> {
    const backend = this.rawBackend();
    try {
      await backend.testConnection();
    } catch (e) {
      logError("testConnection", e);
      throw e;
    }
    const conditionalPut = await backend.probeConditionalPut();
    log(
      "info",
      `testConnection ok — bucket=${this.settings.s3.bucket}, conditional PUT ${conditionalPut ? "honored" : "IGNORED (manifest CAS falls back to recompute)"}`,
    );
    return { conditionalPut };
  }

  /** True if a passphrase is stored locally (i.e. this device has been set up). */
  hasPassphrase(): boolean {
    return readPassphrase(this.app).length > 0;
  }

  /** Is there already an initialized vault at this bucket+prefix? */
  async remoteExists(): Promise<boolean> {
    const prefixed = new PrefixedBackend(this.rawBackend(), this.prefix());
    return new VaultConfigStore(prefixed).isInitialized();
  }

  /** First-time setup of a brand-new vault. */
  async initNewVault(passphrase: string): Promise<void> {
    const params = generateKdfParams();
    const subkeys = await deriveSubkeys(await deriveMasterKey(passphrase, params));
    const verifier = await createVerifier(subkeys.verifyKey);

    const prefixed = new PrefixedBackend(this.rawBackend(), this.prefix());
    const vc = new VaultConfigStore(prefixed);
    await vc.writeKeyParams({ params, verifier });
    const config = defaultVaultConfig(this.settings.vaultName, this.settings.deviceName);
    await vc.writeConfig(subkeys.manifestKey, config);

    writePassphrase(this.app, passphrase);
    this.buildStack(subkeys, config);
    log(
      "info",
      `initialized new vault (KDF m=${params.memoryKiB / 1024} MiB, t=${params.iterations})`,
    );
  }

  /** Connect to an existing vault: verify passphrase against the remote verifier. */
  async connectExisting(passphrase: string): Promise<boolean> {
    const prefixed = new PrefixedBackend(this.rawBackend(), this.prefix());
    const vc = new VaultConfigStore(prefixed);
    const kp = await vc.readKeyParams();
    if (!kp) throw new Error("No Little Wooly vault found at this bucket/prefix.");

    const params = kp.params as KdfParams;
    // Mobile WKWebView has a tighter WASM memory budget than desktop; a legacy high-memory
    // Argon2id profile can fail to derive on a phone. Warn before the attempt.
    if (Platform.isMobileApp && params.memoryKiB > 131_072) {
      new Notice(
        `This vault's key derivation needs ${Math.round(
          params.memoryKiB / 1024,
        )} MiB, which may exceed available memory on mobile.`,
        10000,
      );
    }

    const subkeys = await deriveSubkeys(await deriveMasterKey(passphrase, params));
    if (!(await checkVerifier(subkeys.verifyKey, kp.verifier as Verifier))) {
      log("warn", "connect to existing vault failed — wrong passphrase");
      return false;
    }

    const config =
      (await vc.readConfig(subkeys.manifestKey)) ??
      defaultVaultConfig(this.settings.vaultName, this.settings.deviceName);
    await vc.writeConfig(subkeys.manifestKey, {
      ...config,
      devices: config.devices.includes(this.settings.deviceName)
        ? config.devices
        : [...config.devices, this.settings.deviceName],
    });
    writePassphrase(this.app, passphrase);
    this.buildStack(subkeys, config);
    log("info", `connected to existing vault as device "${this.settings.deviceName}"`);
    return true;
  }

  /** Rebuild the stack from stored settings + passphrase (called on load when configured). */
  async unlock(): Promise<boolean> {
    const pass = readPassphrase(this.app);
    if (!pass) return false;
    return this.connectExisting(pass);
  }

  private buildStack(subkeys: Subkeys, config: VaultConfig): void {
    const prefixed = new PrefixedBackend(this.rawBackend(), this.prefix());
    const opts = makeClassifyOptions(config, PLUGIN_ID);
    const fs = new ObsidianVaultFS(this.app, opts, (p) => this.noteSelfWrite(p));
    const objects = new ObjectStore(prefixed, subkeys);
    const manifests = new ManifestStore(prefixed, subkeys.manifestKey);
    const index = new LocalIndex(new IdbIndexBackend(`lws-${this.settings.vaultName}`));
    const engine = new SyncEngine(this.settings.deviceName, fs, objects, manifests, index);
    this.stack = {
      prefixed,
      s3: this.rawBackend(),
      subkeys,
      objects,
      manifests,
      vaultConfig: new VaultConfigStore(prefixed),
      deviceConfig: new DeviceConfigStore(prefixed, subkeys),
      archive: new ArchiveJob(prefixed, subkeys),
      fs,
      index,
      engine,
      repair: new Repair(engine, objects, index, fs, manifests, prefixed),
      config,
    };
  }

  private require(): Stack {
    if (!this.stack) throw new Error("Little Wooly Sync is not unlocked/configured.");
    return this.stack;
  }

  async sync(): Promise<SyncResult> {
    const s = this.require();
    const result = await s.engine.sync();
    const backedUp = await s.deviceConfig.backup(s.fs, this.settings.deviceName);
    if (backedUp > 0) log("info", `device-config backup: ${backedUp} file(s)`);
    await this.runRetention(s);
    return result;
  }

  /** Change the shared deletion-retention policy (writes the encrypted VaultConfig). */
  async setRetention(days: number): Promise<void> {
    const s = this.require();
    const config: VaultConfig = { ...s.config, retentionDays: Math.max(0, Math.floor(days)) };
    await s.vaultConfig.writeConfig(s.subkeys.manifestKey, config);
    s.config = config;
  }

  /**
   * Opt-in deletion retention (retentionDays > 0 only; default 0 = nothing is ever
   * deleted). At most once a day, purge objects of paths tombstoned on EVERY device
   * manifest and older than the window. See engine/retention.ts for the safety rules.
   */
  private async runRetention(s: Stack): Promise<void> {
    const days = s.config.retentionDays ?? 0;
    if (days <= 0) return;
    const now = Date.now();
    if (now - this.lastRetentionRun < 86_400_000) return;
    this.lastRetentionRun = now;

    const manifests: Manifest[] = [];
    for (const d of await s.manifests.listDevices()) {
      const m = await s.manifests.readDeviceLatest(d);
      if (m) manifests.push(m);
    }
    const candidates = collectPurgeable(manifests, now, days);
    if (!candidates.length) return;
    const purged = await applyPurge(s.objects, candidates, await s.manifests.readMerged());
    if (purged > 0) {
      log("warn", `retention purge removed ${purged} object(s) past the ${days}-day window`);
      new Notice(
        `Little Wooly Sync: retention purged ${purged} object(s) for files deleted more than ${days} day(s) ago.`,
        8000,
      );
    }
  }

  /** Write the setup file to the vault root (secrets only if a passphrase is given). */
  async exportSetup(includeSecrets: boolean, exportPassphrase?: string): Promise<void> {
    const secrets =
      includeSecrets && exportPassphrase
        ? await encryptSecrets(exportPassphrase, {
            s3SecretAccessKey: readS3Secret(this.app),
            passphrase: readPassphrase(this.app),
          })
        : null;
    const doc = buildSetupDoc(this.settings, secrets);
    await this.app.vault.adapter.write(SETUP_FILE, serializeSetupDoc(doc));
    log("info", `exported setup file (${includeSecrets ? "with" : "without"} sealed secrets)`);
  }

  /** Read the setup file from the vault root into live settings (+ secrets if present). */
  async importSetup(exportPassphrase?: string): Promise<{ hadSecrets: boolean }> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(SETUP_FILE))) {
      throw new Error(`${SETUP_FILE} not found in the vault root.`);
    }
    const doc = parseSetupDoc(await adapter.read(SETUP_FILE));
    applySetupDoc(this.settings, doc);
    if (doc.secrets) {
      const secrets = await decryptSecrets(doc.secrets, exportPassphrase ?? "");
      writeS3Secret(this.app, secrets.s3SecretAccessKey);
      writePassphrase(this.app, secrets.passphrase);
    }
    log("info", `imported setup file (secrets ${doc.secrets ? "restored" : "absent"})`);
    return { hadSecrets: doc.secrets !== null };
  }

  audit(deep = true): Promise<AuditReport> {
    const s = this.require();
    return runAudit(s.fs, s.manifests, s.prefixed, s.objects, { deep });
  }

  repair(): Promise<RepairResult> {
    return this.require().repair.repair();
  }

  backupDeviceConfig(): Promise<number> {
    const s = this.require();
    return s.deviceConfig.backup(s.fs, this.settings.deviceName);
  }

  listBackedUpDevices(): Promise<string[]> {
    return this.require().deviceConfig.listBackedUpDevices();
  }

  restoreDeviceConfig(fromDevice: string): Promise<number> {
    const s = this.require();
    return s.deviceConfig.restore(s.fs, fromDevice);
  }

  async createArchive(stamp: number, keep = 23): Promise<string> {
    const s = this.require();
    const key = await s.archive.create(s.fs, stamp);
    await s.archive.prune(keep);
    log("info", `created catch-all archive ${key}`);
    return key;
  }
}
