// The wiring brain: builds the full stack from settings + passphrase and exposes the
// operations the UI/commands call (connect, sync, audit, repair, device-config backup/
// restore, archive, layout migration). Secrets live only here/in plugin data; nothing
// secret is uploaded.
//
// Vault location = `lwsync/<vaultId>/` where vaultId is a random opaque string — the
// vault NAME never appears in a bucket key (it lives encrypted inside meta/vaultconfig).
// A vault is found by passphrase (see store/vault-locator.ts). Legacy pre-0.5 vaults
// (name-based prefix) keep working until migrated via migrateLayout().

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
import { migrateLayout as runMigration, type MigrationReport } from "./engine/layout-migrator";
import {
  randomVaultId,
  discoverVaults as scanVaults,
  tryOpenVault,
  type LocatedVault,
} from "./store/vault-locator";
import { base32 } from "./crypto/object-cipher";
import {
  deriveMasterKey,
  deriveSubkeys,
  generateKdfParams,
  createVerifier,
  type Subkeys,
  type KdfParams,
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
import { type AutoSyncMode, isAutoSyncMode } from "./sync-scheduler";

export const PLUGIN_ID = "littlewooly-sync";

/** Persisted S3 settings: everything except the secret, which lives in SecretStorage. */
export type LwsS3Settings = Omit<S3Config, "secretAccessKey">;

/** When automatic (non-manual) sync notices appear. */
export type SyncNoticeLevel = "quiet" | "changes" | "verbose" | "off";
const NOTICE_LEVELS: SyncNoticeLevel[] = ["quiet", "changes", "verbose", "off"];

export interface LwsSettings {
  s3: LwsS3Settings;
  /** Random opaque vault locator (`lwsync/<vaultId>/`). Empty = legacy name-based layout. */
  vaultId: string;
  /** Display label only — lives encrypted inside the vault config, never in a key. */
  vaultName: string;
  deviceName: string;
  configured: boolean;
  syncOnStart: boolean;
  /** Sync shortly after files change, in any auto-sync mode. */
  syncOnSave: boolean;
  autoSyncMode: AutoSyncMode;
  /** periodic mode: seconds between syncs. */
  autoSyncIntervalSec: number;
  /** live mode: seconds of quiet after a change before syncing. */
  liveIdleSec: number;
  showStatusBar: boolean;
  syncNotices: SyncNoticeLevel;
}

export const DEFAULT_SETTINGS: LwsSettings = {
  s3: {
    endpoint: "",
    region: "us-east-1",
    accessKeyId: "",
    bucket: "",
    forcePathStyle: true,
  },
  vaultId: "",
  vaultName: "",
  deviceName: "",
  configured: false,
  syncOnStart: true,
  syncOnSave: true,
  autoSyncMode: "periodic",
  autoSyncIntervalSec: 300,
  liveIdleSec: 5,
  showStatusBar: true,
  syncNotices: "quiet",
};

/**
 * One-time migration of pre-0.4 trigger settings: `syncIntervalSec` becomes
 * autoSyncMode/autoSyncIntervalSec. Mutates the raw persisted record in place;
 * safe to run on every load (also unit-tested directly).
 */
export function migrateLegacyTriggers(raw: Record<string, unknown>): void {
  if (typeof raw.syncIntervalSec === "number" && !isAutoSyncMode(raw.autoSyncMode)) {
    raw.autoSyncMode = raw.syncIntervalSec > 0 ? "periodic" : "off";
    if (raw.syncIntervalSec > 0) raw.autoSyncIntervalSec = raw.syncIntervalSec;
  }
  delete raw.syncIntervalSec;
}

/** Clamp/repair trigger fields after merging defaults (corrupt data never breaks sync). */
export function sanitizeTriggers(s: LwsSettings): void {
  if (!isAutoSyncMode(s.autoSyncMode)) s.autoSyncMode = "periodic";
  s.autoSyncIntervalSec = Math.max(15, Math.floor(s.autoSyncIntervalSec) || 300);
  s.liveIdleSec = Math.min(300, Math.max(2, Math.floor(s.liveIdleSec) || 5));
  if (!(NOTICE_LEVELS as string[]).includes(s.syncNotices)) s.syncNotices = "quiet";
}

interface Stack {
  prefixed: PrefixedBackend;
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
  /** Cached conditional-PUT verdict, probed once after unlock. */
  private condPut: boolean | null = null;

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

  /** True while this device is synced through the legacy name-based prefix (pre-0.5). */
  get legacyLayout(): boolean {
    if (!this.stack) return false;
    return !this.settings.vaultId || this.settings.vaultId === this.settings.vaultName;
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
    return `lwsync/${this.settings.vaultId || this.settings.vaultName}`;
  }

  private rawBackend(): S3Backend {
    // The secret is injected from SecretStorage; it is never persisted in data.json.
    return new S3Backend({ ...this.settings.s3, secretAccessKey: readS3Secret(this.app) });
  }

  /** Reachability + auth check (read-only; needs no passphrase and no vault prefix). */
  async testConnection(): Promise<void> {
    try {
      await this.rawBackend().testConnection();
    } catch (e) {
      logError("testConnection", e);
      throw e;
    }
    log("info", `testConnection ok — bucket=${this.settings.s3.bucket}`);
  }

  /**
   * Whether the backend honors conditional create (If-None-Match). Probed once after
   * unlock, with a random key inside our prefix (respects prefix-scoped IAM policies,
   * no device name in the key, no cross-device races). Cached per session.
   */
  async conditionalPut(): Promise<boolean> {
    if (!this.stack) return false;
    if (this.condPut === null) await this.probeConditionalPut();
    return this.condPut ?? false;
  }

  private async probeConditionalPut(): Promise<void> {
    if (!this.stack) return;
    const rand = base32(globalThis.crypto.getRandomValues(new Uint8Array(8)));
    let ok = false;
    try {
      ok = await this.rawBackend().probeConditionalPut(
        `${this.prefix()}/meta/.lws-cas-probe-${rand}`,
      );
    } catch (e) {
      logError("conditional-PUT probe", e);
    }
    this.condPut = ok;
    log(
      "info",
      `conditional PUT ${ok ? "honored" : "not verified (ignored, unreadable, or probe denied)"} — manifest CAS ${ok ? "uses the strict write lock" : "falls back to recompute"}`,
    );
  }

  /** True if a passphrase is stored locally (i.e. this device has been set up). */
  hasPassphrase(): boolean {
    return readPassphrase(this.app).length > 0;
  }

  /** All vaults in this bucket that open with this passphrase (see vault-locator). */
  discoverVaults(passphrase: string): Promise<LocatedVault[]> {
    return scanVaults(this.rawBackend(), passphrase);
  }

  /** First-time setup of a brand-new vault under a fresh random opaque id. */
  async initNewVault(passphrase: string): Promise<void> {
    if (!this.settings.vaultName) this.settings.vaultName = this.app.vault.getName();
    this.settings.vaultId = randomVaultId();
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
      `initialized new vault under opaque id (KDF m=${params.memoryKiB / 1024} MiB, t=${params.iterations})`,
    );
  }

  /**
   * Open the vault that matches this passphrase. Resolution order: an explicit vaultId
   * (wizard picker) -> the saved vaultId -> the legacy name-based prefix -> discovery.
   * Returns false when nothing opens with the passphrase.
   */
  async connectExisting(passphrase: string, vaultId?: string): Promise<boolean> {
    const hit = await this.resolveVault(passphrase, vaultId);
    if (!hit) return false;
    return this.connectToVault(hit, passphrase);
  }

  /** Connect using an already-derived located vault (no second KDF pass). */
  async connectLocated(hit: LocatedVault, passphrase: string): Promise<boolean> {
    return this.connectToVault(hit, passphrase);
  }

  private async resolveVault(passphrase: string, vaultId?: string): Promise<LocatedVault | null> {
    const raw = this.rawBackend();
    let hit: LocatedVault | null = null;

    if (vaultId) {
      const opened = await tryOpenVault(raw, vaultId, passphrase);
      if (opened) hit = { vaultId, ...opened };
    }
    if (!hit && this.settings.vaultId) {
      const opened = await tryOpenVault(raw, this.settings.vaultId, passphrase);
      if (opened) hit = { vaultId: this.settings.vaultId, ...opened };
    }
    if (!hit && this.settings.vaultName && !vaultId) {
      // legacy pre-0.5 layout: the vault lived under its name
      const opened = await tryOpenVault(raw, this.settings.vaultName, passphrase);
      if (opened) hit = { vaultId: this.settings.vaultName, ...opened };
    }
    if (!hit) {
      const found = await scanVaults(raw, passphrase);
      if (found.length === 0) {
        log("warn", "connect failed — no vault in this bucket opens with this passphrase");
        return null;
      }
      if (found.length > 1 && !vaultId)
        throw new Error(
          "Multiple vaults open with this passphrase — re-run setup to choose which.",
        );
      hit = found[0];
    }
    return hit;
  }

  private async connectToVault(hit: LocatedVault, passphrase: string): Promise<boolean> {
    this.settings.vaultId = hit.vaultId;
    this.mobileKdfWarn(hit.params);
    const prefixed = new PrefixedBackend(this.rawBackend(), this.prefix());
    const vc = new VaultConfigStore(prefixed);
    const config =
      (await vc.readConfig(hit.subkeys.manifestKey)) ??
      defaultVaultConfig(this.settings.vaultName, this.settings.deviceName);
    if (config.vaultName) this.settings.vaultName = config.vaultName; // label sync
    await vc.writeConfig(hit.subkeys.manifestKey, {
      ...config,
      devices: config.devices.includes(this.settings.deviceName)
        ? config.devices
        : [...config.devices, this.settings.deviceName],
    });

    writePassphrase(this.app, passphrase);
    this.buildStack(hit.subkeys, config);
    await this.probeConditionalPut();
    log(
      "info",
      `connected as device "${this.settings.deviceName}" (${this.legacyLayout ? "legacy name-based layout — migration available" : "opaque layout"})`,
    );
    return true;
  }

  /** Rebuild the stack from stored settings + passphrase (called on load when configured). */
  async unlock(): Promise<boolean> {
    const pass = readPassphrase(this.app);
    if (!pass) return false;
    return this.connectExisting(pass);
  }

  /**
   * Re-key a legacy vault to the opaque layout: copy everything under a fresh random
   * vaultId (with HMAC device dirs + archive index), verify, then delete the old keys.
   * Run from ONE device after every device has updated to >= 0.5.0.
   */
  async migrateLayout(): Promise<MigrationReport> {
    const s = this.require();
    if (!this.legacyLayout)
      throw new Error("Nothing to migrate — this vault already uses the opaque layout.");
    if (!this.settings.vaultName)
      throw new Error("Legacy vault name missing from settings — re-run setup first.");
    const vaultId = randomVaultId();
    const report = await runMigration(
      this.rawBackend(),
      this.settings.vaultName,
      vaultId,
      s.subkeys,
    );
    this.settings.vaultId = vaultId;
    this.buildStack(s.subkeys, s.config); // rebuild under the new prefix
    log(
      "info",
      `migrated bucket layout to opaque ids — copied=${report.copied} skipped=${report.skipped} deleted=${report.deleted}`,
    );
    return report;
  }

  // Mobile WKWebView has a tighter WASM memory budget than desktop; a legacy high-memory
  // Argon2id profile can fail to derive on a phone. Warn before the attempt.
  private mobileKdfWarn(params: KdfParams): void {
    if (Platform.isMobileApp && params.memoryKiB > 131_072) {
      new Notice(
        `This vault's key derivation needs ${Math.round(
          params.memoryKiB / 1024,
        )} MiB, which may exceed available memory on mobile.`,
        10000,
      );
    }
  }

  private buildStack(subkeys: Subkeys, config: VaultConfig): void {
    const prefixed = new PrefixedBackend(this.rawBackend(), this.prefix());
    const opts = makeClassifyOptions(config, PLUGIN_ID);
    const fs = new ObsidianVaultFS(this.app, opts, (p) => this.noteSelfWrite(p));
    const objects = new ObjectStore(prefixed, subkeys);
    const manifests = new ManifestStore(prefixed, subkeys.manifestKey, subkeys.nameKey);
    const index = new LocalIndex(
      new IdbIndexBackend(`lws-${this.settings.vaultId || this.settings.vaultName}`),
    );
    const engine = new SyncEngine(this.settings.deviceName, fs, objects, manifests, index);
    this.stack = {
      prefixed,
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
    for (const dir of await s.manifests.listManifestDirs()) {
      const m = await s.manifests.readDirLatest(dir);
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
    log("info", "created catch-all archive (opaque key)");
    return key;
  }
}
