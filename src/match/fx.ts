import type { Env } from "../env";

const FX_URL = "https://api.frankfurter.dev/v1";

/** Pounds per one unit of `currency` on `day` (YYYY-MM-DD), or null if unavailable. Never throws. */
export async function rateToGbp(env: Env, day: string, currency: string): Promise<number | null> {
  const cur = currency.toUpperCase();
  if (cur === "GBP") return 1;
  if (!/^[A-Z]{3}$/.test(cur)) return null;
  try {
    const hit = await env.DB.prepare("SELECT to_gbp FROM rates WHERE day = ? AND currency = ?").bind(day, cur).first<{ to_gbp: number }>();
    if (hit) return hit.to_gbp;
    const res = await fetch(`${FX_URL}/${day}?base=${cur}&symbols=GBP`, { headers: { "User-Agent": "receipt-filer" } });
    if (res.status !== 200) return null;
    const rate = ((await res.json()) as { rates?: { GBP?: unknown } }).rates?.GBP;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
    // Stored under the requested day: Frankfurter answers a weekend with the earlier business day.
    await env.DB.prepare("INSERT OR REPLACE INTO rates (day, currency, to_gbp) VALUES (?, ?, ?)").bind(day, cur, rate).run();
    return rate;
  } catch {
    return null;
  }
}
