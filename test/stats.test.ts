import { expect, it } from "vitest";
import { dashboardStats } from "../src/ui/stats";

const row = (state: string, o: { totalMinor?: number | null; currency?: string | null; filedAt?: string | null; pinnedBy?: "auto" | "manual" | null } = {}) =>
  ({ state, totalMinor: 1000, currency: "GBP", filedAt: null, pinnedBy: null, ...o });
const NOW = new Date("2026-11-22T12:00:00Z");

it("counts what needs you and what is in progress", () => {
  const s = dashboardStats([row("failed"), row("needs_choice"), row("needs_choice"), row("could_not_read"), row("reading"), row("waiting_payment"), row("waiting_explanation"), row("duplicate")], NOW);
  expect(s.needsYou).toEqual({ total: 4, failed: 1, couldNotRead: 1, needsChoice: 2 });
  expect(s.inProgress).toEqual({ total: 3, reading: 1, waitingPayment: 1, waitingExplanation: 1 });
});

it("splits filed receipts by calendar month and sums this month per currency, GBP first", () => {
  const s = dashboardStats([
    row("filed", { filedAt: "2026-11-01T00:00:00Z", totalMinor: 400, currency: "USD" }),
    row("filed", { filedAt: "2026-11-20T10:00:00Z", totalMinor: 2400 }),
    row("filed", { filedAt: "2026-11-21T10:00:00Z", totalMinor: 645 }),
    row("filed", { filedAt: "2026-11-21T10:00:00Z", totalMinor: null, currency: null }), // matched by hand with no total
    row("filed", { filedAt: "2026-10-31T23:59:59Z" }),
    row("filed", { filedAt: "2026-09-30T10:00:00Z" }),
    row("waiting_payment", { filedAt: "2026-11-05T00:00:00Z" }), // not filed: ignored
  ], NOW);
  expect(s.filedThisMonth).toEqual({ count: 4, lastMonth: 1, monthName: "November", lastMonthName: "October", totals: [{ currency: "GBP", minor: 3045 }, { currency: "USD", minor: 400 }] });
});

it("handles January, whose last month is in the previous year", () => {
  const s = dashboardStats([row("filed", { filedAt: "2026-12-15T00:00:00Z" })], new Date("2027-01-03T00:00:00Z"));
  expect([s.filedThisMonth.count, s.filedThisMonth.lastMonth, s.filedThisMonth.lastMonthName]).toEqual([0, 1, "December"]);
});

it("gives the share filed without a manual match, or null when nothing is filed", () => {
  expect(dashboardStats([row("filed", { pinnedBy: "auto" }), row("filed", { pinnedBy: "auto" }), row("filed", { pinnedBy: "manual" }), row("filed")], NOW).automatic).toEqual({ filed: 4, auto: 3, share: 0.75 });
  expect(dashboardStats([row("reading")], NOW).automatic.share).toBeNull();
});

it("buckets receipts by Monday-to-Sunday week, oldest first, keeping empty weeks and leaving out duplicates", async () => {
  const { weeklyByStatus } = await import("../src/ui/stats");
  const rows = [
    { state: "filed", received: "2026-11-16" }, // Monday of this week
    { state: "failed", received: "2026-11-22" }, // Sunday of this week (NOW)
    { state: "duplicate", received: "2026-11-20" },
    { state: "waiting_payment", received: "2026-11-15" }, // Sunday: last week
    { state: "needs_choice", received: "2026-11-09" },
    { state: "filed", received: "2026-11-01" }, // too old for 3 weeks
    { state: "reading", received: "2026-11-23" }, // next week: ignored
  ];
  expect(weeklyByStatus(rows, NOW, 3)).toEqual([
    { start: "2026-11-02", inProgress: 0, needsYou: 0, filed: 0, total: 0 },
    { start: "2026-11-09", inProgress: 1, needsYou: 1, filed: 0, total: 2 },
    { start: "2026-11-16", inProgress: 0, needsYou: 1, filed: 1, total: 2 },
  ]);
});
