// Minimal status-bar indicator: idle / syncing / last verdict / error.

export class StatusBar {
  constructor(private el: HTMLElement) {
    this.set("idle", "Little Wooly: ready");
  }

  set(state: "idle" | "syncing" | "ok" | "warn" | "error", text: string): void {
    const icon = { idle: "🐑", syncing: "🔄", ok: "✅", warn: "⚠️", error: "⛔" }[state];
    this.el.setText(`${icon} ${text}`);
  }
}
