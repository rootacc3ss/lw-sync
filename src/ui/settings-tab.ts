// Slim, progressive settings: Essentials always visible (connection summary + the three big
// actions), Advanced tucked behind a collapsible block. Deliberately ~20 controls vs the
// reference's ~230.

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LittleWoolySyncPlugin from "../main";
import { formatHeaderLines, parseHeaderLines } from "./custom-headers";
import { openExportSetupModal, openImportSetupModal } from "./modals";
import { SETUP_FILE } from "../portability";

export class LwsSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: LittleWoolySyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Little Wooly Sync" });

    if (!s.configured) {
      new Setting(containerEl)
        .setName("Not set up yet")
        .setDesc("Connect this vault to an S3 bucket and choose an encryption passphrase.")
        .addButton((b) =>
          b
            .setButtonText("Run setup")
            .setCta()
            .onClick(() => this.plugin.openSetupWizard()),
        );
      return;
    }

    // ---- Essentials ----
    new Setting(containerEl)
      .setName("Connection")
      .setDesc(
        `${s.s3.bucket} @ ${s.s3.endpoint} → lwsync/${s.vaultName}/ (device: ${s.deviceName})`,
      )
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          try {
            const { conditionalPut } = await this.plugin.controller.testConnection();
            new Notice("✅ Connected.");
            if (!conditionalPut)
              new Notice(
                "⚠ This bucket ignores conditional create (If-None-Match); manifest updates fall back to recompute.",
                8000,
              );
          } catch (e) {
            new Notice(`⛔ ${(e as Error).message}`);
          }
        }),
      )
      .addButton((b) =>
        b.setButtonText("Re-run setup").onClick(() => this.plugin.openSetupWizard()),
      );

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Push local changes and pull remote changes.")
      .addButton((b) =>
        b
          .setButtonText("Sync")
          .setCta()
          .onClick(() => this.plugin.runSync()),
      );

    new Setting(containerEl)
      .setName("Coverage audit")
      .setDesc("Prove every file is backed up; reconcile plaintext vs stored size.")
      .addButton((b) => b.setButtonText("Audit").onClick(() => this.plugin.runAudit()));

    new Setting(containerEl)
      .setName("Repair")
      .setDesc("Re-check the bucket and fix anything missing/stale. Additive — never deletes.")
      .addButton((b) => b.setButtonText("Repair").onClick(() => this.plugin.runRepair()));

    // ---- Triggers ----
    new Setting(containerEl).setName("Sync on startup").addToggle((t) =>
      t.setValue(s.syncOnStart).onChange(async (v) => {
        s.syncOnStart = v;
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl)
      .setName("Sync on save (debounced)")
      .setDesc("Sync shortly after files change. Works in every auto-sync mode.")
      .addToggle((t) =>
        t.setValue(s.syncOnSave).onChange(async (v) => {
          s.syncOnSave = v;
          await this.plugin.saveSettings();
          this.plugin.applyTriggerSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("How this device keeps itself updated in the background.")
      .addDropdown((d) => {
        d.addOption("off", "Off — manual sync only");
        d.addOption(
          "periodic",
          "Periodic — every N seconds (stable, lowest load, fewest S3 calls)",
        );
        d.addOption("live", "Live — sync a few seconds after you stop typing");
        d.setValue(s.autoSyncMode);
        d.onChange(async (v) => {
          s.autoSyncMode = v as typeof s.autoSyncMode;
          await this.plugin.saveSettings();
          this.plugin.applyTriggerSettings();
        });
      });
    new Setting(containerEl)
      .setName("Periodic interval (seconds)")
      .setDesc("Used when Auto-sync is Periodic. Minimum 15s — syncs are throttled anyway.")
      .addText((t) =>
        t.setValue(String(s.autoSyncIntervalSec)).onChange(async (v) => {
          s.autoSyncIntervalSec = Math.max(15, parseInt(v || "0", 10) || 300);
          await this.plugin.saveSettings();
          this.plugin.applyTriggerSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Live idle delay (seconds)")
      .setDesc(
        "Used when Auto-sync is Live: seconds of quiet after changes before syncing (2–300).",
      )
      .addText((t) =>
        t.setValue(String(s.liveIdleSec)).onChange(async (v) => {
          s.liveIdleSec = Math.min(300, Math.max(2, parseInt(v || "0", 10) || 5));
          await this.plugin.saveSettings();
          this.plugin.applyTriggerSettings();
        }),
      );

    // ---- Status & notifications ----
    new Setting(containerEl)
      .setName("Show status bar item")
      .setDesc(
        "Live sync status, queue depth, and metrics in the bottom bar. Click it to sync now.",
      )
      .addToggle((t) =>
        t.setValue(s.showStatusBar).onChange(async (v) => {
          s.showStatusBar = v;
          await this.plugin.saveSettings();
          this.plugin.applyTriggerSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Sync notifications")
      .setDesc("Top-right notices. Errors and conflicts always show unless this is Off.")
      .addDropdown((d) => {
        d.addOption("quiet", "Errors & conflicts only (recommended)");
        d.addOption("changes", "Also when files transferred");
        d.addOption("verbose", "Every sync (verbose)");
        d.addOption("off", "Off — status bar only");
        d.setValue(s.syncNotices);
        d.onChange(async (v) => {
          s.syncNotices = v as typeof s.syncNotices;
          await this.plugin.saveSettings();
        });
      });

    // ---- Advanced ----
    const adv = containerEl.createEl("details");
    adv.createEl("summary", { text: "Advanced" });

    const ctl = this.plugin.controller;
    let includeSecrets = false;

    new Setting(adv)
      .setName("Deleted-file retention")
      .setDesc(
        "Shared across devices. Default: keep everything forever — nothing is ever purged. A window removes a deleted file's encrypted objects once every device recorded the deletion and the window passed; live files and their history are never touched. Purged = unrecoverable.",
      )
      .addDropdown((d) => {
        d.addOption("0", "Keep everything forever");
        d.addOption("14", "14 days");
        d.addOption("30", "30 days");
        d.addOption("90", "90 days");
        d.setValue(String(ctl.ready ? ctl.retentionDays : 0));
        d.onChange(async (v) => {
          try {
            await ctl.setRetention(parseInt(v, 10) || 0);
            new Notice("Retention updated (applies to every device).");
          } catch (e) {
            new Notice(`⛔ ${(e as Error).message}`);
          }
        });
      });

    new Setting(adv)
      .setName("Include secrets in export")
      .setDesc(
        "Off: the setup file carries connection + preferences only. On: also the S3 secret + passphrase, encrypted with a one-time export passphrase.",
      )
      .addToggle((t) => t.setValue(false).onChange((v) => (includeSecrets = v)));

    new Setting(adv)
      .setName("Export setup file")
      .setDesc(
        `Writes ${SETUP_FILE} to the vault root — take it to a new device (it syncs with your vault, encrypted like everything else; delete it after migrating if you prefer).`,
      )
      .addButton((b) =>
        b.setButtonText("Export").onClick(async () => {
          try {
            if (includeSecrets) {
              openExportSetupModal(this.app, ctl);
              return;
            }
            await ctl.exportSetup(false);
            new Notice(`✅ Wrote ${SETUP_FILE} to the vault root.`);
          } catch (e) {
            new Notice(`⛔ ${(e as Error).message}`);
          }
        }),
      );

    new Setting(adv)
      .setName("Import setup file")
      .setDesc(
        `Loads connection + preferences from ${SETUP_FILE} in the vault root, then re-run setup to connect.`,
      )
      .addButton((b) =>
        b.setButtonText("Import").onClick(() =>
          openImportSetupModal(this.app, ctl, () => {
            new Notice("Imported — run setup to connect with these settings.");
            this.plugin.openSetupWizard();
          }),
        ),
      );

    new Setting(adv)
      .setName("Back up this device's config now")
      .setDesc(
        "Saves .obsidian device-specific files (workspace, appearance…) under this device's namespace.",
      )
      .addButton((b) =>
        b.setButtonText("Back up").onClick(async () => {
          const n = await this.plugin.controller.backupDeviceConfig();
          new Notice(`Backed up ${n} device-config files.`);
        }),
      );

    new Setting(adv)
      .setName("Restore device config")
      .setDesc("Restore a saved device layout/config (yours or another device's).")
      .addDropdown(async (d) => {
        d.addOption("", "— choose device —");
        for (const dev of await this.plugin.controller.listBackedUpDevices()) d.addOption(dev, dev);
        d.onChange(async (dev) => {
          if (!dev) return;
          const n = await this.plugin.controller.restoreDeviceConfig(dev);
          new Notice(`Restored ${n} files from "${dev}". Reload Obsidian to apply.`);
        });
      });

    new Setting(adv)
      .setName("Create catch-all archive now")
      .setDesc("Encrypted tar of all config files — redundant one-shot restore safety net.")
      .addButton((b) =>
        b.setButtonText("Archive").onClick(async () => {
          const key = await this.plugin.controller.createArchive(Date.now());
          new Notice(`Archive created: ${key}`);
        }),
      );

    new Setting(adv)
      .setName("Custom request headers")
      .setDesc("Optional. One per line as `Header: value` — for auth proxies/gateways.")
      .addTextArea((t) => {
        t.setValue(formatHeaderLines(s.s3.customHeaders)).onChange(async (v) => {
          s.s3.customHeaders = parseHeaderLines(v);
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 2;
      });

    new Setting(adv)
      .setName("Debug report")
      .setDesc("Write a redacted state report to littlewooly-sync-debug.md in the vault root.")
      .addButton((b) => b.setButtonText("Generate").onClick(() => this.plugin.writeDebugReport()));
  }
}
