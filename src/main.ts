import { Notice, Plugin, TAbstractFile } from "obsidian";
import {
  Controller,
  DEFAULT_SETTINGS,
  migrateLegacyTriggers,
  sanitizeTriggers,
  type LwsSettings,
} from "./controller";
import type { S3Config } from "./types";
import { writePassphrase, writeS3Secret } from "./secrets";
import { LwsSettingTab } from "./ui/settings-tab";
import { SetupWizard } from "./ui/setup-wizard";
import { StatusBar } from "./ui/status-bar";
import { showTutorial } from "./ui/tutorial";
import { buildDebugReport } from "./debug";
import { log, logError } from "./log";
import { SyncScheduler, type SchedulerConfig, type SchedulerResult } from "./sync-scheduler";

export default class LittleWoolySyncPlugin extends Plugin {
  settings!: LwsSettings;
  controller!: Controller;
  scheduler!: SyncScheduler;
  private status!: StatusBar;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.controller = new Controller(this.app, this.settings);
    this.status = new StatusBar(this.addStatusBarItem(), () => this.onStatusClick());
    this.status.setVisible(this.settings.showStatusBar);
    this.scheduler = new SyncScheduler(
      {
        performSync: async () => {
          const r = await this.controller.sync();
          return {
            uploaded: r.uploaded,
            downloaded: r.downloaded,
            deletedLocal: r.deletedLocal,
            conflictCount: r.conflictCopies.length + r.conflicts.length,
          };
        },
        onStatus: () => this.renderStatus(),
        onResult: (res) => this.onSyncResult(res),
      },
      this.schedulerConfig(),
    );
    this.renderStatus();

    this.addSettingTab(new LwsSettingTab(this.app, this));
    this.addRibbonIcon("elephant", "Little Wooly Sync", () => this.onStatusClick());

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
        this.status.setOverride("⛔ Little Wooly · passphrase missing — re-run setup");
        return;
      }
      try {
        const ok = await this.controller.unlock();
        if (!ok) {
          this.status.setOverride("⛔ Little Wooly · wrong passphrase — re-run setup");
          return;
        }
        // Persist whatever unlock resolved (vaultId discovery, label sync).
        await this.saveSettings();
        if (this.controller.legacyLayout) {
          new Notice(
            "Little Wooly Sync: this vault still uses the pre-0.5 bucket layout — the vault name is visible in bucket keys. Migrate to the opaque layout in Settings → Advanced (update every device to 0.5.0+ first).",
            15000,
          );
        }
        if (this.settings.syncOnStart) await this.runSync();
        else this.renderStatus();
      } catch (e) {
        this.status.setOverride(`⛔ Little Wooly · ${(e as Error).message}`);
        logError("startup unlock", e);
      }
    });

    // Vault events feed the scheduler's pending queue; our own sync writes are
    // ignored (tracked per-path by the controller) so downloads never echo-sync.
    const sched = (file: TAbstractFile) => {
      if (!this.controller.ready) return;
      if (this.controller.recentlySelfWrote(file.path)) return;
      if (this.settings.syncOnSave || this.settings.autoSyncMode === "live")
        this.scheduler.noteChange(file.path);
    };
    this.registerEvent(this.app.vault.on("modify", sched));
    this.registerEvent(this.app.vault.on("create", sched));
    this.registerEvent(this.app.vault.on("delete", sched));
    this.registerEvent(this.app.vault.on("rename", (file) => sched(file)));

    // Returning from background (esp. mobile, where the app suspends) triggers a sync —
    // timers and events don't run while the app is suspended.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden && this.controller.ready) this.scheduler.resume();
    });

    // Keep "Xm ago" fresh in the status bar (also clears transient overrides).
    this.registerInterval(
      window.setInterval(() => {
        if (this.status) this.renderStatus();
      }, 30_000),
    );
  }

  onunload(): void {
    this.scheduler?.dispose();
  }

  private onStatusClick(): void {
    if (this.settings.configured) void this.runSync();
    else this.openSetupWizard();
  }

  private schedulerConfig(): SchedulerConfig {
    const s = this.settings;
    return {
      mode: s.autoSyncMode,
      intervalSec: s.autoSyncIntervalSec,
      idleSec: s.liveIdleSec,
      syncOnSave: s.syncOnSave,
    };
  }

  /** Apply (possibly just-changed) trigger settings to the live scheduler + status bar. */
  applyTriggerSettings(): void {
    this.scheduler?.configure(this.schedulerConfig());
    this.status?.setVisible(this.settings.showStatusBar);
    this.renderStatus();
  }

  openSetupWizard(): void {
    new SetupWizard(this.app, this.controller, this.settings, async () => {
      await this.saveSettings();
      this.applyTriggerSettings();
      await this.runSync();
    }).open();
  }

  async runSync(): Promise<void> {
    if (!this.controller.ready) return;
    await this.scheduler.syncNow();
  }

  /** Public for UI (settings-tab refreshes the widget after operations). */
  renderStatus(): void {
    this.status.render(this.scheduler.statusNow(), this.settings.configured);
  }

  /** Public for UI (settings-tab feedback lines during long operations). */
  setStatusOverride(text: string | null): void {
    this.status.setOverride(text);
  }

  /** Notice policy: quiet by default — errors and conflicts always, transfers opt-in. */
  private onSyncResult(res: SchedulerResult): void {
    const level = this.settings.syncNotices;
    if (!res.ok) {
      logError("sync", res.error);
      if (res.manual || level !== "off") new Notice(`Little Wooly Sync error: ${res.error}`, 8000);
      return;
    }
    const s = res.summary;
    const changed = s.uploaded + s.downloaded + s.deletedLocal;
    const brief = `Little Wooly Sync: ↑${s.uploaded} ↓${s.downloaded} 🗑${s.deletedLocal} · ${(s.durationMs / 1000).toFixed(1)}s`;
    log(
      "info",
      `sync finished — uploaded=${s.uploaded} downloaded=${s.downloaded} deletedLocal=${s.deletedLocal} conflicts=${s.conflictCount} in ${(s.durationMs / 1000).toFixed(1)}s${res.manual ? " (manual)" : ""}`,
    );
    if (s.conflictCount > 0) {
      new Notice(
        `Little Wooly Sync: ${s.conflictCount} conflict(s) — both versions preserved, nothing lost.`,
        8000,
      );
    }
    if (res.manual) {
      if (level !== "off") new Notice(brief, 4000);
    } else if (level === "verbose") {
      new Notice(changed ? brief : "Little Wooly Sync: up to date.", 4000);
    } else if (level === "changes" && changed > 0) {
      new Notice(brief, 4000);
    }
  }

  async runAudit(): Promise<void> {
    if (!this.controller.ready) return void new Notice("Not connected yet.");
    this.status.setOverride("🔄 Little Wooly · auditing…");
    try {
      const r = await this.controller.audit(true);
      this.status.setOverride(r.criticalCount ? `⛔ ${r.verdict}` : `✅ ${r.verdict}`);
      log(
        r.criticalCount ? "warn" : "info",
        `audit — ${r.verdict} (critical=${r.criticalCount}, ratio=${r.ratio.toFixed(3)})`,
      );
      new Notice(
        `${r.verdict}\nplaintext ${(r.plaintextBytes / 1e6).toFixed(1)}MB → stored ${(r.storedBytes / 1e6).toFixed(1)}MB (ratio ${r.ratio.toFixed(2)})\nexcluded by rule: ${r.excluded.length} item(s) — see debug report for the roster`,
        10000,
      );
    } catch (e) {
      this.status.setOverride(`⛔ Little Wooly · ${(e as Error).message}`);
      logError("audit", e);
    }
  }

  async runRepair(): Promise<void> {
    if (!this.controller.ready) return void new Notice("Not connected yet.");
    this.status.setOverride("🔄 Little Wooly · repairing…");
    try {
      const { before, after, reuploaded } = await this.controller.repair();
      this.status.setOverride(after.criticalCount ? `⚠ ${after.verdict}` : `✅ ${after.verdict}`);
      log(
        after.criticalCount ? "warn" : "info",
        `repair — critical ${before.criticalCount}→${after.criticalCount}, reuploaded=${reuploaded}, ${after.verdict}`,
      );
      new Notice(
        `Repair: ${before.criticalCount}→${after.criticalCount} critical, re-ensured ${reuploaded} files.\n${after.verdict}`,
        10000,
      );
    } catch (e) {
      this.status.setOverride(`⛔ Little Wooly · ${(e as Error).message}`);
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
    // strip them so they are never written back; map pre-0.4 trigger settings.
    const legacyPassphrase = data?.passphrase;
    const legacyS3Secret = data?.s3?.secretAccessKey;
    if (data) migrateLegacyTriggers(data as unknown as Record<string, unknown>);

    const s3 = { ...DEFAULT_SETTINGS.s3, ...(data?.s3 ?? {}) } as LwsSettings["s3"] & {
      secretAccessKey?: string;
    };
    delete s3.secretAccessKey;
    if (data) delete data.passphrase;

    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}), s3 };
    sanitizeTriggers(this.settings);

    if (legacyPassphrase) writePassphrase(this.app, legacyPassphrase);
    if (legacyS3Secret) writeS3Secret(this.app, legacyS3Secret);
    if (legacyPassphrase || legacyS3Secret) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
