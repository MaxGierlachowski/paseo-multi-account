import type { AccountView, UsageWindowView } from "../shared/rpc.js";

/** "Claude (Work)" → "Work"; any other label stays as it is. */
export function shortName(account: Pick<AccountView, "label">): string {
  return /^Claude \((.+)\)$/.exec(account.label)?.[1] ?? account.label;
}

/** The session (5h) and weekly windows, which decide whether an account can take a message. */
export function headlineWindows(account: AccountView): UsageWindowView[] {
  const windows = account.usage?.windows ?? [];
  return windows.filter((window) => window.id === "five_hour" || window.id === "weekly");
}

export function percent(value: number | null): string {
  return value === null ? "–" : `${Math.round(value)}%`;
}

/** "5h 42% · wk 17%", or the reason usage is unknown. */
export function usageSummary(account: AccountView): string | null {
  if (!account.usage) return null;
  if (account.usage.status !== "available") return account.usage.message;
  return headlineWindows(account)
    .map((window) => `${window.shortLabel ?? window.label} ${percent(window.usedPct)}`)
    .join(" · ");
}

/** "Session 42% (resets in 2h 3m) · Weekly 17% (resets in 3d)", for rows with no room for bars. */
export function usageDetail(account: AccountView): string {
  if (!account.usage) return "Loading usage…";
  if (account.usage.status !== "available") return account.usage.message ?? "Usage unavailable";
  return headlineWindows(account)
    .map((window) => {
      const reset = resetsIn(window.resetsAt);
      return `${window.label} ${percent(window.usedPct)}${reset ? ` (${reset})` : ""}`;
    })
    .join(" · ");
}

export function resetsIn(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${Math.round(hours / 24)}d`;
}

export function switchResultMessage(
  label: string,
  result: { reloaded: number; deferred: number; failed: string[] },
): string {
  const parts = [`Claude now runs on ${label}`];
  if (result.reloaded) parts.push(`${result.reloaded} open chat${result.reloaded === 1 ? "" : "s"} moved`);
  if (result.deferred) parts.push(`${result.deferred} busy chat${result.deferred === 1 ? "" : "s"} move after the current turn`);
  if (result.failed.length) parts.push(`${result.failed.length} could not be reloaded`);
  return parts.join(" · ");
}
