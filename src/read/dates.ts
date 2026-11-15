const DAY = 86_400_000;

function iso(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const asDay = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) && iso(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8)) === s ? Date.parse(s) : NaN);

/** Numeric day-first dates only ("03/04/2026", "14.10.26 20:41"). Anything else gives null. */
export function parseWrittenDate(written: string): string | null {
  const m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(written);
  if (!m) return null;
  const y = +m[3];
  return iso(m[3].length === 2 ? 2000 + y : y, +m[2], +m[1]);
}

/** Always a plain YYYY-MM-DD day or null. The email date may be a full timestamp (postal-mime); only its day counts. */
export function chooseDate(a: { inputKind: "text" | "image"; typed: string | null; written: string | null; emailDate: string | null }): string | null {
  const typed = a.typed && !Number.isNaN(asDay(a.typed)) ? a.typed : null;
  const candidate = (a.inputKind === "text" && a.written ? parseWrittenDate(a.written) : null) ?? typed;
  const email = a.emailDate?.slice(0, 10) ?? "";
  const e = asDay(email);
  if (Number.isNaN(e)) return candidate;
  const c = candidate ? asDay(candidate) : NaN;
  if (Number.isNaN(c) || c > e || e - c > 365 * DAY) return email;
  return candidate;
}
