// The persistent bottom-bar widget: live phase, queue depth, and last-sync metrics.
// One grouped item (per Obsidian docs, items get gaps — so all content lives in one),
// click = "Sync now" (or run setup when not configured), full details in the tooltip.

import type { SchedulerStatus } from "../sync-scheduler";

export function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 15) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export class StatusBar {
  /** When set, shown instead of scheduler state (audit/repair feedback). */
  private override: string | null = null;
  private last: { status: SchedulerStatus; configured: boolean } | null = null;

  constructor(
    private el: HTMLElement,
    onClick: () => void,
  ) {
    el.onClickEvent(() => onClick());
  }

  setVisible(visible: boolean): void {
    this.el.style.display = visible ? "" : "none";
  }

  /** Temporary one-line feedback (e.g. "auditing…"); null returns to live state. */
  setOverride(text: string | null): void {
    this.override = text;
    if (text !== null) {
      this.el.setText(text);
      this.el.title = text;
    } else if (this.last) {
      this.render(this.last.status, this.last.configured);
    }
  }

  render(status: SchedulerStatus, configured: boolean): void {
    this.last = { status, configured };
    if (this.override !== null) return; // sticky until cleared
    const now = Date.now();
    let icon = "🐑";
    let line: string;

    if (!configured) {
      line = "Little Wooly · not set up";
    } else if (status.lastError) {
      icon = "⛔";
      const msg =
        status.lastError.length > 48 ? status.lastError.slice(0, 48) + "…" : status.lastError;
      line = `Little Wooly · ${msg}`;
    } else if (status.phase === "syncing") {
      icon = "🔄";
      line = `Little Wooly · syncing${status.pendingCount ? ` · ${status.pendingCount} queued` : ""}`;
    } else if (status.phase === "queued") {
      line = `Little Wooly · ${status.pendingCount} queued`;
    } else if (status.lastSummary && status.lastSyncAt !== null) {
      icon = "✅";
      const s = status.lastSummary;
      line = `Little Wooly · ↑${s.uploaded} ↓${s.downloaded} · ${timeAgo(status.lastSyncAt, now)}`;
    } else {
      line = "Little Wooly · ready";
    }

    this.el.setText(`${icon} ${line}`);
    this.el.title = this.tooltip(status, configured);
  }

  private tooltip(status: SchedulerStatus, configured: boolean): string {
    if (!configured) return "Little Wooly Sync — click to run setup";
    const tip = ["Little Wooly Sync"];
    if (status.lastError) tip.push(`Last error: ${status.lastError}`);
    if (status.lastSyncAt !== null) {
      tip.push(`Last sync: ${timeAgo(status.lastSyncAt, Date.now())}`);
      if (status.lastSummary) {
        const s = status.lastSummary;
        tip.push(
          `↑${s.uploaded} ↓${s.downloaded} 🗑${s.deletedLocal} · ${(s.durationMs / 1000).toFixed(1)}s · conflicts ${s.conflictCount}`,
        );
      }
    }
    if (status.pendingCount > 0) tip.push(`${status.pendingCount} change(s) queued`);
    tip.push("Click to sync now");
    return tip.join("\n");
  }
}
