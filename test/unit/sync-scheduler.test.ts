import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SyncScheduler,
  type SchedulerConfig,
  type SchedulerStatus,
} from "../../src/sync-scheduler";
import { migrateLegacyTriggers, sanitizeTriggers, DEFAULT_SETTINGS } from "../../src/controller";

// The scheduler uses injected-by-default global timers, so vi.useFakeTimers()
// intercepts everything (timers AND Date.now).
const SYNCED = { uploaded: 1, downloaded: 1, deletedLocal: 0, conflictCount: 0 };

function cfg(partial: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return { mode: "live", intervalSec: 300, idleSec: 5, syncOnSave: true, ...partial };
}

describe("SyncScheduler — live mode (sync when you stop typing)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("syncs only after the idle delay of quiet, coalescing bursts", async () => {
    const performSync = vi.fn().mockResolvedValue(SYNCED);
    const s = new SyncScheduler({ performSync }, cfg({ idleSec: 5 }));
    s.noteChange("a.md");
    s.noteChange("b.md"); // second change within the window: same timer, one sync
    await vi.advanceTimersByTimeAsync(4999);
    expect(performSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(performSync).toHaveBeenCalledTimes(1);
    // both changes were consumed by the pass
    expect(s.statusNow().pendingCount).toBe(0);
  });

  test("a change during a sync is drained by exactly one more pass (never dropped)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const performSync = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate; // pass 1 in flight...
        return SYNCED;
      })
      .mockImplementationOnce(async () => SYNCED);
    const s = new SyncScheduler({ performSync }, cfg({ idleSec: 5 }));
    s.noteChange("a.md");
    await vi.advanceTimersByTimeAsync(5000);
    expect(performSync).toHaveBeenCalledTimes(1);
    s.noteChange("b.md"); // arrives while pass 1 is still running
    release();
    await vi.advanceTimersByTimeAsync(0); // pass 1 completes
    expect(performSync).toHaveBeenCalledTimes(1); // not yet — drained after idle
    expect(s.statusNow().pendingCount).toBe(2); // a + b (a re-walked cheaply: no-op)
    // The drain pass is also an AUTO sync: throttled to 15s after pass 1 completed.
    await vi.advanceTimersByTimeAsync(15000);
    expect(performSync).toHaveBeenCalledTimes(2); // the drain pass
    expect(s.statusNow().pendingCount).toBe(0);
  });

  test("auto syncs are throttled: at most one per 15s", async () => {
    const performSync = vi.fn().mockResolvedValue(SYNCED);
    const s = new SyncScheduler({ performSync }, cfg({ idleSec: 2 }));
    s.noteChange("a.md");
    await vi.advanceTimersByTimeAsync(2000);
    expect(performSync).toHaveBeenCalledTimes(1);
    s.noteChange("b.md");
    await vi.advanceTimersByTimeAsync(2000);
    expect(performSync).toHaveBeenCalledTimes(1); // throttled (only 2s since last)
    await vi.advanceTimersByTimeAsync(13000); // 15s since the first sync
    expect(performSync).toHaveBeenCalledTimes(2);
  });

  test("failures back off exponentially and reset on success", async () => {
    const performSync = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(SYNCED);
    const s = new SyncScheduler({ performSync }, cfg({ idleSec: 2 }));
    s.noteChange("a.md");
    await vi.advanceTimersByTimeAsync(2000);
    expect(performSync).toHaveBeenCalledTimes(1);
    expect(s.statusNow().lastError).toBe("boom");
    s.noteChange("b.md");
    await vi.advanceTimersByTimeAsync(2000);
    expect(performSync).toHaveBeenCalledTimes(1); // 30s backoff (failures=1)
    await vi.advanceTimersByTimeAsync(28000);
    expect(performSync).toHaveBeenCalledTimes(2);
    expect(s.statusNow().lastError).toBeNull();
    s.noteChange("c.md");
    await vi.advanceTimersByTimeAsync(15000); // no backoff anymore, just the 15s throttle
    expect(performSync).toHaveBeenCalledTimes(3);
  });

  test("manual syncNow bypasses throttle and backoff, single-flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const performSync = vi.fn().mockImplementationOnce(async () => {
      await gate;
      return SYNCED;
    });
    const s = new SyncScheduler({ performSync }, cfg({ idleSec: 5 }));
    void s.syncNow(); // pass 1 starts, gated
    expect(performSync).toHaveBeenCalledTimes(1);
    await s.syncNow(); // in-flight -> returns immediately, no second pass
    expect(performSync).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(performSync).toHaveBeenCalledTimes(1);
    expect(s.statusNow().phase).toBe("idle");
  });

  test("resume() schedules a near-term sync", async () => {
    const performSync = vi.fn().mockResolvedValue(SYNCED);
    const s = new SyncScheduler({ performSync }, cfg());
    s.resume();
    await vi.advanceTimersByTimeAsync(999);
    expect(performSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(performSync).toHaveBeenCalledTimes(1);
  });
});

describe("SyncScheduler — periodic mode", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("ticks at the interval, and reconfiguring re-arms it", async () => {
    const performSync = vi.fn().mockResolvedValue(SYNCED);
    const s = new SyncScheduler({ performSync }, cfg({ mode: "periodic", intervalSec: 60 }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(performSync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(performSync).toHaveBeenCalledTimes(2);
    s.configure(cfg({ mode: "periodic", intervalSec: 30 }));
    await vi.advanceTimersByTimeAsync(30000);
    expect(performSync).toHaveBeenCalledTimes(3);
    expect(s.statusNow().pendingCount).toBe(0);
  });

  test("switching away stops the ticks", async () => {
    const performSync = vi.fn().mockResolvedValue(SYNCED);
    const s = new SyncScheduler({ performSync }, cfg({ mode: "periodic", intervalSec: 60 }));
    s.configure(cfg({ mode: "off", syncOnSave: false }));
    await vi.advanceTimersByTimeAsync(600000);
    expect(performSync).not.toHaveBeenCalled();
  });
});

describe("SyncScheduler — off mode + sync-on-save", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("off + no save: changes queue for status only, nothing syncs", async () => {
    const performSync = vi.fn().mockResolvedValue(SYNCED);
    const s = new SyncScheduler({ performSync }, cfg({ mode: "off", syncOnSave: false }));
    s.noteChange("a.md");
    expect(s.statusNow().phase).toBe("queued");
    expect(s.statusNow().pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(600000);
    expect(performSync).not.toHaveBeenCalled();
    await s.syncNow(); // manual drains it
    expect(performSync).toHaveBeenCalledTimes(1);
    expect(s.statusNow().pendingCount).toBe(0);
  });

  test("save debounce syncs in every mode (incl. off)", async () => {
    const performSync = vi.fn().mockResolvedValue(SYNCED);
    const s = new SyncScheduler({ performSync }, cfg({ mode: "off", syncOnSave: true }));
    s.noteChange("a.md");
    await vi.advanceTimersByTimeAsync(4000);
    expect(performSync).toHaveBeenCalledTimes(1);
  });
});

describe("SyncScheduler — status + result callbacks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("onStatus reflects phase transitions; onResult carries manual + summary", async () => {
    const performSync = vi.fn().mockResolvedValue({ ...SYNCED, conflictCount: 3 });
    const statuses: SchedulerStatus[] = [];
    const results: { ok: boolean }[] = [];
    const s = new SyncScheduler(
      {
        performSync,
        onStatus: (st) => statuses.push(st),
        onResult: (r) => results.push(r),
      },
      cfg({ idleSec: 1 }),
    );
    s.noteChange("a.md");
    expect(statuses.at(-1)?.phase).toBe("queued");
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses.some((st) => st.phase === "syncing")).toBe(true);
    expect(statuses.at(-1)?.phase).toBe("idle");
    expect(statuses.at(-1)?.lastSummary?.conflictCount).toBe(3);
    expect(statuses.at(-1)?.lastError).toBeNull();
    expect(results).toEqual([{ ok: true, manual: false, summary: expect.any(Object) }]);
  });

  test("a failed pass reports the error and keeps the changes queued", async () => {
    const performSync = vi.fn().mockRejectedValue(new Error("network down"));
    const s = new SyncScheduler({ performSync }, cfg({ idleSec: 1 }));
    s.noteChange("a.md");
    await vi.advanceTimersByTimeAsync(1000);
    const st = s.statusNow();
    expect(st.lastError).toBe("network down");
    expect(st.pendingCount).toBe(1); // not lost — retried after backoff
  });
});

describe("legacy trigger settings migration", () => {
  test("syncIntervalSec > 0 becomes periodic with the same interval", () => {
    const raw: Record<string, unknown> = { syncIntervalSec: 600, syncOnSave: true };
    migrateLegacyTriggers(raw);
    expect(raw).toEqual({ syncOnSave: true, autoSyncMode: "periodic", autoSyncIntervalSec: 600 });
  });

  test("syncIntervalSec = 0 becomes off", () => {
    const raw: Record<string, unknown> = { syncIntervalSec: 0 };
    migrateLegacyTriggers(raw);
    expect(raw).toEqual({ autoSyncMode: "off" });
  });

  test("already-migrated settings are left alone (just drops the stale field)", () => {
    const raw: Record<string, unknown> = {
      autoSyncMode: "live",
      liveIdleSec: 5,
      syncIntervalSec: 300, // stale leftover from an old save
    };
    migrateLegacyTriggers(raw);
    expect(raw).toEqual({ autoSyncMode: "live", liveIdleSec: 5 });
  });

  test("sanitizeTriggers repairs corrupt values", () => {
    const s = {
      ...DEFAULT_SETTINGS,
      autoSyncMode: "bogus" as never,
      syncNotices: "loud" as never,
      autoSyncIntervalSec: 0,
      liveIdleSec: 0,
    };
    sanitizeTriggers(s);
    expect(s.autoSyncMode).toBe("periodic");
    expect(s.autoSyncIntervalSec).toBeGreaterThanOrEqual(15);
    expect(s.liveIdleSec).toBeGreaterThanOrEqual(2);
    expect(s.syncNotices).toBe("quiet");
  });
});
