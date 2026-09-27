import { Notice, Plugin, TAbstractFile } from "obsidian";
import { Controller, DEFAULT_SETTINGS, type LwsSettings } from "./controller";
import type { S3Config } from "./types";
import { writePassphrase, writeS3Secret } from "./secrets";
import { LwsSettingTab } from "./ui/settings-tab";
import { SetupWizard } from "./ui/setup-wizard";
import { StatusBar } from "./ui/status-bar";
import { showTutorial } from "./ui/tutorial";
import { buildDebugReport } from "./debug";
import { log, logError } from "./log";

export default class LittleWoolySyncPlugin extends Plugin {
  settings!: LwsSettings;
  controller!: Controller;
  private status!: StatusBar;
  private saveTimer: number | null = null;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.controller = new Controller(this.app, this.settings);
    this.status = new StatusBar(this.addStatusBarItem());

    this.addSettingTab(new LwsSettingTab(this.app, this));
    this.addRibbonIcon("sheep", "Little Wooly Sync", () => {
      if (this.settings.configured) this.runSync();
      else this.openSetupWizard();
    });

    this.addCommand({
      id: "lws-setup",
      name: "Set up / connect",
      callback: () => this.openSetupWizard(),
    });
    this.addCommand({ id: "lws-sync", name: "Sync now", callback: () => this.runSync() });
    this.addCommand({ id: "lws-audit", name: "Coverage audit", callback: () => this.runAudit() });
    this.addCommand({ id: "lws-repair", name: "Repair", callback: () => this.runRepair() });
    this.addCommand({
      id: "lws-tutorial",
      name: "Show tutorial",
      callback: () => showTutorial(this.app),
    });
    this.addCommand({
      id: "lws-debug",
      name: "Write debug report",
      callback: () => this.writeDebugReport(),
    });

    this.app.workspace.onLayoutReady(async () => {
      if (!this.settings.configured) {
        new Notice("Little Wooly Sync: open settings to set up your encrypted backup.");
        return;
      }
      if (!this.controller.hasPassphrase()) {
        this.status.set("error", "passphrase missing — re-run setup");
        return;
      }
      try {
        const ok = await this.controller.unlock();
        if (!ok) {
          this.status.set("error", "wrong passphrase — re-run setup");
          return;
        }
        if (this.settings.syncOnStart) await this.runSync();
        else this.status.set("idle", "ready");
      } catch (e) {
        this.status.set("error", (e as Error).message);
        logError("startup unlock", e);
      }
    });

    if (this.settings.syncIntervalSec > 0) {
      this.registerInterval(
        window.setInterval(() => this.runSync(), this.settings.syncIntervalSec * 1000),
      );
    }
    if (this.settings.syncOnSave) {
      // Vault events fired by our OWN sync writes are ignored (tracked per-path by the
      // controller) — otherwise every download would schedule a redundant echo sync.
      const sched = (file: TAbstractFile) => this.scheduleSync(file.path);
      this.registerEvent(this.app.vault.on("modify", sched));
      this.registerEvent(this.app.vault.on("create", sched));
      this.registerEvent(this.app.vault.on("delete", sched));
      this.registerEvent(this.app.vault.on("rename", (file) => sched(file)));
    }

    // Returning from background (esp. mobile, where the app suspends) triggers a sync —
    // timers and events don't run while the app is suspended.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden) this.scheduleSync();
    });
  }

  onunload(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
  }

  openSetupWizard(): void {
    new SetupWizard(this.app, this.controller, this.settings, async () => {
      await this.saveSettings();
      await this.runSync();
    }).open();
  }

  private scheduleSync(path?: string): void {
    if (this.syncing) return;
    if (path && this.controller.recentlySelfWrote(path)) return;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.runSync(), 4000); // debounce editor saves
  }

  async runSync(): Promise<void> {
    if (!this.controller.ready || this.syncing) return;
    this.syncing = true;
    this.status.set("syncing", "syncing…");
    const t0 = Date.now();
    log("info", "sync started");
    try {
      const r = await this.controller.sync();
      const note =
        `↑${r.uploaded} ↓${r.downloaded} 🗑${r.deletedLocal}` +
        (r.mergedJson.length ? ` ⟲${r.mergedJson.length} merged` : "") +
        (r.conflictCopies.length ? ` ⚠${r.conflictCopies.length} conflict copies` : "");
      this.status.set(r.conflictCopies.length ? "warn" : "ok", note);
      log(
        r.conflictCopies.length ? "warn" : "info",
        `sync finished in ${((Date.now() - t0) / 1000).toFixed(1)}s — uploaded=${r.uploaded} downloaded=${r.downloaded} deletedLocal=${r.deletedLocal} mergedJson=${r.mergedJson.length} conflictCopies=${r.conflictCopies.length}`,
        r.conflictCopies.length ? r.conflictCopies.join(", ") : undefined,
      );
      if (r.mergedJson.length) new Notice(`Synced with 3-way merge: ${r.mergedJson.join(", ")}`);
      if (r.conflictCopies.length)
        new Notice(`Sync kept ${r.conflictCopies.length} conflict copies.`);
    } catch (e) {
      this.status.set("error", (e as Error).message);
      logError("sync", e);
      new Notice(`Little Wooly Sync error: ${(e as Error).message}`);
    } finally {
      this.syncing = false;
    }
  }

  async runAudit(): Promise<void> {
    if (!this.controller.ready) return void new Notice("Not connected yet.");
    this.status.set("syncing", "auditing…");
    const t0 = Date.now();
    try {
      const r = await this.controller.audit(true);
      this.status.set(r.criticalCount ? "error" : "ok", r.verdict);
      log(
        r.criticalCount ? "warn" : "info",
        `audit finished in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${r.verdict} (critical=${r.criticalCount}, ratio=${r.ratio.toFixed(3)})`,
      );
      new Notice(
        `${r.verdict}\nplaintext ${(r.plaintextBytes / 1e6).toFixed(1)}MB → stored ${(r.storedBytes / 1e6).toFixed(1)}MB (ratio ${r.ratio.toFixed(2)})\nexcluded by rule: ${r.excluded.length} item(s) — see debug report for the roster`,
        10000,
      );
    } catch (e) {
      this.status.set("error", (e as Error).message);
      logError("audit", e);
    }
  }

  async runRepair(): Promise<void> {
    if (!this.controller.ready) return void new Notice("Not connected yet.");
    this.status.set("syncing", "repairing…");
    const t0 = Date.now();
    try {
      const { before, after, reuploaded } = await this.controller.repair();
      this.status.set(after.criticalCount ? "warn" : "ok", after.verdict);
      log(
        after.criticalCount ? "warn" : "info",
        `repair finished in ${((Date.now() - t0) / 1000).toFixed(1)}s — critical ${before.criticalCount}→${after.criticalCount}, reuploaded=${reuploaded}, ${after.verdict}`,
      );
      new Notice(
        `Repair: ${before.criticalCount}→${after.criticalCount} critical, re-ensured ${reuploaded} files.\n${after.verdict}`,
        10000,
      );
    } catch (e) {
      this.status.set("error", (e as Error).message);
      logError("repair", e);
    }
  }

  async writeDebugReport(): Promise<void> {
    const report = await buildDebugReport(this.controller, this.settings, Date.now());
    await this.app.vault.adapter.write("littlewooly-sync-debug.md", report);
    new Notice("Wrote littlewooly-sync-debug.md");
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as
      | (Partial<LwsSettings> & { passphrase?: string; s3?: Partial<S3Config> })
      | null;

    // One-time migration: pull plaintext secrets out of data.json into SecretStorage, then
    // strip them so they are never written back.
    const legacyPassphrase = data?.passphrase;
    const legacyS3Secret = data?.s3?.secretAccessKey;

    const s3 = { ...DEFAULT_SETTINGS.s3, ...(data?.s3 ?? {}) } as LwsSettings["s3"] & {
      secretAccessKey?: string;
    };
    delete s3.secretAccessKey;
    if (data) delete data.passphrase;

    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}), s3 };

    if (legacyPassphrase) writePassphrase(this.app, legacyPassphrase);
    if (legacyS3Secret) writeS3Secret(this.app, legacyS3Secret);
    if (legacyPassphrase || legacyS3Secret) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
