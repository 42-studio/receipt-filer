// Dashboard figures from the receipt list. Pure and import-free: the UI (ui/) imports it, vitest tests it.
import type { ReceiptRow, Stage } from "./api-types";

type Row = Pick<ReceiptRow, "stage" | "totalMinor" | "currency" | "filedAt" | "pinnedBy">;

export interface DashboardStats {
  filedThisMonth: { count: number; lastMonth: number; monthName: string; lastMonthName: string; totals: { currency: string; minor: number }[] };
  automatic: { filed: number; auto: number; share: number | null }; // share 0..1, null when nothing is filed
}

const MONTH = (d: Date) => d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });

/** Months are calendar months in UTC, matching the ISO times the Worker stores. */
export function dashboardStats(rows: Row[], now: Date): DashboardStats {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const start = Date.UTC(y, m, 1), lastStart = Date.UTC(y, m - 1, 1);
  const filed = rows.filter((r) => r.stage === "filed");
  const at = (r: Row) => (r.filedAt ? Date.parse(r.filedAt) : NaN);
  const thisMonth = filed.filter((r) => at(r) >= start);
  const lastMonth = filed.filter((r) => at(r) >= lastStart && at(r) < start);

  const sums = new Map<string, number>();
  for (const r of thisMonth) if (r.totalMinor !== null && r.currency) sums.set(r.currency, (sums.get(r.currency) ?? 0) + r.totalMinor);
  // GBP first (the books are in pounds), then the largest
  const totals = [...sums].map(([currency, minor]) => ({ currency, minor })).sort((a, b) => Number(b.currency === "GBP") - Number(a.currency === "GBP") || b.minor - a.minor);

  // A receipt filed through a manual pin needed you; every other filed one did not.
  const auto = filed.filter((r) => r.pinnedBy !== "manual").length;
  return {
    filedThisMonth: { count: thisMonth.length, lastMonth: lastMonth.length, monthName: MONTH(new Date(start)), lastMonthName: MONTH(new Date(lastStart)), totals },
    automatic: { filed: filed.length, auto, share: filed.length ? auto / filed.length : null },
  };
}

export type StatusGroup = "inProgress" | "needsYou" | "filed";
const GROUP_OF: Record<Stage, StatusGroup | undefined> = {
  reading: "inProgress", waiting: "inProgress", needs_you: "needsYou", filed: "filed",
  duplicate: undefined, // left out: it is not a receipt of its own
};
export interface WeekBucket { start: string; inProgress: number; needsYou: number; filed: number; total: number }

/**
 * Receipts received per week (Monday to Sunday, UTC), split by what has become of them since.
 * The last bucket is the week `now` falls in; weeks with no receipts are kept, at zero.
 */
export function weeklyByStatus(rows: Pick<ReceiptRow, "stage" | "received">[], now: Date, weeks: number): WeekBucket[] {
  const day = 86_400_000;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const thisMonday = today - ((new Date(today).getUTCDay() + 6) % 7) * day;
  const buckets: WeekBucket[] = Array.from({ length: weeks }, (_, i) => ({
    start: new Date(thisMonday - (weeks - 1 - i) * 7 * day).toISOString().slice(0, 10), inProgress: 0, needsYou: 0, filed: 0, total: 0,
  }));
  const first = thisMonday - (weeks - 1) * 7 * day;
  for (const r of rows) {
    const group = GROUP_OF[r.stage];
    const at = Date.parse(r.received);
    if (!group || !(at >= first) || at >= thisMonday + 7 * day) continue;
    const b = buckets[Math.floor((at - first) / (7 * day))];
    b[group]++;
    b.total++;
  }
  return buckets;
}
