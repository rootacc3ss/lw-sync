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
    new Setting(containerEl).setName("Sync on save (debounced)").addToggle((t) =>
      t.setValue(s.syncOnSave).onChange(async (v) => {
        s.syncOnSave = v;
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("Periodic sync interval (seconds, 0 = off)").addText((t) =>
      t.setValue(String(s.syncIntervalSec)).onChange(async (v) => {
        s.syncIntervalSec = Math.max(0, parseInt(v || "0", 10) || 0);
        await this.plugin.saveSettings();
      }),
    );

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
