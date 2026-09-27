// Minimal obsidian stub for unit tests. The real package ships types only (no runtime
// entry), so vitest aliases "obsidian" here whenever a src module is imported that has a
// value-level obsidian import. Tests that exercise ObsHttpHandler inject their own
// requestFn, so this stub only needs to exist, not work.

export function requestUrl(_param: unknown): never {
  throw new Error("requestUrl was called in a test — inject a fake requestFn instead.");
}

export const Platform = { isMobileApp: false, isDesktopApp: true };

export class Notice {
  constructor(public message: string, public timeout?: number) {}
}
