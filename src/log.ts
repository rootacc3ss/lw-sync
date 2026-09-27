// A tiny in-memory ring buffer of recent plugin events: after-the-fact debugging
// without writing anything to disk. Surfaced in the debug report. Never logs file
// content, secrets, or keys — only counts, durations, paths, and outcomes.

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
  /** Optional second line (e.g. a stack trace); never file content or secrets. */
  detail?: string;
}

const CAP = 500;

let entries: LogEntry[] = [];

export function log(level: LogLevel, msg: string, detail?: string): void {
  entries.push({ ts: Date.now(), level, msg, detail });
  if (entries.length > CAP) entries = entries.slice(-CAP);
}

/** Record an operation failure with its stack (if any) as the detail line. */
export function logError(context: string, e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e));
  log("error", `${context} failed: ${err.message}`, err.stack);
}

/** Recent entries, oldest first. */
export function recentLog(): LogEntry[] {
  return [...entries];
}

/** Test helper. */
export function resetLog(): void {
  entries = [];
}
