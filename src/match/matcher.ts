import { CONFIDENCE_AUTO, FOREIGN_WINDOW_DAYS, FX_TOLERANCE, GBP_WINDOW_DAYS } from "../env";
import type { BankLine } from "../freeagent/client";

export interface MatchInput { totalMinor: number; currency: string; date: string; supplier: string | null; confidence: number; inputKind: "text" | "image"; }
export type Decision = { kind: "none" } | { kind: "match"; line: BankLine } | { kind: "choice"; lines: BankLine[] };

const SUFFIXES = new Set(["ltd", "limited", "inc", "llc", "plc", "gmbh", "co", "corp", "sa", "sarl", "ag", "bv"]);
const SYMBOLS: Record<string, string[]> = { USD: ["US$", "$"], EUR: ["€"] };

const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;

/** The receipt date plus, when day and month are both valid months and differ, the day/month-swapped date. */
function centres(date: string): string[] {
  const m = +date.slice(5, 7), d = +date.slice(8, 10);
  return m <= 12 && d <= 12 && m !== d ? [date, `${date.slice(0, 5)}${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}`] : [date];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function describesAmount(description: string, currency: string, absMinor: number): boolean {
  const amt = `${Math.floor(absMinor / 100)}.${String(absMinor % 100).padStart(2, "0")}`;
  const tokens = [currency, ...(SYMBOLS[currency] ?? [])].map(escape).join("|");
  const end = String.raw`(?!\d|[.,]\d)`;
  return new RegExp(`(?:${tokens})\\s*${escape(amt)}${end}|(?<!\\d[.,]?)${escape(amt)}${end}\\s*(?:${tokens})`, "i").test(description);
}

export function decide(input: MatchInput, lines: BankLine[], used: Set<string>, rateToGbp: number | null): Decision {
  const gbp = input.currency === "GBP";
  const win = gbp ? GBP_WINDOW_DAYS : FOREIGN_WINDOW_DAYS;
  const centreDays = centres(input.date).map(day);
  const abs = Math.abs(input.totalMinor);
  const inWindow = (l: BankLine) => centreDays.some((c) => { const d = day(l.datedOn) - c; return d >= -win.before && d <= win.after; });
  const fits = lines.filter((l) => !used.has(l.url) && Math.sign(l.amountMinor) === -Math.sign(input.totalMinor) && l.amountMinor !== 0 && inWindow(l));

  let candidates: BankLine[];
  if (gbp) candidates = fits.filter((l) => l.amountMinor === -input.totalMinor);
  else {
    candidates = fits.filter((l) => describesAmount(l.description, input.currency, abs));
    if (!candidates.length && rateToGbp !== null) {
      const converted = Math.round(abs * rateToGbp);
      candidates = fits.filter((l) => Math.abs(Math.abs(l.amountMinor) - converted) <= converted * FX_TOLERANCE);
    }
  }

  if (candidates.length > 1 && input.inputKind === "text" && input.supplier) {
    const words = input.supplier.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !SUFFIXES.has(w));
    if (words.length) {
      const named = candidates.filter((l) => words.every((w) => l.description.toLowerCase().includes(w)));
      if (named.length === 1) candidates = named;
    }
  }

  if (!candidates.length) return { kind: "none" };
  if (candidates.length === 1 && input.confidence >= CONFIDENCE_AUTO) return { kind: "match", line: candidates[0] };
  return { kind: "choice", lines: candidates };
}
