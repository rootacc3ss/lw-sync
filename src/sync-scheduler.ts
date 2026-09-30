// The auto-sync brain: decides WHEN a network sync runs, so the UI only decides WHAT
// to show. Pure module — clock and timers are injected, no Obsidian imports, fully
// unit-testable.
//
// Modes:
//   live     — sync `idleSec` after the last vault change ("when you stop typing")
//   periodic — sync every `intervalSec` (the stable, lowest-load option)
//   off      — no background sync (sync-on-save can still be enabled)
//
// Anti-spam guarantees, in layers:
//   1. idle/debounce coalescing — bursts of changes become one sync
//   2. a 15s minimum between AUTO syncs (manual syncs bypass it)
//   3. exponential backoff (30s → 10 min) after consecutive failures, reset on success
//   4. single-flight — never more than one sync in flight; changes that arrive during
//      a sync accumulate in `pending` and are drained by exactly one more pass (the
//      old code silently dropped them until the next trigger)

export type AutoSyncMode = "off" | "periodic" | "live";
export type SyncPhase = "idle" | "queued" | "syncing";

export interface SchedulerConfig {
  mode: AutoSyncMode;
  /** periodic mode: seconds between syncs. */
  intervalSec: number;
  /** live mode: seconds of quiet after a change before syncing. */
  idleSec: number;
  /** any mode: sync shortly after files change (the pre-0.4 "sync on save"). */
  syncOnSave: boolean;
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  conflictCount: number;
  durationMs: number;
}

export type SchedulerResult =
  | { ok: true; manual: boolean; summary: SyncSummary }
  | { ok: false; manual: boolean; error: string };

export interface SchedulerStatus {
  phase: SyncPhase;
  pendingCount: number;
  lastSyncAt: number | null;
  lastSummary: SyncSummary | null;
  lastError: string | null;
}

export interface SchedulerDeps {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  /** Performs one sync pass. Throws on failure. */
  performSync: () => Promise<Omit<SyncSummary, "durationMs">>;
  onStatus?: (status: SchedulerStatus) => void;
  onResult?: (result: SchedulerResult) => void;
}

const SAVE_DEBOUNCE_MS = 4_000;
const MIN_AUTO_INTERVAL_MS = 15_000;
const RESUME_DELAY_MS = 1_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 600_000;
const AUTO_SYNC_MODES: AutoSyncMode[] = ["off", "periodic", "live"];

export function isAutoSyncMode(v: unknown): v is AutoSyncMode {
  return typeof v === "string" && (AUTO_SYNC_MODES as string[]).includes(v);
}

export class SyncScheduler {
  private cfg: SchedulerConfig;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;
  private readonly performSync: SchedulerDeps["performSync"];
  private readonly onStatus?: (status: SchedulerStatus) => void;
  private readonly onResult?: (result: SchedulerResult) => void;

  private pending = new Set<string>();
  private changeEpoch = 0;
  private syncing = false;
  private autoTimer: number | null = null;
  private periodicTimer: number | null = null;
  private lastSyncAt: number | null = null;
  private failures = 0;
  private lastSummary: SyncSummary | null = null;
  private lastError: string | null = null;

  constructor(deps: SchedulerDeps, cfg: SchedulerConfig) {
    this.now = deps.now ?? (() => Date.now());
    // Global timers (browser + Node test env alike); the cast keeps tsc from picking
    // the Node-typed overload. vi.useFakeTimers() patches these in tests.
    this.setTimer =
      deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number);
    this.clearTimer =
      deps.clearTimer ??
      ((id: number) => clearTimeout(id as unknown as Parameters<typeof clearTimeout>[0]));
    this.performSync = deps.performSync;
    this.onStatus = deps.onStatus;
    this.onResult = deps.onResult;
    this.cfg = { ...cfg };
    if (this.cfg.mode === "periodic") this.schedulePeriodic();
  }

  /** Reconfigure at runtime (settings changed); re-arms the periodic timer. */
  configure(cfg: SchedulerConfig): void {
    this.cfg = { ...cfg };
    if (this.cfg.mode === "periodic") this.schedulePeriodic();
    else this.clearPeriodic();
    this.refreshAutoTimer();
    this.emit();
  }

  /** A vault file changed (or an unspecified bulk change). Coalesced into `pending`. */
  noteChange(path?: string): void {
    this.pending.add(path ?? "·vault");
    this.changeEpoch++;
    this.refreshAutoTimer();
    this.emit();
  }

  /** The app became visible again (e.g. mobile resume): schedule a near-term sync. */
  resume(): void {
    if (this.cfg.mode === "off" && !this.cfg.syncOnSave && this.pending.size === 0) return;
    this.armAuto(RESUME_DELAY_MS);
  }

  /** Manual sync: runs immediately, bypassing throttle and backoff. */
  async syncNow(): Promise<void> {
    await this.runSync(true);
  }

  statusNow(): SchedulerStatus {
    return {
      phase: this.syncing ? "syncing" : this.pending.size > 0 ? "queued" : "idle",
      pendingCount: this.pending.size,
      lastSyncAt: this.lastSyncAt,
      lastSummary: this.lastSummary,
      lastError: this.lastError,
    };
  }

  dispose(): void {
    this.clearAuto();
    this.clearPeriodic();
  }

  // ---- internals ----

  /** Arm/cancel the idle/save timer based on pending changes and the current mode. */
  private refreshAutoTimer(): void {
    if (this.pending.size === 0) {
      this.clearAuto();
      return;
    }
    if (this.cfg.mode === "live") this.armAuto(this.cfg.idleSec * 1000);
    else if (this.cfg.syncOnSave) this.armAuto(SAVE_DEBOUNCE_MS);
    else this.clearAuto();
  }

  /** Arm the single auto timer, pushed out past the throttle and failure backoff. */
  private armAuto(delayMs: number): void {
    this.clearAuto();
    let wait = delayMs;
    if (this.lastSyncAt !== null) {
      const since = this.now() - this.lastSyncAt;
      wait = Math.max(wait, MIN_AUTO_INTERVAL_MS - since);
      if (this.failures > 0) {
        const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
        wait = Math.max(wait, backoff - since);
      }
    }
    this.autoTimer = this.setTimer(
      () => {
        this.autoTimer = null;
        void this.runSync(false);
      },
      Math.max(0, wait),
    );
  }

  /** Periodic ticks re-arm themselves after each completed pass (never overlapping). */
  private schedulePeriodic(): void {
    this.clearPeriodic();
    const sec = Math.floor(this.cfg.intervalSec);
    if (this.cfg.mode !== "periodic" || sec <= 0) return;
    this.periodicTimer = this.setTimer(() => {
      this.periodicTimer = null;
      void this.runSync(false).then(() => this.schedulePeriodic());
    }, sec * 1000);
  }

  private async runSync(manual: boolean): Promise<void> {
    if (this.syncing) return; // single flight; changes accumulate in `pending`
    this.syncing = true;
    const startEpoch = this.changeEpoch;
    const t0 = this.now();
    this.emit();
    try {
      const raw = await this.performSync();
      this.failures = 0;
      this.lastError = null;
      this.lastSyncAt = this.now();
      this.lastSummary = { ...raw, durationMs: Math.max(0, this.now() - t0) };
      // Nothing changed while we were syncing -> the pass consumed everything.
      // (If something DID change, keep it queued: the drain pass re-walks cheaply.)
      if (this.changeEpoch === startEpoch) this.pending.clear();
      this.onResult?.({ ok: true, manual, summary: this.lastSummary });
    } catch (e) {
      this.failures++;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.lastSyncAt = this.now();
      this.onResult?.({ ok: false, manual, error: this.lastError });
    } finally {
      this.syncing = false;
      if (this.pending.size > 0) this.refreshAutoTimer(); // drain loop
      this.emit();
    }
  }

  private clearAuto(): void {
    if (this.autoTimer !== null) {
      this.clearTimer(this.autoTimer);
      this.autoTimer = null;
    }
  }

  private clearPeriodic(): void {
    if (this.periodicTimer !== null) {
      this.clearTimer(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  private emit(): void {
    this.onStatus?.(this.statusNow());
  }
}
